import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { normalizeSnapshot, SnapshotEngine, subscriptionMatches } from '../src/core.mjs';
import { LocalStore } from '../src/store.mjs';

const day = '2026-10-19';
const slot = free => ({ date: day, start: '11:00', end: '12:45', free });
const now = Date.now();
const snapshot = (id, at, slots = [slot(3)]) => ({
  schema: 1,
  source: 'rez-calendar-extension',
  observed_at: new Date(at).toISOString(),
  state: 'ok',
  facility: { id: '17', label: 'Örnek Spor Salonu' },
  view: { type: 'day', date: day },
  slots,
  fresh: true,
  refresh_id: id
});
const unavailable = (at, state = 'calendar_unavailable') => ({
  schema: 1, source: 'rez-calendar-extension', observed_at: new Date(at).toISOString(),
  state, fresh: false, facility: null, view: { type: 'unknown', date: null }, slots: []
});

test('only distinct confirmed refreshes can establish and confirm an increased vacancy', () => {
  const engine = new SnapshotEngine();
  assert.deepEqual(engine.ingest(snapshot('refresh01', now - 4000)), []);
  assert.deepEqual(engine.ingest(snapshot('refresh02', now - 3000, [])), []);
  assert.deepEqual(engine.ingest(snapshot('refresh03', now - 2000)), []);
  assert.deepEqual(engine.ingest(snapshot('refresh04', now - 1500, [slot(4)])), []);
  assert.deepEqual(engine.ingest(snapshot('refresh04', now - 1000, [slot(4)])), []);
  const events = engine.ingest(snapshot('refresh05', now - 500, [slot(4)]));
  assert.equal(events.length, 1);
  assert.equal(events[0].previousFree, 3);
  assert.equal(events[0].free, 4);
  assert.deepEqual(engine.ingest(snapshot('refresh06', now - 100, [slot(4)])), []);
});

test('a site error or missing tab breaks a pending increase and an empty streak', () => {
  const engine = new SnapshotEngine();
  assert.deepEqual(engine.ingest(snapshot('interrup1', now - 8000, [slot(1)])), []);
  assert.deepEqual(engine.ingest(snapshot('interrup2', now - 7000, [slot(2)])), []);
  assert.deepEqual(engine.ingest(unavailable(now - 6000)), []);
  assert.deepEqual(engine.ingest(snapshot('interrup3', now - 5000, [slot(2)])), []);
  assert.equal(engine.ingest(snapshot('interrup4', now - 4000, [slot(2)])).length, 1);

  const empty = new SnapshotEngine();
  assert.deepEqual(empty.ingest(snapshot('interrup5', now - 5000, [])), []);
  assert.deepEqual(empty.ingest(unavailable(now - 4000, 'no_tab')), []);
  assert.deepEqual(empty.ingest(snapshot('interrup6', now - 3000, [])), []);
  assert.equal(empty.export().pages[`17|${day}`].baselineConfirmed, false);
  assert.deepEqual(empty.ingest(snapshot('interrup7', now - 2000, [])), []);
  assert.equal(empty.export().pages[`17|${day}`].baselineConfirmed, false);
});

test('a long gap requires two new fresh reads before confirming an increase', () => {
  const engine = new SnapshotEngine();
  assert.deepEqual(engine.ingest(snapshot('timegap1', now - 290_000, [slot(1)])), []);
  assert.deepEqual(engine.ingest(snapshot('timegap2', now - 240_000, [slot(2)])), []);
  assert.deepEqual(engine.ingest(snapshot('timegap3', now - 10_000, [slot(2)])), []);
  assert.equal(engine.ingest(snapshot('timegap4', now - 5000, [slot(2)])).length, 1);
});

