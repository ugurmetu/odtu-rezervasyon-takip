import { createHash } from 'node:crypto';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MAX_SLOTS = 200;
const MAX_OBSERVATION_AGE_MS = 5 * 60_000;
const MAX_FUTURE_SKEW_MS = 2 * 60_000;
// Two weekly calendars alternate behind one global one-minute request gate.
// Allow one 30-second alarm jitter on each visit, plus a small delivery margin.
const MAX_CONFIRMATION_GAP_MS = 210_000;
const RETURN_ABSENCE_MS = 10 * 60_000;
const RETURN_ABSENCE_READS = 3;
const ALGORITHM_VERSION = 2;

function validDate(value) {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validTime(value) {
  return typeof value === 'string' && TIME.test(value);
}

function eventKey(slot) {
  return `${slot.date}|${slot.start}|${slot.end}`;
}

export function normalizeSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || raw.schema !== 1 || raw.source !== 'rez-calendar-extension') {
    throw new Error('unsupported snapshot schema');
  }
  const allowedStates = new Set(['ok', 'no_tab', 'login_required', 'calendar_unavailable', 'paused']);
  if (!allowedStates.has(raw.state)) throw new Error('invalid snapshot state');
  const observedAt = new Date(raw.observed_at);
  if (Number.isNaN(observedAt.getTime())) throw new Error('invalid observation time');
  const age = Date.now() - observedAt.getTime();
  if (age > MAX_OBSERVATION_AGE_MS || age < -MAX_FUTURE_SKEW_MS) {
    throw new Error('stale or future observation time');
  }
  if (raw.state !== 'ok') return { state: raw.state, observedAt: observedAt.toISOString() };
  if (raw.fresh !== undefined && typeof raw.fresh !== 'boolean') throw new Error('invalid freshness flag');
  const fresh = raw.fresh === true;
  const refreshId = raw.refresh_id;
  if (fresh && (typeof refreshId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(refreshId))) {
    throw new Error('confirmed refresh id required');
  }
  if (!fresh && refreshId != null) throw new Error('passive snapshot cannot claim refresh id');
  const id = String(raw.facility?.id ?? '').trim();
  const label = String(raw.facility?.label ?? '').trim();
  const date = raw.view?.date;
  if (!/^\d{1,4}$/.test(id) || !label || label.length > 180) throw new Error('invalid facility');
  if (raw.view?.type !== 'day' || !validDate(date)) throw new Error('day and date required');
  if (!Array.isArray(raw.slots) || raw.slots.length > MAX_SLOTS) throw new Error('invalid slots');
  const seen = new Set();
  const slots = [];
  for (const candidate of raw.slots) {
    if (!candidate || candidate.date !== date || !validTime(candidate.start) || !validTime(candidate.end)) {
      throw new Error('invalid slot date or time');
    }
    const free = candidate.free;
    if (typeof free !== 'number' || !Number.isSafeInteger(free) || free < 0 || free > 10000) {
      throw new Error('invalid free count');
    }
    if (candidate.start >= candidate.end) throw new Error('invalid slot time range');
    const slot = { date, start: candidate.start, end: candidate.end, free };
    const key = eventKey(slot);
    if (seen.has(key)) throw new Error('duplicate slot');
    seen.add(key);
    slots.push(slot);
  }
  return { state: 'ok', observedAt: observedAt.toISOString(), facility: { id, label }, date, slots, fresh, refreshId: fresh ? refreshId : null };
}

export class SnapshotEngine {
  constructor(saved = {}) {
    // Version 1 accepted a single low count as a new baseline. Its persisted
    // pages could make the next normal count look like a vacancy after restart.
    // Rebaseline once; version 2 pages remain durable on later restarts.
    this.pages = saved.algorithmVersion === ALGORITHM_VERSION
      && saved.pages && typeof saved.pages === 'object' && !Array.isArray(saved.pages)
      ? saved.pages : {};
    this.health = saved.health && typeof saved.health === 'object' ? saved.health : {};
  }

