import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stateFile = resolve(project, '.local/state.json');
const traceFile = resolve(project, '.local/slot-trace.ndjson');
const durationMs = 24 * 60 * 60_000;
const intervalMs = 5_000;
const startedAt = Date.now();
const lastRecorded = new Map();

const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const validTime = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const validCount = value => Number.isSafeInteger(value) && value >= 0 && value <= 10_000;

// The live state also contains private Telegram identifiers. Project only
// numeric calendar observations into this 0600 diagnostic file.
export function safeSlotTraceRows(state) {
  const rows = [];
  for (const page of Object.values(state?.engine?.pages ?? {})) {
    const facilityId = String(page?.facility?.id ?? '');
    const date = page?.date;
    const observedAt = page?.lastSuccessAt;
    if (!/^\d{1,4}$/.test(facilityId) || !validDate(date)
      || !Number.isFinite(Date.parse(observedAt || ''))) continue;
    const visible = new Set(Array.isArray(page.observedSlotKeys) ? page.observedSlotKeys : []);
    const slots = [];
    for (const [key, value] of Object.entries(page.slots ?? {})) {
      const [slotDate, start, end, ...extra] = key.split('|');
      if (extra.length || slotDate !== date || !validTime(start) || !validTime(end)
        || !validCount(value?.free) || !validCount(value?.confirmedFree)) continue;
      const pending = ['up', 'down', 'reappeared'].includes(value.pending?.direction)
        ? value.pending.direction : value.pending ? 'up' : null;
      slots.push({ start, end, free: value.free, confirmedFree: value.confirmedFree,
        visible: visible.has(key), pending });
    }
    rows.push({ facilityId, date, observedAt: new Date(observedAt).toISOString(), slots });
  }
  return rows;
}

function sample() {
  let state;
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')); }
  catch (_error) { return; } // A concurrent atomic save is retried next tick.
  for (const row of safeSlotTraceRows(state)) {
    const key = `${row.facilityId}|${row.date}`;
    if (lastRecorded.get(key) === row.observedAt) continue;
    lastRecorded.set(key, row.observedAt);
    appendFileSync(traceFile, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  sample();
  const timer = setInterval(() => {
    sample();
    if (Date.now() - startedAt >= durationMs) clearInterval(timer);
  }, intervalMs);
}