test('first published next-week calendar is a baseline, then a later increase alerts once', () => {
  const engine = new SnapshotEngine();
  const facility = { id: '23', label: 'Örnek Havuz' };
  const weekPage = (id, at, date, free) => ({
    ...snapshot(id, at, []),
    facility,
    view: { type: 'day', date },
    slots: [{ date, start: '11:00', end: '12:45', free }]
  });
  const previousMonday = '2026-10-12';
  const nextMonday = '2026-10-19';
  const nextPageKey = `${facility.id}|${nextMonday}`;
  const nextSlotKey = `${nextMonday}|11:00|12:45`;

  // The prior week does not establish an empty baseline for a different date.
  assert.deepEqual(engine.ingest(weekPage('weekold1', now - 5000, previousMonday, 2)), []);
  assert.deepEqual(engine.ingest(weekPage('weeknew1', now - 4000, nextMonday, 3)), []);
  assert.equal(engine.export().pages[nextPageKey].slots[nextSlotKey].confirmedFree, 3);
  assert.deepEqual(engine.ingest(weekPage('weeknew2', now - 3000, nextMonday, 5)), []);
  assert.deepEqual(engine.ingest(weekPage('weeknew2', now - 2500, nextMonday, 5)), []);
  const events = engine.ingest(weekPage('weeknew3', now - 2000, nextMonday, 5));
  assert.equal(events.length, 1);
  assert.equal(events[0].previousFree, 3);
  assert.equal(events[0].free, 5);
  assert.equal(events[0].date, nextMonday);
  assert.deepEqual(engine.ingest(weekPage('weeknew4', now - 1000, nextMonday, 5)), []);
});

test('an empty event list never establishes a zero vacancy baseline', () => {
  const engine = new SnapshotEngine();
  assert.deepEqual(engine.ingest(snapshot('zero0001', now - 7000, [])), []);
  assert.equal(engine.export().pages[`17|${day}`].baselineConfirmed, false);
  assert.deepEqual(engine.ingest(snapshot('zero0002', now - 6000, [])), []);
  assert.equal(engine.export().pages[`17|${day}`].baselineConfirmed, false);
  assert.deepEqual(engine.ingest(snapshot('zero0003', now - 5000, [slot(2)])), []);
  assert.deepEqual(engine.ingest(snapshot('zero0004', now - 4000, [slot(2)])), []);
  assert.deepEqual(engine.ingest(snapshot('zero0005', now - 3000, [slot(3)])), []);
  const events = engine.ingest(snapshot('zero0006', now - 2000, [slot(3)]));
  assert.equal(events.length, 1);
  assert.equal(events[0].previousFree, 2);
  assert.equal(events[0].free, 3);
});

test('two empty refreshes retain an earlier nonempty baseline and isolate other days', () => {
  const engine = new SnapshotEngine();
  const anotherDate = '2026-10-20';
  const anotherPage = (id, at, slots) => ({
    ...snapshot(id, at, []),
    view: { type: 'day', date: anotherDate },
    slots: slots.map(item => ({ ...item, date: anotherDate }))
  });
  assert.deepEqual(engine.ingest(snapshot('reopen01', now - 6000, [slot(3)])), []);
  assert.deepEqual(engine.ingest(anotherPage('reopen02', now - 5500, [slot(4)])), []);
  assert.deepEqual(engine.ingest(snapshot('reopen03', now - 5000, [])), []);
  assert.equal(engine.export().pages[`17|${day}`].slots[`${day}|11:00|12:45`].confirmedFree, 3);
  assert.deepEqual(engine.ingest(snapshot('reopen04', now - 4000, [])), []);
  assert.equal(engine.export().pages[`17|${day}`].slots[`${day}|11:00|12:45`].confirmedFree, 3);
  assert.equal(engine.export().pages[`17|${anotherDate}`].slots[`${anotherDate}|11:00|12:45`].confirmedFree, 4);
  assert.deepEqual(engine.ingest(snapshot('reopen05', now - 3000, [slot(3)])), []);
  assert.deepEqual(engine.ingest(snapshot('reopen06', now - 2000, [slot(3)])), []);
  assert.deepEqual(engine.ingest(snapshot('reopen07', now - 1500, [slot(4)])), []);
  const events = engine.ingest(snapshot('reopen08', now - 1000, [slot(4)]));
  assert.equal(events.length, 1);
  assert.equal(events[0].previousFree, 3);
});