  ingest(raw) {
    const snapshot = normalizeSnapshot(raw);
    if (snapshot.state !== 'ok') {
      // A failed site read, expired session, or missing tab breaks a pending
      // two-read confirmation. Keep the last stable count for the next visit.
      for (const page of Object.values(this.pages)) {
        page.emptyStreak = 0;
        for (const slot of Object.values(page.slots ?? {})) {
          slot.pending = null;
          slot.missingSince = null;
          slot.missingReads = 0;
        }
      }
      this.health.lastState = snapshot.state;
      this.health.lastSeenAt = snapshot.observedAt;
      return [];
    }
    const pageKey = `${snapshot.facility.id}|${snapshot.date}`;
    const previous = this.pages[pageKey];
    // Reading the same rendered DOM again is not a new server check. It can
    // update local health, but it must never establish a baseline or alert.
    if (!snapshot.fresh) {
      this.health.lastState = 'passive';
      this.health.lastSeenAt = snapshot.observedAt;
      this.health.lastFacility = snapshot.facility;
      return [];
    }
    if (previous?.lastRefreshId === snapshot.refreshId || previous?.recentRefreshIds?.includes(snapshot.refreshId)) return [];
    if (previous?.lastSuccessAt && snapshot.observedAt < previous.lastSuccessAt) {
      throw new Error('out-of-order observation');
    }
    if (previous?.lastSuccessAt
      && Date.parse(snapshot.observedAt) - Date.parse(previous.lastSuccessAt) > MAX_CONFIRMATION_GAP_MS) {
      previous.emptyStreak = 0;
      for (const slot of Object.values(previous.slots ?? {})) {
        slot.pending = null;
        slot.missingSince = null;
        slot.missingReads = 0;
      }
    }
    const recentRefreshIds = [...(previous?.recentRefreshIds ?? [previous?.lastRefreshId].filter(Boolean)).slice(-63), snapshot.refreshId];
    const currentKeys = new Set(snapshot.slots.map(eventKey));
    // A partial calendar may be the site's normal way of hiding unavailable
    // sessions. Track absence only while the same nonempty subset remains
    // visible; a mass return must still be treated as a new baseline.
    const priorVisible = previous?.observedSlotKeys ?? [];
    const newlyMissing = priorVisible.filter(key => !currentKeys.has(key));
    const stableVisibleSubset = priorVisible.length > 0
      && currentKeys.size === priorVisible.length
      && priorVisible.every(key => currentKeys.has(key));
    const subsetLoss = currentKeys.size > 0 && newlyMissing.length > 0
      && currentKeys.size < priorVisible.length
      && [...currentKeys].every(key => priorVisible.includes(key));
    const returnedKeys = [...currentKeys].filter(key => previous?.slots?.[key]
      && !priorVisible.includes(key));
    const isolatedReturn = returnedKeys.length === 1
      && currentKeys.size === priorVisible.length + 1
      && priorVisible.length > 0
      && priorVisible.every(key => currentKeys.has(key));
    const visibleSetDidNotShrink = currentKeys.size > 0 && priorVisible.length > 0
      && priorVisible.every(key => currentKeys.has(key));
    const confirmedSlots = Object.fromEntries(Object.entries(previous?.slots ?? {}).map(([key, value]) => {
      const confirmedFree = value.confirmedFree ?? value.pending?.previousFree ?? value.free;
      const absent = !currentKeys.has(key);
      const continuingAbsence = absent && visibleSetDidNotShrink
        && Number.isFinite(value.missingSince);
      // Existing saved pages from the earlier algorithm have no absence
      // clock after a mass omission. Begin a fresh clock when a partial set
      // remains stable, rather than requiring another visible slot to vanish.
      const startingAbsence = absent && (
        (subsetLoss && priorVisible.includes(key)) || stableVisibleSubset);
      return [key, { free: confirmedFree, confirmedFree, pending: null,
        missingSince: continuingAbsence ? value.missingSince
          : startingAbsence ? Date.parse(snapshot.observedAt) : null,
        missingReads: continuingAbsence ? (value.missingReads ?? 0) + 1
          : startingAbsence ? 1 : 0 }];
    }));
    // An empty event list can mean a genuinely full calendar or a temporary
    // incomplete response. It is not proof that previously seen slots reached
    // zero. Preserve their last confirmed counts and cancel pending changes.
    if (snapshot.slots.length === 0) {
      const emptyStreak = Math.min((previous?.emptyStreak ?? 0) + 1, 2);
      const hasReliableBaseline = previous?.baselineConfirmed !== false
        && Object.keys(confirmedSlots).length > 0;
      this.pages[pageKey] = {
        facility: snapshot.facility,
        date: snapshot.date,
        lastSuccessAt: snapshot.observedAt,
        lastRefreshId: snapshot.refreshId,
        recentRefreshIds,
        baselineConfirmed: hasReliableBaseline,
        emptyStreak,
        observedSlotKeys: [],
        slots: confirmedSlots
      };
      this.health.lastState = 'empty_unconfirmed';
      this.health.lastSeenAt = snapshot.observedAt;
      this.health.lastFacility = snapshot.facility;
      return [];
    }
    const hasReliableBaseline = !!previous && previous.baselineConfirmed !== false
      && Object.keys(previous.slots ?? {}).length > 0;
    const next = {
      facility: snapshot.facility,
      date: snapshot.date,
      lastSuccessAt: snapshot.observedAt,
      lastRefreshId: snapshot.refreshId,
      recentRefreshIds,
      baselineConfirmed: true,
      emptyStreak: 0,
      // Retained baseline slots may be absent from a partial response. Keep
      // comparison history, but expose only slots actually seen this time as
      // current choices in the bot.
      observedSlotKeys: snapshot.slots.map(eventKey),
      // A partially rendered calendar must not make an unchanged slot look
      // newly available later. Keep the last confirmed count and cancel any
      // pending confirmation because the observations were not consecutive.
      slots: hasReliableBaseline ? confirmedSlots : {}
    };
    const events = [];
    for (const slot of snapshot.slots) {
      const key = eventKey(slot);
      // A session missing from a nonempty fresh response was not continuously
      // observed. Its return establishes a new baseline, even if an older
      // count was retained for diagnostics. An entirely empty response is
      // separately classified as unconfirmed and does not erase baselines.
      const continuouslyObserved = !Array.isArray(previous?.observedSlotKeys)
        || previous.emptyStreak > 0 || previous.observedSlotKeys.includes(key);
      const prior = hasReliableBaseline && continuouslyObserved ? previous.slots?.[key] : null;
      const returning = hasReliableBaseline && !continuouslyObserved && isolatedReturn
        && (previous.slots?.[key]?.missingReads ?? 0) >= RETURN_ABSENCE_READS
        && Date.parse(snapshot.observedAt) - previous.slots[key].missingSince >= RETURN_ABSENCE_MS;
      // A session absent from earlier responses may have been omitted by a
      // partial calendar. Its first appearance is a baseline, not proof that
      // zero places became available.
      const baseline = prior
        ? (prior.confirmedFree ?? prior.pending?.previousFree ?? prior.free)
        : slot.free;
      let pending = null;
      let confirmedFree = baseline;
      if (prior?.pending?.direction === 'reappeared'
        && Number.isSafeInteger(prior.pending.previousFree)
        && slot.free > prior.pending.previousFree
        && slot.free >= prior.pending.targetFree && stableVisibleSubset) {
        const event = { kind: 'reappeared', facility: snapshot.facility,
          ...slot, previousFree: prior.pending.previousFree, observedAt: snapshot.observedAt };
        event.id = createHash('sha256').update(`${pageKey}|${key}|return|${slot.free}|${snapshot.observedAt}`).digest('hex').slice(0, 24);
        events.push(event);
        confirmedFree = slot.free;
      } else if (returning && slot.free > (previous.slots[key].confirmedFree ?? previous.slots[key].free)) {
        // A disappearing positive slot returning at the same (or a lower)
        // count is not evidence of a newly freed place. The site sometimes
        // omits previously available sessions from otherwise fresh calendars.
        pending = { direction: 'reappeared',
          previousFree: previous.slots[key].confirmedFree ?? previous.slots[key].free,
          targetFree: slot.free };
      } else if (hasReliableBaseline && prior && slot.free > baseline) {
        if (prior.pending && prior.pending.direction !== 'down'
          && slot.free >= prior.pending.targetFree) {
          const event = {
            facility: snapshot.facility,
            ...slot,
            previousFree: baseline,
            observedAt: snapshot.observedAt
          };
          event.id = createHash('sha256').update(`${pageKey}|${key}|${slot.free}|${snapshot.observedAt}`).digest('hex').slice(0, 24);
          events.push(event);
          confirmedFree = slot.free;
        } else {
          pending = { previousFree: baseline, targetFree: slot.free };
        }
      } else if (hasReliableBaseline && prior && slot.free < baseline) {
        // One unexpectedly low count could be a transient site response. If
        // accepted immediately, its return to normal would look like a new
        // vacancy after the two upward reads. Confirm the lower count too.
        if (prior.pending?.direction === 'down' && slot.free === prior.pending.targetFree) {
          confirmedFree = slot.free;
        } else {
          pending = { direction: 'down', previousFree: baseline, targetFree: slot.free };
        }
      } else {
        confirmedFree = slot.free;
      }
      next.slots[key] = { free: slot.free, confirmedFree, pending,
        missingSince: null, missingReads: 0 };
    }
    this.pages[pageKey] = next;
    this.health.lastState = 'ok';
    this.health.lastSeenAt = snapshot.observedAt;
    this.health.lastFacility = snapshot.facility;
    return events;
  }

  export() {
    return { algorithmVersion: ALGORITHM_VERSION, pages: this.pages, health: this.health };
  }
}

export function subscriptionMatches(subscription, event) {
  if (!subscription || subscription.active === false) return false;
  if (String(subscription.facilityId) !== event.facility.id) return false;
  if (subscription.date && subscription.date !== event.date) return false;
  if (subscription.exactTime) {
    // A chosen session is identified by its start. Its end may differ from an
    // estimated time in the menu, so up to 30 minutes of difference matches.
    const minutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
    return subscription.startAfter === event.start && TIME.test(event.end || '') && TIME.test(subscription.endBefore || '')
      && Math.abs(minutes(event.end) - minutes(subscription.endBefore)) <= 30;
  }
  if (subscription.startAfter && event.start < subscription.startAfter) return false;
  if (subscription.endBefore && event.end > subscription.endBefore) return false;
  return true;
}
