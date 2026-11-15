import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalStore } from '../src/store.mjs';
import { flushOutbox, TelegramApi } from '../src/telegram.mjs';

// Send one clearly labelled synthetic vacancy through the real event matcher,
// outbox and Telegram API. Never read or write the running service's state.
if (process.argv.length !== 3 || process.argv[2] !== '--send-to-owner') {
  console.error('Usage: node ops/e2e-delivery-probe.mjs --send-to-owner');
  process.exitCode = 2;
} else {
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const owner = readFileSync(join(project, '.local/owner-chat-id'), 'utf8').trim();
  const token = readFileSync(join(project, '.local/telegram-token'), 'utf8').trim();
  if (!/^\d{1,20}$/.test(owner) || !Number.isSafeInteger(Number(owner))) {
    throw new Error('owner chat id is invalid');
  }
  const temporary = mkdtempSync(join(tmpdir(), 'rez-delivery-probe-'));
  try {
    const code = 'local_synthetic_probe_only_2026';
    const store = new LocalStore(join(temporary, 'state.json'), { betaInviteCode: code });
    store.setFacilityCatalog([{ id: '9999', label: 'SENTETİK TEST TESİSİ', unit: 'Test' }]);
    if (store.approveBetaChat(Number(owner), code) !== 'approved') throw new Error('owner admission failed');
    store.subscribe(owner, '9999', { startAfter: '11:00', endBefore: '12:45' });
    const dateParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    const dateValue = type => dateParts.find(part => part.type === type)?.value;
    const date = `${dateValue('year')}-${dateValue('month')}-${dateValue('day')}`;
    const reading = (free, id, ageMs) => ({
      schema: 1, source: 'rez-calendar-extension', state: 'ok', fresh: true,
      refresh_id: id, observed_at: new Date(Date.now() - ageMs).toISOString(),
      facility: { id: '9999', label: 'SENTETİK TEST TESİSİ' },
      view: { type: 'day', date },
      slots: [{ date, start: '11:00', end: '12:45', free }]
    });
    store.ingest(reading(0, 'synthetic_probe_001', 120_000));
    store.ingest(reading(1, 'synthetic_probe_002', 60_000));
    const events = store.ingest(reading(1, 'synthetic_probe_003', 0));
    if (events.length !== 1 || store.dueDeliveries().length !== 1) {
      throw new Error('synthetic two-read confirmation failed');
    }
    const api = new TelegramApi(token);
    let acceptedMessageId = null;
    await flushOutbox(store, {
      async sendMessage(chatId, message) {
        if (String(chatId) !== owner) throw new Error('unexpected recipient');
        const result = await api.sendMessage(chatId,
          `🧪 SENTETİK UÇTAN UCA TEST — GERÇEK REZERVASYON DEĞİL\n\n${message}\n\nBu mesaj yalnız botun bildirim yolunu sınamak için üretildi. ODTÜ sitesinden veri alınmadı.`);
        acceptedMessageId = result?.message_id ?? null;
      }
    });
    if (store.status().queued !== 0 || store.state.outbox[0]?.status !== 'sent' || !Number.isSafeInteger(acceptedMessageId)) {
      throw new Error('Telegram delivery was not confirmed');
    }
    console.log(`Sentetik uçtan uca bildirim Telegram API tarafından kabul edildi (mesaj ${acceptedMessageId}).`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