test('an explicit zero for a known session can establish a real reopening', () => {
  const engine = new SnapshotEngine();
  assert.deepEqual(engine.ingest(snapshot('explicit1', now - 6000, [slot(1)])), []);
  assert.deepEqual(engine.ingest(snapshot('explicit2', now - 5000, [slot(0)])), []);
  assert.deepEqual(engine.ingest(snapshot('explicit3', now - 4000, [slot(0)])), []);
  assert.deepEqual(engine.ingest(snapshot('explicit4', now - 3000, [slot(1)])), []);
  const events = engine.ingest(snapshot('explicit5', now - 2000, [slot(1)]));
  assert.equal(events.length, 1);
  assert.equal(events[0].previousFree, 0);
  assert.equal(events[0].free, 1);
});

test('a one-read downward glitch returning to the old count cannot create a vacancy alert', () => {
  const engine = new SnapshotEngine();
  assert.deepEqual(engine.ingest(snapshot('dipglitch1', now - 4000, [slot(6)])), []);
  assert.deepEqual(engine.ingest(snapshot('dipglitch2', now - 3000, [slot(1)])), []);
  assert.equal(engine.export().pages[`17|${day}`].slots[`${day}|11:00|12:45`].confirmedFree, 6);
  assert.deepEqual(engine.ingest(snapshot('dipglitch3', now - 2000, [slot(6)])), []);
  assert.deepEqual(engine.ingest(snapshot('dipglitch4', now - 1000, [slot(6)])), []);
  assert.equal(engine.export().pages[`17|${day}`].slots[`${day}|11:00|12:45`].pending, null);
});

test('two fresh reads confirm a real drop before two fresh rises alert', () => {
  const engine = new SnapshotEngine();
  assert.deepEqual(engine.ingest(snapshot('realdrop01', now - 5000, [slot(6)])), []);
  assert.deepEqual(engine.ingest(snapshot('realdrop02', now - 4000, [slot(1)])), []);
  assert.deepEqual(engine.ingest(snapshot('realdrop03', now - 3000, [slot(1)])), []);
  assert.equal(engine.export().pages[`17|${day}`].slots[`${day}|11:00|12:45`].confirmedFree, 1);
  assert.deepEqual(engine.ingest(snapshot('realdrop04', now - 2000, [slot(6)])), []);
  const events = engine.ingest(snapshot('realdrop05', now - 1000, [slot(6)]));
  assert.equal(events.length, 1);
  assert.equal(events[0].previousFree, 1);
  assert.equal(events[0].free, 6);
});

test('an error, empty calendar or long gap interrupts a pending decrease', () => {
  for (const interruption of ['error', 'empty', 'gap']) {
    const engine = new SnapshotEngine();
    const start = interruption === 'gap' ? now - 290_000 : now - 6000;
    const dip = interruption === 'gap' ? now - 240_000 : now - 5000;
    assert.deepEqual(engine.ingest(snapshot(`audit-${interruption}-d1`, start, [slot(6)])), []);
    assert.deepEqual(engine.ingest(snapshot(`audit-${interruption}-d2`, dip, [slot(1)])), []);
    if (interruption === 'error') assert.deepEqual(engine.ingest(unavailable(now - 4000)), []);
    if (interruption === 'empty') assert.deepEqual(engine.ingest(snapshot('audit-empty-d3', now - 4000, [])), []);
    assert.deepEqual(engine.ingest(snapshot(`audit-${interruption}-d4`, now - 3000, [slot(1)])), []);
    assert.equal(engine.export().pages[`17|${day}`].slots[`${day}|11:00|12:45`].confirmedFree, 6);
    assert.deepEqual(engine.ingest(snapshot(`audit-${interruption}-d5`, now - 2000, [slot(6)])), []);
    assert.deepEqual(engine.ingest(snapshot(`audit-${interruption}-d6`, now - 1000, [slot(6)])), []);
  }
});

