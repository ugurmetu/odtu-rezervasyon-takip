import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { LocalStore } from '../src/store.mjs';

// Offline routing probe. It never reads .local, contacts the site or calls Telegram.
function tomorrowInIstanbul(now = Date.now()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(now)).filter(part => part.type !== 'literal')
    .map(part => [part.type, part.value]));
  const day = new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

for (const count of [100, 1_000, 5_000]) {
  const directory = mkdtempSync(join(tmpdir(), 'rez-scale-probe-'));
  try {
    const path = join(directory, 'state.json');
    const store = new LocalStore(path, { betaInviteCode: 'synthetic_only_2026' });
    store.setFacilityCatalog([{ id: '17', label: 'Sentetik spor tesisi', unit: 'Spor Müdürlüğü' }]);
    store.subscribe('1000000001', '17');
    const template = store.state.subscriptions[0];
    store.state.betaApprovedChatIds = [];
    store.state.subscriptions = [];
    for (let index = 0; index < count; index++) {
      const chatId = String(1000000001 + index);
      store.state.betaApprovedChatIds.push(chatId);
      store.state.subscriptions.push({ ...template, chatId });
    }
    const date = tomorrowInIstanbul();
    const base = Date.now();
    const observation = (free, sequence) => ({
      schema: 1, source: 'rez-calendar-extension', state: 'ok', fresh: true,
      refresh_id: `synthetic_${count}_${sequence}`,
      observed_at: new Date(base + sequence * 1_000).toISOString(),
      facility: { id: '17', label: 'Sentetik spor tesisi' },
      view: { type: 'day', date },
      slots: [{ date, start: '11:00', end: '12:45', free }]
    });
    store.ingest(observation(0, 0));
    store.ingest(observation(1, 1));
    const start = performance.now();
    const events = store.ingest(observation(1, 2));
    const elapsedMs = Math.round(performance.now() - start);
    const queued = store.status().queued;
    if (events.length !== 1 || queued !== count) {
      throw new Error(`routing mismatch for ${count} synthetic subscribers`);
    }
    console.log(JSON.stringify({ subscribers: count, queued, matchAndSaveMs: elapsedMs,
      stateMiB: Number((statSync(path).size / 1048576).toFixed(2)) }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// The current outbox persists the whole JSON state after every Telegram
// result. Measure this separately from matching; keep the sample bounded so
// the probe itself does not write gigabytes on the user's Mac.
for (const count of [100, 500, 1_000]) {
  const directory = mkdtempSync(join(tmpdir(), 'rez-delivery-probe-'));
  try {
    const path = join(directory, 'state.json');
    const store = new LocalStore(path, { betaInviteCode: 'synthetic_only_2026' });
    const observedAt = new Date().toISOString();
    store.state.outbox = Array.from({ length: count }, (_, index) => ({
      id: `synthetic-${index}`, chatId: String(1_000_000_000 + index),
      status: 'queued', attempts: 0, nextAt: Date.now() - 1,
      event: { facility: { id: '17', label: 'Sentetik spor tesisi' },
        date: '2099-10-19', start: '11:00', end: '12:45', free: 1, observedAt }
    }));
    store.save();
    const initialBytes = statSync(path).size;
    const start = performance.now();
    for (let index = 0; index < count; index++) {
      store.beginDelivery(`synthetic-${index}`);
      store.markDelivery(`synthetic-${index}`, { ok: true });
    }
    console.log(JSON.stringify({ deliveryResults: count,
      initialStateMiB: Number((initialBytes / 1048576).toFixed(2)),
      persistAllResultsMs: Math.round(performance.now() - start) }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
