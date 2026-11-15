import {isPublicationWait} from './publication-wait.mjs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import {scheduleFreshMs} from './reader-facilities.mjs';
import {isLanguage} from './i18n.mjs';
import {rememberSlotAlert,observeSlotAlerts,pruneSlotAlerts,recoverSlotAlerts,slotAlertKey} from './slot-alerts.mjs';
import { SnapshotEngine, normalizeSnapshot, subscriptionMatches } from './core.mjs';

const EMPTY = () => ({ version: 1, engine: {}, subscriptions: [], outbox: [], telegramOffset: 0, facilityCatalog: [], betaApprovedChatIds: [] });
const OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60_000;
// A vacancy can disappear quickly. Never replay an old alert after a network
// outage or a restart and present it as current availability.
const AVAILABILITY_DELIVERY_MAX_AGE_MS = 5 * 60_000;
// A fast alert to many watchers of one session takes time at Telegram's pace
// (3000 chats at 25/s ≈ 2 minutes). A late one is followed by "Doldu" anyway.
const FAST_DELIVERY_MAX_AGE_MS = 3 * 60_000;
const TEST_COOLDOWN_MS = 60_000;
const BETA_HINT_COOLDOWN_MS = 5 * 60_000;
const MENU_REPLY_WINDOW_MS = 10_000;
const MAX_MENU_REPLIES_PER_WINDOW = 12;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const ISTANBUL_CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
const SAFE_DIAGNOSTICS = new Set([
  'rate_limited', 'calendar_unavailable', 'timeout', 'ambiguous_request',
  'schedule_render_failed', 'unverified_response', 'no_schedule_request',
  'refresh_failed', 'parse_failed', 'unexpected_page', 'login_form_present',
  'primefaces_unavailable', 'schedule_widget_missing', 'schedule_widget_unusable',
  'calendar_view_unavailable', 'not_day_view', 'calendar_date_unavailable',
  'calendar_date_expired',
  'calendar_date_mismatch', 'calendar_day_advanced', 'calendar_day_advance_failed',
  'facility_not_selected', 'tab_query_failed',
  'content_no_response', 'invalid_capture_payload', 'content_timeout',
  'content_unreachable', 'site_access_denied', 'site_rate_limited',
  'unknown_facility'
]);

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function sessionHasEnded(event, now = Date.now()) {
  if (!validDate(event?.date) || !TIME.test(event?.end || '')) return false;
  const parts = Object.fromEntries(ISTANBUL_CLOCK.formatToParts(new Date(now))
    .filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const currentTime = `${parts.hour}:${parts.minute}`;
  return event.date < today || (event.date === today && event.end <= currentTime);
}

export function sessionRegistrationClosed(event, unit = '', now = Date.now()) {
  if (sessionHasEnded(event, now)) return true;
  // Both the Sports and Pool Directorates publish a one-hour booking window
  // after the session starts. Other units need their own documented rule.
  if (!['Spor Müdürlüğü', 'Havuz Müdürlüğü'].includes(unit) || !validDate(event?.date)
    || !TIME.test(event?.start || '')) return false;
  const parts = Object.fromEntries(ISTANBUL_CLOCK.formatToParts(new Date(now))
    .filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  if (event.date !== today) return false;
  const [startHour, startMinute] = event.start.split(':').map(Number);
  const currentMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  return currentMinutes >= startHour * 60 + startMinute + 60;
}

export function sessionCoverage(page, now = Date.now(), unit = '') {
  const slots = page?.slots ?? {};
  const relevantKeys = Object.keys(slots).filter(key => {
    const [date, start, end] = key.split('|');
    return !sessionRegistrationClosed({ date, start, end }, unit, now);
  });
  const seen = new Set(Array.isArray(page?.observedSlotKeys)
    ? page.observedSlotKeys : Object.keys(slots));
  const observedSessions = relevantKeys.filter(key => seen.has(key)).length;
  return { observedSessions, recordedSessions: relevantKeys.length,
    intermittent: observedSessions < relevantKeys.length };
}

export function sanitizeReaderDiagnostic(value) {
  if(value?.schema!==1||!/^\d{1,4}$/.test(value.facilityId||'')||!validDate(value.date))return null;
  const days=a=>Array.isArray(a)?a.filter(validDate).slice(0,7):[];
  const stamp=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T[0-9:+.Z-]{5,60}$/.test(v)?v:'invalid_format';
  return {schema:1,facilityId:value.facilityId,date:value.date,dates:days(value.dates),
    clippedDate:validDate(value.clippedDate)?value.clippedDate:null,domDates:days(value.domDates),
    events:(Array.isArray(value.events)?value.events:[]).slice(0,50).map(e=>({
      start:stamp(e?.start),end:stamp(e?.end),allDay:e?.allDay===true,
      free:/^\d{1,5}$/.test(String(e?.free??''))?Number(e.free):null}))};
}

export class LocalStore {
  constructor(file, { betaInviteCode = '', betaMaxChats = 6, accessMode = 'invite', publicMaxChats = 5000 } = {}) {
    if (betaInviteCode && !/^[A-Za-z0-9_-]{16,64}$/.test(betaInviteCode)) {
      throw new Error('invalid beta invite code');
    }
    if (!Number.isInteger(betaMaxChats) || betaMaxChats < 1 || betaMaxChats > 6) {
      throw new Error('invalid beta chat limit');
    }
    if (!['invite','public'].includes(accessMode)) throw new Error('invalid access mode');
    if (!Number.isInteger(publicMaxChats) || publicMaxChats < 1 || publicMaxChats > 10000) throw new Error('invalid public chat limit');
    this.accessMode = accessMode;
    this.publicMaxChats = publicMaxChats;
    this.file = file;
    this.betaInviteCode = betaInviteCode;
    this.betaMaxChats = betaMaxChats;
    this.lastTestAt = new Map();
    this.lastBetaHintAt = new Map();
    this.menuReplyAt = new Map();
    this.menuReplyBlockedUntil = new Map();
    try { this.state = JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = EMPTY();
    }
    if (this.state.version !== 1 || !Array.isArray(this.state.subscriptions) || !Array.isArray(this.state.outbox)) {
      throw new Error('unsupported state file');
    }
    // A queued alert loaded after a process restart may no longer be true.
    // Hold it until a newer fresh site reading confirms the same session.
    // Alerts created by this process are based on its own fresh reading.
    this.restartHeldDeliveryIds = new Set(this.state.outbox.filter(item =>
      item.status === 'queued' && Number.isFinite(Date.parse(item.event?.observedAt || ''))
      && item.event?.facility?.id && validDate(item.event?.date)
      && TIME.test(item.event?.start || '') && TIME.test(item.event?.end || '')
    ).map(item => item.id));
    if (!Array.isArray(this.state.betaApprovedChatIds)) this.state.betaApprovedChatIds = [];
    if(this.state.chatLanguages){
      const entries=typeof this.state.chatLanguages==='object'&&!Array.isArray(this.state.chatLanguages)?Object.entries(this.state.chatLanguages):[];
      this.state.chatLanguages=Object.fromEntries(entries.filter(([id,value])=>this.isChatAllowed(id)&&isLanguage(value)));
    }
    this.engine = new SnapshotEngine(this.state.engine);
    this.canonicalizeObservedFacilityNames();
    // Only explicit invite approvals are authoritative. Legacy subscriptions
    // cannot silently admit a chat or bypass the closed-beta capacity limit.
    // Runtime-only health: never persist Telegram identifiers or credentials in diagnostics.
    this.telegramHealth = {
      configured: false,
      startedAt: new Date().toISOString(),
      lastPollAt: null,
      lastReplyAt: null,
      lastTestDeliveryAt: null,
      lastAvailabilityDeliveryAt: null,
      lastErrorAt: null,
      lastError: null
    };
    // The previous process may have sent these alerts before losing the API
    // response or crashing. Do not silently replay an indeterminate send.
    const interrupted = this.state.outbox.filter(item => item.status === 'sending');
    if (interrupted.length) {
      const recoveredAt = new Date().toISOString();
      for (const item of interrupted) {
        item.status = 'uncertain';
        item.uncertainAt = recoveredAt;
        item.reason = 'send_result_unknown_after_restart';
        delete item.event;
      }
      this.save();
    }
    if(recoverSlotAlerts(this))this.save();
    // Retired public week notices must not survive a service restart. This
    // does not touch session subscriptions, availability jobs or languages.
    if (this.state.broadcast) { this.state.broadcast = null; this.save(); }
  }

  isSlotClosed(alert,now=Date.now()){return sessionRegistrationClosed(alert,this.catalogFacility(alert.facilityId)?.unit,now);}
  isSlotWatched(alert){return this.catalogFacility(alert.facilityId)?.enabled!==false&&this.isChatAllowed(alert.chatId)&&this.subscriptionsFor(alert.chatId).some(s=>subscriptionMatches(s,{facility:{id:alert.facilityId},date:alert.date,start:alert.start,end:alert.end}));}

  setTelegramConfigured(configured) {
    this.telegramHealth.configured = Boolean(configured);
  }

  isChatAllowed(chatId) {
    return (this.accessMode === 'public' || Boolean(this.betaInviteCode))
      && this.state.betaApprovedChatIds.includes(String(chatId));
  }

  languageFor(chatId) {
    return this.state.chatLanguages?.[String(chatId)]==='en'?'en':'tr';
  }

  setLanguage(chatId, value) {
    if(!this.isChatAllowed(chatId)||!isLanguage(value))return false;
    this.state.chatLanguages||={};
    if(this.languageFor(chatId)!==value){this.state.chatLanguages[String(chatId)]=value;this.save();}
    return true;
  }

  admitChat(chatId, code) {
    if (this.accessMode !== 'public') return this.approveBetaChat(chatId, code);
    if (!/^\d{1,16}$/.test(String(chatId)) || !Number.isSafeInteger(Number(chatId)) || Number(chatId) < 1) return 'invalid';
    const id = String(chatId);
    if (this.state.betaApprovedChatIds.includes(id)) return 'approved';
    if (this.state.betaApprovedChatIds.length >= this.publicMaxChats) return 'full';
    // Opt-in private /start only. Public admission grants no reader/admin access.
    this.state.betaApprovedChatIds.push(id);this.noteUserStat('joined');this.save();return 'approved';
  }

  // Owner statistics are daily counters only (how many joined or left); no
  // per-person record is kept for them.
  noteUserStat(kind,now=Date.now()){
    const days=(this.state.userStats??={days:{}}).days;
    const day=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Istanbul'}).format(new Date(now));
    const entry=days[day]??={joined:0,left:0};entry[kind]+=1;
    for(const old of Object.keys(days).sort().slice(0,-90))delete days[old];
  }

  forgetChat(chatId) {
    const id=String(chatId);
    if(this.state.betaApprovedChatIds.includes(id))this.noteUserStat('left');
    this.state.subscriptions=this.state.subscriptions.filter(s=>s.chatId!==id);
    this.state.outbox=this.state.outbox.filter(s=>s.chatId!==id);
    this.state.betaApprovedChatIds=this.state.betaApprovedChatIds.filter(x=>x!==id);
    if(this.state.chatLanguages)delete this.state.chatLanguages[id];
    if(this.state.siteLinks)delete this.state.siteLinks[id];
    if(this.state.selectionDrafts)delete this.state.selectionDrafts[id];
    for(const [key,a] of Object.entries(this.state.slotAlerts||{}))if(a.chatId===id){delete this.state.slotAlerts[key];if(this.state.slotStatusJobs)delete this.state.slotStatusJobs[key];}
    for(const map of [this.lastTestAt,this.lastBetaHintAt,this.menuReplyAt,this.menuReplyBlockedUntil])map.delete(id);
    this.save();
  }

  approveBetaChat(chatId, receivedCode) {
    if (!this.betaInviteCode || typeof receivedCode !== 'string' || !/^\d{1,20}$/.test(String(chatId))) return 'invalid';
    const received = Buffer.from(receivedCode);
    const expected = Buffer.from(this.betaInviteCode);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return 'invalid';
    if (this.state.betaApprovedChatIds.includes(String(chatId))) return 'approved';
    if (this.state.betaApprovedChatIds.length >= this.betaMaxChats) return 'full';
    this.state.betaApprovedChatIds.push(String(chatId));
    this.save();
    return 'approved';
  }

  canSendTest(chatId, now = Date.now()) {
    const key = String(chatId);
    const last = this.lastTestAt.get(key);
    if (last !== undefined && now - last < TEST_COOLDOWN_MS) return false;
    this.lastTestAt.set(key, now);
    if (this.lastTestAt.size > 500) {
      for (const [id, at] of this.lastTestAt) if (now - at > TEST_COOLDOWN_MS) this.lastTestAt.delete(id);
    }
    return true;
  }

  canSendBetaHint(chatId, now = Date.now()) {
    const key = String(chatId);
    const last = this.lastBetaHintAt.get(key);
    if (last !== undefined && now - last < BETA_HINT_COOLDOWN_MS) return false;
    this.lastBetaHintAt.set(key, now);
    if (this.lastBetaHintAt.size > 500) {
      for (const [id, at] of this.lastBetaHintAt) if (now - at > BETA_HINT_COOLDOWN_MS) this.lastBetaHintAt.delete(id);
    }
    return true;
  }

  canSendMenuReply(chatId, now = Date.now()) {
    const key = String(chatId);
    const blockedUntil = this.menuReplyBlockedUntil.get(key) ?? 0;
    if (blockedUntil > now) return false;
    if (blockedUntil) this.menuReplyBlockedUntil.delete(key);
    const recent = (this.menuReplyAt.get(key) ?? []).filter(at => now - at < MENU_REPLY_WINDOW_MS);
    if (recent.length >= MAX_MENU_REPLIES_PER_WINDOW) return false;
    recent.push(now);
    this.menuReplyAt.set(key, recent);
    if (this.menuReplyAt.size > 500) {
      for (const [id, times] of this.menuReplyAt) {
        if (times.every(at => now - at >= MENU_REPLY_WINDOW_MS)) this.menuReplyAt.delete(id);
      }
    }
    return true;
  }

  deferMenuReply(chatId, retryAfterMs, now = Date.now()) {
    const delayMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? Math.min(retryAfterMs, 60_000) : 5_000;
    this.menuReplyBlockedUntil.set(String(chatId), now + delayMs);
    if (this.menuReplyBlockedUntil.size > 500) {
      for (const [id, until] of this.menuReplyBlockedUntil) {
        if (until <= now) this.menuReplyBlockedUntil.delete(id);
      }
    }
  }

  noteTelegramPoll() {
    this.telegramHealth.lastPollAt = new Date().toISOString();
    this.telegramHealth.lastErrorAt = null;
    this.telegramHealth.lastError = null;
  }

  noteTelegramReply() {
    this.telegramHealth.lastReplyAt = new Date().toISOString();
  }

  noteTelegramTestDelivery() {
    this.telegramHealth.lastTestDeliveryAt = new Date().toISOString();
  }

  noteTelegramAvailabilityDelivery() {
    this.telegramHealth.lastAvailabilityDeliveryAt = new Date().toISOString();
  }

  noteTelegramError(status) {
    this.telegramHealth.lastErrorAt = new Date().toISOString();
    this.telegramHealth.lastError = Number.isInteger(status) && status >= 100 && status <= 599
      ? `http_${status}` : 'network';
  }

  save() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.lastSavedAt = Date.now();
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    this.state.engine = this.engine.export();
    pruneSlotAlerts(this);
    this.expireStaleDeliveries();
    const cutoff = Date.now() - OUTBOX_RETENTION_MS;
    this.state.outbox = this.state.outbox.filter(item => {
      if (item.status === 'queued' || item.status === 'sending') return true;
      const finishedAt = Date.parse(item.sentAt || item.failedAt || item.cancelledAt || item.uncertainAt || '');
      return Number.isFinite(finishedAt) && finishedAt >= cutoff;
    });
    const temporary = `${this.file}.${randomBytes(4).toString('hex')}.tmp`;
    // Compact: the file is rewritten often and grows with every chat.
    writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.file);
  }

  // A routine reading only refreshes comparison history, yet the whole file
  // (several MB with thousands of chats) was rewritten for every day of every
  // reading, ~10 times a second. With saveThrottleMs > 0 (the server sets it)
  // such writes are coalesced; queued alerts, status jobs and a week notice
  // are still written at once, and shutdown flushes what is pending.
  saveSoon() {
    if (!(this.saveThrottleMs > 0)) return this.save();
    const wait = (this.lastSavedAt || 0) + this.saveThrottleMs - Date.now();
    if (wait <= 0) return this.save();
    if (!this.saveTimer) { this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, wait); this.saveTimer.unref?.(); }
  }
  flushSave() { if (this.saveTimer) this.save(); }

  recordReadStats(value) {
    const count = (n, max) => Number.isSafeInteger(n) && n >= 0 ? Math.min(n, max) : 0;
    const sample = { at: Date.now(), reused: value?.reused === true, weekDefault: value?.weekDefault === true,
      selectionVerified: typeof value?.selectionVerified === 'boolean' ? value.selectionVerified : null,
      actions: count(value?.actions, 10), ms: count(value?.ms, 120000),
      requests: { unit: count(value?.requests?.unit, 10), facility: count(value?.requests?.facility, 10), schedule: count(value?.requests?.schedule, 10) },
      events: count(value?.events, 1000), otherEvents: count(value?.otherEvents, 1000),
      otherTitles: (Array.isArray(value?.otherTitles) ? value.otherTitles : []).filter(t => typeof t === 'string' && t.length <= 40 && !/[@<>]/.test(t)).slice(0, 5) };
    (this.readStats ||= []).push(sample);
    if (this.readStats.length > 200) this.readStats.splice(0, this.readStats.length - 200);
  }

  readStatsSummary(now = Date.now()) {
    const recent = (this.readStats || []).filter(item => now - item.at < 15 * 60_000);
    if (!recent.length) return null;
    const mean = key => Math.round(recent.reduce((sum, item) => sum + item[key], 0) / recent.length * 100) / 100;
    const requests = kind => Math.round(recent.reduce((sum, item) => sum + item.requests[kind], 0) / recent.length * 100) / 100;
    return { samples: recent.length, reused: recent.filter(item => item.reused).length,
      weekDefault: recent.filter(item => item.weekDefault).length,
      selectionVerified: recent.filter(item => item.selectionVerified === true).length,
      selectionUnverified: recent.filter(item => item.selectionVerified === false).length,
      avgActions: mean('actions'), avgMs: mean('ms'), maxMs: Math.max(...recent.map(item => item.ms)),
      avgRequests: { unit: requests('unit'), facility: requests('facility'), schedule: requests('schedule') },
      events: recent.reduce((sum, item) => sum + (item.events || 0), 0), otherEvents: recent.reduce((sum, item) => sum + (item.otherEvents || 0), 0),
      otherTitles: [...new Set(recent.flatMap(item => item.otherTitles || []))].slice(0, 10) };
  }

  ingest(snapshot) {
    const durable = () => [this.state.outbox.length, this.state.outbox.filter(item => item.status === 'queued').length,
      Object.values(this.state.slotStatusJobs || {}).reduce((n, job) => n + (job.revision || 0) + 1, 0), this.state.broadcast?.id || ''].join('|');
    const before = durable();
    const normalized = normalizeSnapshot(snapshot);
    if(snapshot.state==='calendar_unavailable'&&snapshot.detail==='parse_failed'){
      const diagnostic=sanitizeReaderDiagnostic(snapshot.readerDiagnostic);
      if(diagnostic){this.state.readerDiagnostics||={};this.state.readerDiagnostics[diagnostic.facilityId]={...diagnostic,at:normalized.observedAt};}
    }
    const catalogEntry = normalized.state === 'ok'
      ? this.catalogFacility(normalized.facility.id) : null;
    if (normalized.state === 'ok' && !catalogEntry) {
      // A page observation is never allowed to add a new facility to the
      // curated menu or create an alert before catalog import.
      this.engine.ingest({ schema: 1, source: 'rez-calendar-extension',
        state: 'calendar_unavailable', observed_at: normalized.observedAt });
      this.cancelUnverifiedDeliveries({ state: 'calendar_unavailable',
        observedAt: normalized.observedAt });
      this.state.lastDiagnostic = 'unknown_facility';
      this.save();
      return [];
    }
    const trustedSnapshot = catalogEntry
      ? { ...snapshot, facility: { id: catalogEntry.id, label: catalogEntry.label } }
      : snapshot;
    const events = this.engine.ingest(trustedSnapshot);
    this.cancelUnverifiedDeliveries(normalized);
    this.state.lastDiagnostic = snapshot?.state === 'calendar_unavailable'
      && SAFE_DIAGNOSTICS.has(snapshot.detail) ? snapshot.detail : null;
    for (const event of events) {
      if (catalogEntry?.enabled===false||sessionRegistrationClosed(event, catalogEntry?.unit)) continue;
      for (const subscription of this.state.subscriptions) {
        if (!this.isChatAllowed(subscription.chatId) || !subscriptionMatches(subscription, event)) continue;
        if (subscription.notifyAvailable === true) continue;
        const id = createHash('sha256').update(`${event.id}|${subscription.chatId}`).digest('hex').slice(0, 32);
        if (this.state.outbox.some(item => item.id === id)) continue;
        this.state.outbox.push({ id, chatId: subscription.chatId, event, attempts: 0, nextAt: Date.now(), status: 'queued' });
      }
    }
    // Personal dated watches care about a confirmed available session, not
    // proof that a capacity count increased. They also work when a formerly
    // empty calendar first starts publishing a matching session.
    this.queueAvailableWatches(normalized, catalogEntry);
    if (catalogEntry) {
      this.learnPublishedWeek(normalized);
      this.learnCalendarChanges(normalized);
    }
    observeSlotAlerts(this,normalized);
    if (durable() !== before) this.save(); else this.saveSoon();
    return events;
  }

  queueAvailableWatches(observation, catalogEntry) {
    // Random order per reading: with many watchers, the same people are not
    // always the first to hear about a place.
    const order = this.state.subscriptions.slice();
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    const queuedIds = new Set(this.state.outbox.map(item => item.id));
    const knownAvailability=new Map();
    for(const item of this.state.outbox){
      if(!['queued','sending','sent','uncertain'].includes(item.status))continue;
      const key=item.availabilityKey||(item.event?.kind==='available'?slotAlertKey({chatId:item.chatId,facilityId:item.event.facility.id,...item.event}):null);
      if(key)knownAvailability.set(key,item.id);
    }
    for (const subscription of order) {
      if (subscription.notifyAvailable !== true || !this.isChatAllowed(subscription.chatId)) continue;
      const checks = subscription.availabilityChecks ??= {};
      const fresh = observation.state === 'ok' && observation.fresh === true;
      if (!fresh) {
        for (const check of Object.values(checks)) delete check.candidate;
        continue;
      }
      if (subscription.facilityId !== observation.facility.id || subscription.date !== observation.date) continue;
      const now = Date.parse(observation.observedAt);
      const eligible = observation.slots.filter(slot => slot.free > 0
        && subscriptionMatches(subscription, {...slot, facility:observation.facility})
        && !sessionRegistrationClosed(slot, catalogEntry?.unit));
      const keys = new Set(eligible.map(slot => `${slot.start}|${slot.end}`));
      for (const [key, check] of Object.entries(checks)) if (!keys.has(key)) delete check.candidate;
      for (const slot of eligible) {
        const key = `${slot.start}|${slot.end}`;
        const check = checks[key] ??= {};
        const availabilityKey=slotAlertKey({chatId:subscription.chatId,facilityId:subscription.facilityId,...slot});
        // Delivery belongs to one chat/session lifecycle, not to an editable
        // filter. A range split or re-selection must not race its reopened job.
        if(this.state.slotAlerts?.[availabilityKey]){delete check.candidate;continue;}
        if(knownAvailability.has(availabilityKey)){check.queuedId=knownAvailability.get(availabilityKey);delete check.candidate;continue;}
        if (check.queuedId) {
          const prior = this.state.outbox.find(item => item.id === check.queuedId);
          if (prior && !['cancelled','failed','expired'].includes(prior.status)) continue;
          delete check.queuedId;
        }
        const candidate = check.candidate;
        const fast=this.state.fastAvailability===true;
        // Fast watches use the first verified positive response. Do not
        // replay a delayed local upload as if it were a current opportunity.
        if(fast&&Date.now()-now>10_000)continue;
        if (candidate?.refreshId === observation.refreshId) continue;
        if (!fast&&(!candidate || now <= candidate.at || now - candidate.at > 210_000)) {
          check.candidate = {at:now, refreshId:observation.refreshId};
          continue;
        }
        const event = {kind:'available',facility:{id:catalogEntry.id,label:catalogEntry.label},
          ...slot, observedAt:observation.observedAt};
        event.id = createHash('sha256').update(`${subscription.facilityId}|${subscription.date}|${key}|available|${candidate?.at??now}`)
          .digest('hex').slice(0,24);
        const id = createHash('sha256').update(`${event.id}|${subscription.chatId}`).digest('hex').slice(0,32);
        if (!queuedIds.has(id)) queuedIds.add(id), this.state.outbox.push({id, chatId:subscription.chatId,availabilityKey,
          event, ...(fast?{maxAgeMs:FAST_DELIVERY_MAX_AGE_MS}:{}),attempts:0, nextAt:Date.now(), status:'queued'});
        check.queuedId = id;
        knownAvailability.set(availabilityKey,id);
        delete check.candidate;
      }
    }
  }

  cancelUnverifiedDeliveries(observation) {
    const fresh = observation.state === 'ok' && observation.fresh === true;
    if (!fresh && observation.state === 'ok') return 0;
    const seenAt = Date.parse(observation.observedAt);
    const visible = fresh ? new Map(observation.slots.map(slot =>
      [`${slot.date}|${slot.start}|${slot.end}`, slot.free])) : null;
    let cancelled = 0;
    for (const item of this.state.outbox) {
      if (item.status !== 'queued') continue;
      const event = item.event;
      const eventAt = Date.parse(event?.observedAt || '');
      if (!Number.isFinite(eventAt) || eventAt > seenAt) continue;
      if (fresh) {
        if (String(event?.facility?.id) !== observation.facility.id
          || event.date !== observation.date) continue;
        const currentFree = visible.get(`${event.date}|${event.start}|${event.end}`);
        if (currentFree !== undefined && currentFree >= event.free) {
          this.restartHeldDeliveryIds.delete(item.id);
          continue;
        }
      }
      item.status = 'cancelled';
      item.cancelledAt = observation.observedAt;
      item.reason = fresh ? 'availability_no_longer_confirmed' : 'calendar_unverified';
      delete item.event;
      this.restartHeldDeliveryIds.delete(item.id);
      cancelled++;
    }
    return cancelled;
  }

  setFacilityCatalog(entries) {
    if (!Array.isArray(entries) || entries.length > 200) throw new Error('invalid facility catalog');
    const ids = new Set();
    const catalog = entries.map(item => {
      const id = String(item?.id ?? '').trim();
      const label = String(item?.label ?? '').trim();
      const unit = String(item?.unit ?? '').trim();
      const unitId=item?.unitId===undefined?undefined:String(item.unitId);
      if(unitId!==undefined&&!/^\d{1,4}$/.test(unitId))throw new Error('invalid unit id');
      if (!/^\d{1,4}$/.test(id) || !label || label.length > 180 || !unit || unit.length > 100 || ids.has(id)) {
        throw new Error('invalid facility catalog entry');
      }
      ids.add(id);
      return { id, label, unit,...(unitId?{unitId}:{}),...(item.enabled===false?{enabled:false}:{}) };
    });
    this.state.facilityCatalog = catalog;
    this.canonicalizeObservedFacilityNames();
    this.save();
  }

  mergeDiscoveredCatalog({facilities,units=[],complete=false,unitId=null}) {
    if(!Array.isArray(facilities)||facilities.length>200||!Array.isArray(units)||units.length>30)throw new Error('invalid discovery');
    // Validate the complete candidate before touching the live registry.
    const old=this.state.facilityCatalog;
    const incoming=facilities.map(f=>({...f,id:String(f.id),...(f.unitId!==undefined?{unitId:String(f.unitId)}:{})}));
    if(incoming.some(f=>!/^\d{1,4}$/.test(String(f.id))||typeof f.label!=='string'||!f.label.trim()||f.label.length>180||typeof f.unit!=='string'||!f.unit.trim()||f.unit.length>100||f.unitId!==undefined&&!/^\d{1,4}$/.test(String(f.unitId)))||new Set(incoming.map(f=>f.id)).size!==incoming.length)throw new Error('invalid discovered facility');
    if(units.some(u=>!/^\d{1,4}$/.test(String(u.id))||typeof u.label!=='string'||!u.label.trim()||u.label.length>100)||new Set(units.map(u=>String(u.id))).size!==units.length)throw new Error('invalid discovered unit');
    const seen=new Set(incoming.map(f=>f.id));
    const retained=old.filter(f=>!seen.has(f.id)).map(f=>complete===true&&(unitId===null||f.unitId===String(unitId))?{...f,enabled:false}:f);
    const merged=[...retained,...incoming];if(merged.length>200)throw new Error('catalog capacity exceeded');
    this.setFacilityCatalog(merged);
    this.state.unitCatalog=[...(this.state.unitCatalog||[]).filter(u=>!units.some(v=>String(v.id)===String(u.id))),...units.map(u=>({id:String(u.id),label:u.label}))];
    this.state.catalogDiscoveredAt=new Date().toISOString();this.save();
  }

  canonicalizeObservedFacilityNames() {
    // Replace any older page-derived names already present in persisted state.
    for (const page of Object.values(this.engine.pages)) {
      const entry = this.catalogFacility(page?.facility?.id);
      if (entry) page.facility = { id: entry.id, label: entry.label };
    }
    const last = this.catalogFacility(this.engine.health.lastFacility?.id);
    if (last) this.engine.health.lastFacility = { id: last.id, label: last.label };
  }

  catalogFacility(id) {
    return this.state.facilityCatalog?.find(item => item.id === String(id)) ?? null;
  }

  availableFacilities() {
    const observedIds = new Set(Object.values(this.engine.pages).map(page => String(page?.facility?.id)));
    return (this.state.facilityCatalog ?? []).map(item => ({ ...item, observed: observedIds.has(item.id) }))
      .sort((a, b) => a.unit.localeCompare(b.unit, 'tr') || a.label.localeCompare(b.label, 'tr'));
  }

  // Session definitions are separate from vacancy observations. Only dated
  // lists are accepted; never reuse another day/week's hours. Checked on
  // 28 Oct 2026: the official booking form lists only sessions bookable by
  // the signed-in account (fewer than the calendar), not full sessions.
  setSessionCatalog(facilityId, date, sessions, verifiedAt = new Date().toISOString()) {
    const id = String(facilityId);
    if (!this.catalogFacility(id) || !validDate(date) || !Array.isArray(sessions)
      || sessions.length > 100 || !Number.isFinite(Date.parse(verifiedAt))
      || sessions.some(s => !TIME.test(s?.start || '') || !TIME.test(s?.end || '') || s.start >= s.end)
      || new Set(sessions.map(s => `${s.start}|${s.end}`)).size !== sessions.length) {
      throw new Error('invalid session catalog');
    }
    this.state.sessionCatalog ||= {};
    this.state.sessionCatalog[`${id}|${date}`] = {
      source: 'official-booking-form', verifiedAt,
      sessions: sessions.map(({start,end}) => ({start,end})).sort((a,b) => a.start.localeCompare(b.start))
    };
    // Keep the independently checked parser proof separate from the evolving
    // weekly menu. Calendar learning must not erase it or renew its timestamp.
    this.state.officialSessionEvidence ||= {};
    this.state.officialSessionEvidence[`${id}|${date}`] = structuredClone(this.state.sessionCatalog[`${id}|${date}`]);
    this.save();
  }

  refreshOfficialSessionEvidence({facilityId,date,sessions,verifiedAt,source} = {}) {
    const id=String(facilityId||''),key=`${id}|${date}`,prior=this.state.officialSessionEvidence?.[key];
    const age=Date.now()-Date.parse(verifiedAt||'');
    if(source!=='official-booking-form'||prior?.source!==source||!this.catalogFacility(id)
      ||!this.state.readerPlan?.facilityIds?.includes(id)||!this.state.readerPlan?.dates?.includes(date)
      ||!Number.isFinite(age)||age<0||age>300000||Date.parse(verifiedAt)<=Date.parse(prior.verifiedAt)
      ||!Array.isArray(sessions)||!sessions.length||sessions.length>100
      ||sessions.some(s=>!TIME.test(s?.start||'')||!TIME.test(s?.end||'')||s.start>=s.end)
      ||new Set(sessions.map(s=>`${s.start}|${s.end}`)).size!==sessions.length)throw new Error('invalid official proof refresh');
    this.state.officialSessionEvidence[key]={source,verifiedAt,
      sessions:sessions.map(({start,end})=>({start,end})).sort((a,b)=>a.start.localeCompare(b.start))};
    this.save();
  }

  filtersFor(chatId, facilityId) {
    return this.subscriptionsFor(chatId).filter(item => item.facilityId === String(facilityId));
  }

  replaceFacilityFilters(chatId, facilityId, filtersList) {
    const cid = String(chatId);
    const fid = String(facilityId);
    if (!/^-?\d{1,20}$/.test(cid) || !/^\d{1,4}$/.test(fid) || !Array.isArray(filtersList) || filtersList.length > 48) {
      throw new Error('invalid subscription');
    }
    const replacement = filtersList.map(filters => this.validatedSubscription(cid, fid, filters));
    this.state.subscriptions = this.state.subscriptions.filter(item => !(item.chatId === cid && item.facilityId === fid));
    this.state.subscriptions.push(...replacement);
    this.reconcileQueuedForChat(cid);
    this.save();
    return replacement;
  }

  validatedSubscription(cid, fid, filters) {
    if (!filters || typeof filters !== 'object' || Array.isArray(filters)) throw new Error('invalid filters');
    const allowed = new Set(['date', 'startAfter', 'endBefore', 'notifyAvailable', 'exactTime']);
    if (Object.keys(filters).some(key => !allowed.has(key))) throw new Error('unsupported filter');
    if (filters.date !== undefined && !validDate(filters.date)) throw new Error('invalid date');
    if (filters.notifyAvailable !== undefined && (filters.notifyAvailable !== true || !validDate(filters.date))) {
      throw new Error('availability watch requires an explicit date');
    }
    if (filters.startAfter !== undefined && (typeof filters.startAfter !== 'string' || !TIME.test(filters.startAfter))) throw new Error('invalid start time');
    if (filters.endBefore !== undefined && (typeof filters.endBefore !== 'string' || !TIME.test(filters.endBefore))) throw new Error('invalid end time');
    if (filters.startAfter && filters.endBefore && filters.startAfter >= filters.endBefore) throw new Error('invalid time window');
    if (filters.exactTime !== undefined && (filters.exactTime !== true || !filters.date || !filters.startAfter || !filters.endBefore)) throw new Error('exact session requires a date and both times');
    return { chatId: cid, facilityId: fid, active: true, ...filters };
  }

  replaceDayFilters(chatId,facilityId,date,filtersList) {
    const cid=String(chatId),fid=String(facilityId);
    if(!validDate(date)||!Array.isArray(filtersList)||filtersList.some(f=>f.date!==date)
      ||!/^\d{1,20}$/.test(cid)||!/^\d{1,4}$/.test(fid))throw new Error('invalid dated selection');
    const prior=this.filtersFor(cid,fid);
    const other=prior.filter(f=>f.date!==date);
    if(other.length+filtersList.length>48)throw new Error('too many selections');
    const identity=f=>JSON.stringify([f.date,f.startAfter,f.endBefore,!!f.exactTime,!!f.notifyAvailable]);
    const replacement=filtersList.map(f=>{
      const valid=this.validatedSubscription(cid,fid,f);
      return prior.find(old=>identity(old)===identity(valid))||valid;
    });
    this.state.subscriptions=this.state.subscriptions.filter(f=>!(f.chatId===cid&&f.facilityId===fid&&f.date===date));
    this.state.subscriptions.push(...replacement);
    this.reconcileQueuedForChat(cid);this.save();
  }

  // Additive, all-or-nothing multi-picker commit. Existing objects (including
  // availability delivery history) are retained; preflight every facility.
  appendDayFilters(chatId,entries) {
    const cid=String(chatId);
    if(!this.isChatAllowed(cid)||!Array.isArray(entries)||entries.length>1400)throw new Error('invalid dated selection');
    const identity=f=>JSON.stringify([f.facilityId,f.date,f.startAfter,f.endBefore,!!f.exactTime,!!f.notifyAvailable]);
    const prior=this.state.subscriptions;
    const counts=new Map(),seen=new Set();
    for(const f of prior.filter(f=>f.chatId===cid)){counts.set(f.facilityId,(counts.get(f.facilityId)||0)+1);seen.add(identity(f));}
    const additions=[];
    for(const entry of entries){
      const fid=String(entry?.facilityId);
      if(!this.catalogFacility(fid)||!validDate(entry.date)||!Array.isArray(entry.filters)||entry.filters.some(f=>f.date!==entry.date))throw new Error('invalid dated selection');
      for(const filter of entry.filters){
        const f=this.validatedSubscription(cid,fid,filter),key=identity(f);
        if(seen.has(key))continue;
        const count=(counts.get(fid)||0)+1;
        if(count>48)throw new Error('too many selections');
        counts.set(fid,count);seen.add(key);additions.push(f);
      }
    }
    if(!additions.length)return 0;
    this.state.subscriptions=[...prior,...additions];
    try{this.save();}catch(error){this.state.subscriptions=prior;throw error;}
    return additions.length;
  }

  pruneSelectionDrafts(now=Date.now(),persist=true) {
    let removed=0;
    for(const [id,d] of Object.entries(this.state.selectionDrafts||{})){
      if(!d||!Number.isFinite(d.at)||now-d.at<0||now-d.at>=30*60000){delete this.state.selectionDrafts[id];removed++;}
    }
    if(removed&&persist)this.save();return removed;
  }

  // The next week is published on Sunday evening with every place free, so
  // a calendar read then shows every session. From Sunday 19:30 until the day
  // ends, each fresh reading of a later date adds its sessions to that date's
  // list; the list only grows, so a session that fills up stays known.
  learnPublishedWeek(observation) {
    if (observation?.state !== 'ok' || observation.fresh !== true || !Array.isArray(observation.slots)) return false;
    const at = Date.parse(observation.observedAt);
    const parts = Object.fromEntries(ISTANBUL_CLOCK.formatToParts(new Date(at))
      .filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    const sunday = new Date(`${today}T12:00:00Z`).getUTCDay() === 0;
    if (!sunday || `${parts.hour}:${parts.minute}` < '19:30' || !(observation.date > today)) return false;
    const key = `${observation.facility.id}|${observation.date}`;
    const prior = this.state.sessionCatalog?.[key];
    const known = new Map((prior?.source === 'weekly-publication' ? prior.sessions : []).map(s => [`${s.start}|${s.end}`, s]));
    for (const slot of observation.slots) known.set(`${slot.start}|${slot.end}`, { start: slot.start, end: slot.end });
    // Before publication the next week reads empty; that is not a session list.
    if (!known.size || (prior?.source === 'weekly-publication' && known.size === prior.sessions.length)) return false;
    this.state.sessionCatalog ||= {};
    this.state.sessionCatalog[key] = { source: 'weekly-publication', verifiedAt: observation.observedAt,
      sessions: [...known.values()].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end)).slice(0, 100) };
    this.noteWeekPublication(observation.date, observation.observedAt);
    return true;
  }

  // After publication, dated hours may change during the week. A fresh
  // calendar can prove a newly added time, but missing times may merely be
  // full/omitted: retain them without manufacturing availability or moving
  // anyone's saved exact-time preference. Explicit catalog replacements still
  // supersede this learned list through setSessionCatalog.
  learnCalendarChanges(observation) {
    if (observation?.state !== 'ok' || observation.fresh !== true
      || !Array.isArray(observation.slots) || !validDate(observation.date)) return false;
    const at=Date.parse(observation.observedAt);
    const key=`${observation.facility?.id}|${observation.date}`;
    const prior=this.state.sessionCatalog?.[key];
    if (!Number.isFinite(at) || !['weekly-publication','official-booking-form'].includes(prior?.source)
      || !Array.isArray(prior.sessions) || at<Date.parse(prior.verifiedAt)) return false;
    const known=new Map(prior.sessions.map(s=>[`${s.start}|${s.end}`,s]));
    const before=known.size;
    for (const slot of observation.slots) {
      if(known.size>=100)break;
      if(slot.date!==observation.date||!TIME.test(slot.start||'')||!TIME.test(slot.end||'')||slot.start>=slot.end)continue;
      known.set(`${slot.start}|${slot.end}`,{start:slot.start,end:slot.end});
    }
    if(known.size===before)return false;
    this.state.sessionCatalog[key]={...prior,verifiedAt:observation.observedAt,
      sessions:[...known.values()].sort((a,b)=>a.start.localeCompare(b.start)||a.end.localeCompare(b.end))};
    return true;
  }

  // The week counts as published once three facilities show its sessions.
  // Record it for internal/operator inspection only; never notify users.
  noteWeekPublication(date, at) {
    const day = new Date(`${date}T12:00:00Z`);
    const monday = new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
    const sunday = new Date(Date.parse(`${monday}T12:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
    const announcements = this.state.weekAnnouncements ||= {};
    if (announcements[monday]) return false;
    const facilities = new Set(Object.entries(this.state.sessionCatalog || {})
      .filter(([key, value]) => value?.source === 'weekly-publication' && value.sessions?.length
        && key.split('|')[1] >= monday && key.split('|')[1] <= sunday).map(([key]) => key.split('|')[0]));
    if (facilities.size < 3) return false;
    announcements[monday] = at;
    for (const key of Object.keys(announcements)) if (key < new Date(Date.parse(`${monday}T12:00:00Z`) - 35 * 86_400_000).toISOString().slice(0, 10)) delete announcements[key];
    return true;
  }

  // Legacy API stays locked off, including for previously opted-in users.
  weekNoticeOn() { return false; }

  setWeekNotice() {
    if (this.state.broadcast) { this.state.broadcast = null; this.save(); }
    return false;
  }

  // A selection whose session (or whole day) is over can never alert again.
  pruneEndedSelections(now = Date.now()) {
    const expiredDrafts=this.pruneSelectionDrafts(now,false);
    const parts = Object.fromEntries(ISTANBUL_CLOCK.formatToParts(new Date(now))
      .filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    const before = this.state.subscriptions.length;
    this.state.subscriptions = this.state.subscriptions.filter(item => !item.date
      || (item.date >= today && !(item.endBefore && sessionHasEnded({ date: item.date, end: item.endBefore }, now))));
    const removed = before - this.state.subscriptions.length;
    // Session lists of past days are no longer needed.
    let dropped = 0;
    for(const key of Object.keys(this.state.officialSessionEvidence || {}))if(key.split('|')[1]<today)delete this.state.officialSessionEvidence[key];
    for (const key of Object.keys(this.state.sessionCatalog || {})) {
      if (key.split('|')[1] < today) { delete this.state.sessionCatalog[key]; dropped++; }
    }
    if (removed || dropped || expiredDrafts) this.save();
    return removed;
  }

  // A short stable key for one saved selection, used by its delete button.
  static selectionKey(item) {
    return createHash('sha256').update(JSON.stringify([String(item.facilityId), item.date || '', item.startAfter || '',
      item.endBefore || '', item.exactTime === true])).digest('hex').slice(0, 12);
  }

  removeSelection(chatId, key) {
    const cid = String(chatId);
    const item = this.subscriptionsFor(cid).find(value => LocalStore.selectionKey(value) === key);
    if (!item) return null;
    this.state.subscriptions = this.state.subscriptions.filter(value => value !== item);
    this.reconcileQueuedForChat(cid);
    this.save();
    return item;
  }

  removeUndatedFilters(chatId,facilityId) {
    const cid=String(chatId),fid=String(facilityId);
    this.state.subscriptions=this.state.subscriptions.filter(f=>!(f.chatId===cid&&f.facilityId===fid&&!f.date));
    this.reconcileQueuedForChat(cid);this.save();
  }

  reconcileQueuedForChat(chatId) {
    const subscriptions = this.subscriptionsFor(chatId);
    this.state.outbox = this.state.outbox.filter(item => {
      if (item.status !== 'queued' || item.chatId !== String(chatId)) return true;
      return subscriptions.some(subscription => subscriptionMatches(subscription, item.event));
    });
  }

  subscribe(chatId, facilityId, filters = {}) {
    const cid = String(chatId);
    const fid = String(facilityId);
    if (!/^-?\d{1,20}$/.test(cid) || !/^\d{1,4}$/.test(fid)) throw new Error('invalid subscription');
    const entry = this.validatedSubscription(cid, fid, filters);
    const index = this.state.subscriptions.findIndex(item => item.chatId === cid && item.facilityId === fid
      && (item.date ?? '') === (entry.date ?? '')
      && (item.startAfter ?? '') === (entry.startAfter ?? '')
      && (item.endBefore ?? '') === (entry.endBefore ?? ''));
    if (index >= 0) this.state.subscriptions[index] = entry;
    else this.state.subscriptions.push(entry);
    this.save();
    return entry;
  }

  unsubscribe(chatId, facilityId) {
    const before = this.state.subscriptions.length;
    this.state.subscriptions = this.state.subscriptions.filter(item => !(item.chatId === String(chatId) && item.facilityId === String(facilityId)));
    this.reconcileQueuedForChat(chatId);
    this.save();
    return before - this.state.subscriptions.length;
  }

  subscriptionsFor(chatId) {
    return this.state.subscriptions.filter(item => item.chatId === String(chatId));
  }

  dueDeliveries(now = Date.now()) {
    if (this.expireStaleDeliveries(now)) this.save();
    if(now<Number(this.state.deliveryBlockedUntil||0))return [];
    return this.state.outbox.filter(item => item.status === 'queued' && item.nextAt <= now
      && (!this.restartHeldDeliveryIds.has(item.id) || !this.isChatAllowed(item.chatId)));
  }

  expireStaleDeliveries(now = Date.now()) {
    let expired = 0;
    for (const item of this.state.outbox) {
      if (item.status !== 'queued') continue;
      // Captured events always carry observedAt. Older test/manual queue
      // records without it retain their previous delivery semantics.
      const observedAt = Date.parse(item.event?.observedAt || '');
      const ended = sessionHasEnded(item.event, now);
      const registrationClosed = sessionRegistrationClosed(item.event,
        this.catalogFacility(item.event?.facility?.id)?.unit, now);
      if (!registrationClosed && (!Number.isFinite(observedAt)
        || now - observedAt <= (Number.isFinite(item.maxAgeMs)?item.maxAgeMs:AVAILABILITY_DELIVERY_MAX_AGE_MS))) continue;
      item.status = 'expired';
      item.failedAt = new Date(now).toISOString();
      item.reason = ended ? 'session_ended'
        : registrationClosed ? 'registration_closed' : 'stale_availability';
      delete item.event;
      this.restartHeldDeliveryIds.delete(item.id);
      expired++;
    }
    return expired;
  }

  deferQueuedUntil(until) {
    if (!Number.isFinite(until) || until < Date.now()) throw new Error('invalid deferral time');
    let deferred = 0;
    const prior=Number(this.state.deliveryBlockedUntil||0);
    this.state.deliveryBlockedUntil=Math.max(prior,until);
    for (const item of this.state.outbox) {
      if (item.status !== 'queued' || item.nextAt >= until) continue;
      item.nextAt = until;
      deferred++;
    }
    if (deferred||this.state.deliveryBlockedUntil!==prior) this.save();
    return deferred;
  }

  beginDelivery(id, persist = true) {
    // A queued alert can cross its freshness or booking deadline between
    // selection and the external call.
    if (this.expireStaleDeliveries()) this.save();
    const item = this.state.outbox.find(value => value.id === id);
    if (!item || Date.now()<Number(this.state.deliveryBlockedUntil||0) || item.status !== 'queued' || item.nextAt > Date.now()
      || this.restartHeldDeliveryIds.has(id)) return false;
    if(item.event?.kind==='available'){
      const key=item.availabilityKey||slotAlertKey({chatId:item.chatId,facilityId:item.event.facility.id,...item.event});
      item.availabilityKey=key;
      if(this.state.slotAlerts?.[key]){
        item.status='cancelled';item.cancelledAt=new Date().toISOString();item.reason='session_lifecycle_already_started';delete item.event;
        if(persist)this.save();return false;
      }
    }
    item.status = 'sending';
    item.sendStartedAt = new Date().toISOString();
    item.attempts = (item.attempts || 0) + 1;
    this.restartHeldDeliveryIds.delete(id);
    if (persist) this.save();
    return true;
  }

  // A batch marked 'sending' that was never handed to Telegram (for example
  // after a 429 stopped the round) goes back to the queue unchanged.
  revertDelivery(id) {
    const item = this.state.outbox.find(value => value.id === id);
    if (!item || item.status !== 'sending') return;
    item.status = 'queued';
    item.attempts = Math.max(0, (item.attempts || 1) - 1);
    delete item.sendStartedAt;
  }

  markDelivery(id, result, persist = true) {
    const item = this.state.outbox.find(value => value.id === id);
    if (!item || !['queued', 'sending'].includes(item.status)) return;
    if (item.status === 'queued' && !result.permanent) return;
    this.restartHeldDeliveryIds.delete(id);
    if (result.ok) {
      item.status = 'sent';
      item.sentAt = new Date().toISOString();
      rememberSlotAlert(this,item,result.messageId);
      delete item.event;
    } else if (result.uncertain) {
      item.status = 'uncertain';
      item.uncertainAt = new Date().toISOString();
      item.reason = result.reason || 'send_result_unknown';
      delete item.event;
    } else if (result.permanent || item.attempts >= 6) {
      item.status = 'failed';
      item.failedAt = new Date().toISOString();
      item.reason = result.reason || 'delivery failed';
      delete item.event;
    } else {
      item.status = 'queued';
      item.nextAt = Date.now() + Math.max(5_000, result.retryAfterMs ?? 30_000 * item.attempts);
    }
    if (persist) this.save();
  }

  setTelegramOffset(offset, persist = true) {
    if (Number.isSafeInteger(offset) && offset > this.state.telegramOffset) {
      this.state.telegramOffset = offset;
      if (persist) this.save();
      return true;
    }
    return false;
  }

  status() {
    const observation = this.engine.health;
    const now = Date.now();
    const currentPage = observation.lastState === 'ok'
      ? Object.values(this.engine.pages).find(page => page.lastSuccessAt === observation.lastSeenAt
        && String(page.facility?.id) === String(observation.lastFacility?.id)) : null;
    const subscribed = new Set(this.state.subscriptions.filter(item => item.active === true)
      .map(item => String(item.facilityId)));
    const parts = Object.fromEntries(ISTANBUL_CLOCK.formatToParts(new Date(now))
      .filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    const latestByFacility = new Map();
    for (const page of Object.values(this.engine.pages)) {
      const id = String(page?.facility?.id ?? '');
      const at = Date.parse(page?.lastSuccessAt || '');
      if (!subscribed.has(id) || !validDate(page?.date) || page.date < today
        || !Number.isFinite(at)) continue;
      if (at > (latestByFacility.get(id)?.at ?? -Infinity)) latestByFacility.set(id, { page, at });
    }
    let fresh = 0;
    let complete = 0;
    for (const id of observation.lastState === 'ok' ? subscribed : []) {
      const latest = latestByFacility.get(id);
      if (!latest || latest.at > now + 30_000 || now - latest.at > 180_000) continue;
      fresh++;
      const unit = this.catalogFacility(id)?.unit;
      const coverage = unit ? sessionCoverage(latest.page, now, unit) : null;
      if (coverage && coverage.recordedSessions > 0 && !coverage.intermittent) complete++;
    }
    return {
      accessMode: this.accessMode,
      readerCapabilities: this.state.readerCapabilities||null,
      facilityCatalog: this.availableFacilities(),
      unitCatalog: this.state.unitCatalog||[],
      catalogDiscoveredAt: this.state.catalogDiscoveredAt||null,
      reader: this.state.readerPlan ? {
        phase:this.engine.health.lastState==='paused'?'paused':isPublicationWait({state:this.state,engine:this.engine,now})?'waiting_publication':this.state.readerState?.phase||'preparing',
        at:this.state.readerState?.at||null,
        total:this.state.readerPlan.facilityIds.length*this.state.readerPlan.dates.length,
        checkedWithinSchedule:this.state.readerPlan.facilityIds.flatMap(id=>this.state.readerPlan.dates.map(date=>({id,page:this.engine.pages[`${id}|${date}`]}))).filter(({id,page})=>page&&now-Date.parse(page.lastSuccessAt||'')>=0&&now-Date.parse(page.lastSuccessAt||'')<=scheduleFreshMs(this,id)).length,
        fresh:this.state.readerPlan.facilityIds.flatMap(id=>this.state.readerPlan.dates.map(date=>this.engine.pages[`${id}|${date}`]))
          .filter(page=>page&&now-Date.parse(page.lastSuccessAt||'')>=0&&now-Date.parse(page.lastSuccessAt||'')<=240000).length
      } : null,
      lastObservation: observation,
      calendarCoverage: currentPage ? sessionCoverage(currentPage, now,
        this.catalogFacility(currentPage.facility?.id)?.unit) : null,
      subscribedFacilityCoverage: { subscribed: subscribed.size, fresh, complete },
      lastDiagnostic: this.state.lastDiagnostic ?? null,
      readerDiagnostics: this.state.readerDiagnostics ?? {},
      operatorAlerts:this.state.operatorAlerts||{configured:false,ready:false,reason:'not_configured'},
      readerMemoryRecycle:this.state.readerMemoryRecycle||null,
      readerAutoRefresh:this.state.readerAutoRefresh||null,
      readerStats: this.readStatsSummary(now),
      fastAvailability: this.state.fastAvailability===true,
      // The extension's parser only uses booking-form lists; keep its payload small.
      sessionCatalog: {...Object.fromEntries(Object.entries(this.state.sessionCatalog ?? {}).filter(([, value]) => value?.source === 'official-booking-form')), ...(this.state.officialSessionEvidence || {})},
      coverageNotice: this.state.coverageNotice
        ? { kind: this.state.coverageNotice.kind, alerted: this.state.coverageNotice.alerted === true,
          alertedAt: this.state.coverageNotice.alertedAt ?? null } : null,
      monitoredFacilityDays: Object.keys(this.engine.pages).length,
      subscriptions: this.state.subscriptions.length,
      queued: this.state.outbox.filter(item => item.status === 'queued').length,
      sending: this.state.outbox.filter(item => item.status === 'sending').length,
      uncertain: this.state.outbox.filter(item => item.status === 'uncertain').length,
      failed: this.state.outbox.filter(item => item.status === 'failed').length,
      expired: this.state.outbox.filter(item => item.status === 'expired').length,
      lastExpiredAt: this.state.outbox.reduce((latest, item) =>
        item.status === 'expired' && item.failedAt > latest ? item.failedAt : latest, '') || null,
      telegram: { ...this.telegramHealth }
    };
  }
}