test('legacy engine pages are rebaselined once while health is retained', () => {
  const key = `17|${day}`;
  const slotKey = `${day}|11:00|12:45`;
  const health = { lastState: 'ok', lastSeenAt: new Date(now - 5000).toISOString(), lastFacility: { id: '17', label: 'Örnek Spor Salonu' } };
  const legacy = {
    // No algorithmVersion: version 1 could have confirmed a one-read dip.
    pages: { [key]: { slots: { [slotKey]: { free: 1, confirmedFree: 1, pending: null } } } },
    health
  };
  const engine = new SnapshotEngine(legacy);
  assert.deepEqual(engine.export().pages, {});
  assert.deepEqual(engine.export().health, health);
  assert.equal(engine.export().algorithmVersion, 2);
  assert.deepEqual(engine.ingest(snapshot('legacynew1', now - 4000, [slot(6)])), []);
  assert.deepEqual(engine.ingest(snapshot('legacynew2', now - 3000, [slot(6)])), []);
  assert.equal(engine.export().pages[key].slots[slotKey].confirmedFree, 6);
});

test('serialized version 2 baseline survives a real engine restart', () => {
  const first = new SnapshotEngine();
  assert.deepEqual(first.ingest(snapshot('v2persist01', now - 5000, [slot(6)])), []);
  assert.deepEqual(first.ingest(snapshot('v2persist02', now - 4000, [slot(1)])), []);
  assert.deepEqual(first.ingest(snapshot('v2persist03', now - 3000, [slot(1)])), []);
  const saved = JSON.parse(JSON.stringify(first.export()));
  assert.equal(saved.algorithmVersion, 2);
  const restarted = new SnapshotEngine(saved);
  assert.equal(restarted.export().pages[`17|${day}`].slots[`${day}|11:00|12:45`].confirmedFree, 1);
  assert.deepEqual(restarted.ingest(snapshot('v2persist04', now - 2000, [slot(6)])), []);
  const events = restarted.ingest(snapshot('v2persist05', now - 1000, [slot(6)]));
  assert.equal(events.length, 1);
  assert.equal(events[0].previousFree, 1);
  assert.equal(events[0].free, 6);
});

test('one empty response never erases a stable baseline or an unconfirmed empty becomes a zero baseline', () => {
  const engine = new SnapshotEngine();
  assert.deepEqual(engine.ingest(snapshot('isolate1', now - 6000, [slot(3)])), []);
  assert.deepEqual(engine.ingest(snapshot('isolate2', now - 5000, [])), []);
  assert.equal(engine.export().pages[`17|${day}`].slots[`${day}|11:00|12:45`].confirmedFree, 3);
  assert.deepEqual(engine.ingest(snapshot('isolate3', now - 4000, [slot(3)])), []);
  assert.deepEqual(engine.ingest(snapshot('isolate4', now - 3000, [slot(4)])), []);
  const events = engine.ingest(snapshot('isolate5', now - 2000, [slot(4)]));
  assert.equal(events.length, 1);
  assert.equal(events[0].previousFree, 3);

  const noBaseline = new SnapshotEngine();
  assert.deepEqual(noBaseline.ingest(snapshot('isolate6', now - 2000, [])), []);
  assert.deepEqual(noBaseline.ingest(snapshot('isolate7', now - 1000, [slot(4)])), []);
  assert.deepEqual(noBaseline.ingest(snapshot('isolate8', now, [slot(4)])), []);
});

test('a partial nonempty response interrupts empty confirmation and a replayed empty cannot complete it', () => {
  const engine = new SnapshotEngine();
  const other = { date: day, start: '13:00', end: '14:45', free: 1 };
  assert.deepEqual(engine.ingest(snapshot('emptpart1', now - 5000, [slot(3), other])), []);
  assert.deepEqual(engine.ingest(snapshot('emptpart2', now - 4000, [])), []);
  assert.deepEqual(engine.ingest(snapshot('emptpart3', now - 3000, [slot(3)])), []);
  assert.deepEqual(engine.ingest(snapshot('emptpart4', now - 2000, [])), []);
  assert.deepEqual(engine.ingest(snapshot('emptpart2', now - 1000, [])), []);
  assert.equal(engine.export().pages[`17|${day}`].emptyStreak, 1);
  assert.equal(engine.export().pages[`17|${day}`].slots[`${day}|11:00|12:45`].confirmedFree, 3);
  assert.throws(() => engine.ingest(snapshot('emptpart5', now - 2500, [])), /out-of-order/);
});

test('nonconsecutive replay of an earlier refresh does not reset the baseline', () => {
  const engine = new SnapshotEngine();
  assert.deepEqual(engine.ingest(snapshot('replay001', now - 2000, [slot(2)])), []);
  assert.deepEqual(engine.ingest(snapshot('replay002', now - 1000, [slot(4)])), []);
  assert.deepEqual(engine.ingest(snapshot('replay001', now - 500, [slot(2)])), []);
  const events = engine.ingest(snapshot('replay003', now, [slot(4)]));
  assert.equal(events.length, 1);
  assert.equal(events[0].previousFree, 2);
});

test('passive DOM readings never update baseline or generate alerts', () => {
  const engine = new SnapshotEngine();
  const passive = (at, free) => ({ ...snapshot('discarded', at, [slot(free)]), fresh: false, refresh_id: undefined });
  assert.deepEqual(engine.ingest(passive(now - 3000, 1)), []);
  assert.deepEqual(engine.export().pages, {});
  assert.deepEqual(engine.ingest(snapshot('refresh11', now - 2000, [slot(3)])), []);
  assert.deepEqual(engine.ingest(passive(now - 1000, 5)), []);
  assert.deepEqual(engine.ingest(snapshot('refresh12', now - 500, [slot(3)])), []);
});

test('a partial calendar cannot make an unchanged slot appear newly available', () => {
  const engine = new SnapshotEngine();
  const other = { date: day, start: '13:00', end: '14:45', free: 2 };
  assert.deepEqual(engine.ingest(snapshot('partial01', now - 4000, [slot(3), other])), []);
  assert.deepEqual(engine.ingest(snapshot('partial02', now - 3000, [slot(3)])), []);
  assert.deepEqual(engine.export().pages[`17|${day}`].observedSlotKeys,
    [`${day}|11:00|12:45`]);
  assert.equal(engine.export().pages[`17|${day}`].slots[`${day}|13:00|14:45`].confirmedFree, 2);
  assert.deepEqual(engine.ingest(snapshot('partial03', now - 2000, [slot(3), other])), []);
  assert.deepEqual(engine.export().pages[`17|${day}`].observedSlotKeys,
    [`${day}|11:00|12:45`, `${day}|13:00|14:45`]);
  assert.deepEqual(engine.ingest(snapshot('partial04', now - 1000, [slot(3), other])), []);
});

test('a newly appearing session establishes its own baseline before an increase alerts', () => {
  const engine = new SnapshotEngine();
  const other = { date: day, start: '13:00', end: '14:45', free: 2 };
  assert.deepEqual(engine.ingest(snapshot('newslot01', now - 5000, [slot(3)])), []);
  assert.deepEqual(engine.ingest(snapshot('newslot02', now - 4000, [slot(3), other])), []);
  assert.deepEqual(engine.ingest(snapshot('newslot03', now - 3000, [slot(3), other])), []);
  const key = `${day}|13:00|14:45`;
  assert.equal(engine.export().pages[`17|${day}`].slots[key].confirmedFree, 2);
  const increased = { ...other, free: 3 };
  assert.deepEqual(engine.ingest(snapshot('newslot04', now - 2000, [slot(3), increased])), []);
  const events = engine.ingest(snapshot('newslot05', now - 1000, [slot(3), increased]));
  assert.equal(events.length, 1);
  assert.equal(events[0].start, '13:00');
  assert.equal(events[0].previousFree, 2);
  assert.equal(events[0].free, 3);
});

test('a fluctuating increase is confirmed against the last stable count', () => {
  const engine = new SnapshotEngine();
  assert.deepEqual(engine.ingest(snapshot('fluctua1', now - 4000, [slot(2)])), []);
  assert.deepEqual(engine.ingest(snapshot('fluctua2', now - 3000, [slot(4)])), []);
  assert.deepEqual(engine.ingest(snapshot('fluctua3', now - 2000, [slot(3)])), []);
  const events = engine.ingest(snapshot('fluctua4', now - 1000, [slot(3)]));
  assert.equal(events.length, 1);
  assert.equal(events[0].previousFree, 2);
  assert.equal(events[0].free, 3);
});

test('a slot missing from a partial calendar rebaselines on return before later increases alert', () => {
  const engine = new SnapshotEngine();
  const other = { date: day, start: '13:00', end: '14:45', free: 2 };
  assert.deepEqual(engine.ingest(snapshot('missing01', now - 5000, [slot(2), other])), []);
  assert.deepEqual(engine.ingest(snapshot('missing02', now - 4000, [slot(4), other])), []);
  assert.deepEqual(engine.ingest(snapshot('missing03', now - 3000, [other])), []);
  assert.deepEqual(engine.ingest(snapshot('missing04', now - 2000, [slot(4), other])), []);
  assert.equal(engine.export().pages[`17|${day}`].slots[`${day}|11:00|12:45`].confirmedFree, 4);
  assert.deepEqual(engine.ingest(snapshot('missing05', now - 1000, [slot(4), other])), []);
  assert.deepEqual(engine.ingest(snapshot('missing06', now - 500, [slot(5), other])), []);
  const events = engine.ingest(snapshot('missing07', now, [slot(5), other]));
  assert.equal(events.length, 1);
  assert.equal(events[0].previousFree, 4);
});

test('a selectively missing session can alert on a twice confirmed return after ten minutes', () => {
  const engine = new SnapshotEngine();
  const other = { date: day, start: '13:00', end: '14:45', free: 2 };
  assert.deepEqual(engine.ingest(snapshot('return01', now - 270_000, [slot(0), other])), []);
  assert.deepEqual(engine.ingest(snapshot('return02', now - 210_000, [other])), []);
  assert.deepEqual(engine.ingest(snapshot('return03', now - 150_000, [other])), []);
  assert.deepEqual(engine.ingest(snapshot('return04', now - 90_000, [other])), []);
  const key = `${day}|11:00|12:45`;
  const page = engine.export().pages[`17|${day}`];
  assert.equal(page.slots[key].missingReads, 3);
  // The real watch reaches this duration over ten actual minutes. Adjust
  // only the saved absence clock so this source test stays fast and valid.
  page.slots[key].missingSince = now - 11 * 60_000;
  assert.deepEqual(engine.ingest(snapshot('return05', now - 30_000, [slot(1), other])), []);
  const events = engine.ingest(snapshot('return06', now, [slot(1), other]));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'reappeared');
  assert.equal(events[0].free, 1);
  assert.equal(events[0].previousFree, 0);
  assert.deepEqual(engine.ingest(snapshot('return07', now + 1000, [slot(1), other])), []);
});

test('mass omission and a short selective omission never create a return alert', () => {
  const engine = new SnapshotEngine();
  const extra = [
    { date: day, start: '13:00', end: '14:45', free: 2 },
    { date: day, start: '15:00', end: '16:45', free: 3 },
    { date: day, start: '17:00', end: '18:45', free: 4 }
  ];
  engine.ingest(snapshot('mass0001', now - 240_000, [slot(2), ...extra]));
  engine.ingest(snapshot('mass0002', now - 180_000, [extra[0]]));
  const page = engine.export().pages[`17|${day}`];
  assert.equal(page.slots[`${day}|11:00|12:45`].missingReads, 1);
  assert.deepEqual(engine.ingest(snapshot('mass0003', now - 120_000, [slot(2), ...extra])), []);
  assert.deepEqual(engine.ingest(snapshot('mass0004', now - 60_000, [slot(2), ...extra])), []);
  engine.ingest(snapshot('mass0005', now - 30_000, [slot(2), extra[0], extra[1]]));
  assert.equal(engine.export().pages[`17|${day}`].slots[`${day}|17:00|18:45`].missingReads, 1);
  assert.deepEqual(engine.ingest(snapshot('mass0006', now, [slot(2), ...extra])), []);
});

test('one session returning to a stable one-of-seven calendar alerts only after two fresh reads', () => {
  const engine = new SnapshotEngine();
  const slots = [slot(0), ...['08:00', '10:00', '13:00', '15:00', '17:00', '19:00']
    .map((start, index) => ({ date: day, start,
      end: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:30`, free: index + 1 }))];
  const anchor = slots[1];
  engine.ingest(snapshot('dense001', now - 270_000, slots));
  engine.ingest(snapshot('dense002', now - 210_000, [anchor]));
  engine.ingest(snapshot('dense003', now - 150_000, [anchor]));
  engine.ingest(snapshot('dense004', now - 90_000, [anchor]));
  const page = engine.export().pages[`17|${day}`];
  const returnedKey = `${day}|11:00|12:45`;
  assert.equal(page.slots[returnedKey].missingReads, 3);
  page.slots[returnedKey].missingSince = now - 11 * 60_000;
  assert.deepEqual(engine.ingest(snapshot('dense005', now - 30_000, [anchor, slot(1)])), []);
  assert.equal(engine.export().pages[`17|${day}`].slots[`${day}|10:00|11:30`].missingReads, 4);
  const events = engine.ingest(snapshot('dense006', now, [anchor, slot(1)]));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'reappeared');
  assert.equal(events[0].free, 1);
  assert.deepEqual(engine.ingest(snapshot('dense007', now + 1000, [anchor, slot(1)])), []);
});

test('intermittently omitted positive sessions do not cause a return alert at the same or lower count', () => {
  const engine = new SnapshotEngine();
  const anchor = { date: day, start: '08:00', end: '09:30', free: 2 };
  engine.ingest(snapshot('same0001', now - 270_000, [anchor, slot(2)]));
  engine.ingest(snapshot('same0002', now - 210_000, [anchor]));
  engine.ingest(snapshot('same0003', now - 150_000, [anchor]));
  engine.ingest(snapshot('same0004', now - 90_000, [anchor]));
  const page = engine.export().pages[`17|${day}`];
  page.slots[`${day}|11:00|12:45`].missingSince = now - 11 * 60_000;
  assert.deepEqual(engine.ingest(snapshot('same0005', now - 30_000, [anchor, slot(2)])), []);
  assert.deepEqual(engine.ingest(snapshot('same0006', now, [anchor, slot(2)])), []);
  engine.ingest(snapshot('same0007', now + 1000, [anchor]));
  engine.ingest(snapshot('same0008', now + 2000, [anchor]));
  engine.ingest(snapshot('same0009', now + 3000, [anchor]));
  page.slots[`${day}|11:00|12:45`].missingSince = now - 11 * 60_000;
  assert.deepEqual(engine.ingest(snapshot('same0010', now + 4000, [anchor, slot(1)])), []);
  assert.deepEqual(engine.ingest(snapshot('same0011', now + 5000, [anchor, slot(1)])), []);
});

test('simultaneous return of most missing sessions is a baseline, not six vacancy alerts', () => {
  const engine = new SnapshotEngine();
  const slots = [slot(3), ...['08:00', '10:00', '13:00', '15:00', '17:00', '19:00']
    .map((start, index) => ({ date: day, start,
      end: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:30`, free: index + 1 }))];
  engine.ingest(snapshot('bulk0001', now - 270_000, slots));
  engine.ingest(snapshot('bulk0002', now - 210_000, [slots[1]]));
  engine.ingest(snapshot('bulk0003', now - 150_000, [slots[1]]));
  engine.ingest(snapshot('bulk0004', now - 90_000, [slots[1]]));
  const page = engine.export().pages[`17|${day}`];
  for (const value of Object.values(page.slots)) {
    if (value.missingSince) value.missingSince = now - 11 * 60_000;
  }
  assert.deepEqual(engine.ingest(snapshot('bulk0005', now - 30_000, slots)), []);
  assert.deepEqual(engine.ingest(snapshot('bulk0006', now, slots)), []);
});

test('a persisted partial calendar without old absence clocks starts a new watch', () => {
  const engine = new SnapshotEngine();
  const anchor = { date: day, start: '08:00', end: '09:30', free: 2 };
  engine.ingest(snapshot('legacy01', now - 240_000, [slot(3), anchor]));
  engine.ingest(snapshot('legacy02', now - 180_000, [anchor]));
  const saved = engine.export();
  const key = `${day}|11:00|12:45`;
  saved.pages[`17|${day}`].slots[key].missingReads = 0;
  saved.pages[`17|${day}`].slots[key].missingSince = null;
  const restored = new SnapshotEngine(saved);
  restored.ingest(snapshot('legacy03', now - 120_000, [anchor]));
  assert.equal(restored.export().pages[`17|${day}`].slots[key].missingReads, 1);
  restored.ingest(snapshot('legacy04', now - 60_000, [anchor]));
  assert.equal(restored.export().pages[`17|${day}`].slots[key].missingReads, 2);
});

test('rejects stale, future, out-of-order and falsely confirmed observations', () => {
  assert.throws(() => normalizeSnapshot(snapshot('refresh21', now - 5 * 60_000 - 1000)), /stale or future/);
  assert.throws(() => normalizeSnapshot(snapshot('refresh22', now + 2 * 60_000 + 1000)), /stale or future/);
  assert.throws(() => normalizeSnapshot({ ...snapshot('refresh23', now), refresh_id: undefined }), /refresh id required/);
  assert.throws(() => normalizeSnapshot({ ...snapshot('refresh24', now), fresh: false }), /passive snapshot/);
  assert.throws(() => normalizeSnapshot(snapshot('refresh27', now, [{ ...slot(3), free: true }])), /invalid free count/);
  const engine = new SnapshotEngine();
  engine.ingest(snapshot('refresh25', now - 1000));
  assert.throws(() => engine.ingest(snapshot('refresh26', now - 2000)), /out-of-order/);
});

test('endBefore applies to the session end, not its start', () => {
  const event = { facility: { id: '17' }, date: day, start: '11:00', end: '12:45' };
  assert.equal(subscriptionMatches({ facilityId: '17', endBefore: '12:00' }, event), false);
  assert.equal(subscriptionMatches({ facilityId: '17', endBefore: '13:00' }, event), true);
});

test('store restricts filter overrides and defers all queued deliveries after rate limit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rez-pilot-test-'));
  try {
    const store = new LocalStore(join(dir, 'state.json'));
    assert.throws(() => store.subscribe(123, 17, { chatId: '999' }), /unsupported filter/);
    assert.throws(() => store.subscribe(123, 17, { date: '2026-02-30' }), /invalid date/);
    assert.throws(() => store.subscribe(123, 17, { startAfter: '25:00' }), /invalid start time/);
    assert.equal(store.subscribe(123, 17, { date: day, startAfter: '09:00' }).chatId, '123');
    const soon = Date.now() + 1000;
    store.state.outbox.push({ id: 'q1', status: 'queued', nextAt: soon });
    store.state.outbox.push({ id: 'q2', status: 'queued', nextAt: soon + 1000 });
    const until = Date.now() + 60_000;
    assert.equal(store.deferQueuedUntil(until), 2);
    assert.deepEqual(store.dueDeliveries(until - 1), []);
    assert.equal(store.dueDeliveries(until).length, 2);
    const old = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
    const recent = new Date().toISOString();
    store.state.outbox.push({ id: 'old', status: 'sent', sentAt: old });
    store.state.outbox.push({ id: 'recent', status: 'sent', sentAt: recent });
    store.save();
    const restored = new LocalStore(join(dir, 'state.json'));
    assert.equal(restored.state.outbox.some(item => item.id === 'old'), false);
    assert.equal(restored.state.outbox.some(item => item.id === 'recent'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
