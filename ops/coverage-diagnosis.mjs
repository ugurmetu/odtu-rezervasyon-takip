import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Reads only the local state. It does not contact ODTÜ or Telegram, and it
// deliberately ignores subscriptions, chat IDs, credentials and outbox text.
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const state = JSON.parse(readFileSync(resolve(project, '.local/state.json'), 'utf8'));
const pages = Object.values(state?.engine?.pages ?? {})
  .filter(page => page && Number.isFinite(Date.parse(page.lastSuccessAt || '')))
  .sort((a, b) => Date.parse(b.lastSuccessAt) - Date.parse(a.lastSuccessAt));
const page = pages[0];
if (!page) {
  console.log('Henüz doğrulanmış takvim okuması yok.');
  process.exit(0);
}

const safeDate = /^\d{4}-\d{2}-\d{2}$/;
const safeTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const date = safeDate.test(page.date || '') ? page.date : '(geçersiz tarih)';
const observed = new Set(Array.isArray(page.observedSlotKeys) ? page.observedSlotKeys : []);
const rows = Object.entries(page.slots ?? {}).flatMap(([key, slot]) => {
  const [slotDate, start, end] = key.split('|');
  if (slotDate !== date || !safeTime.test(start || '') || !safeTime.test(end || '')) return [];
  const confirmed = Number.isSafeInteger(slot?.confirmedFree) && slot.confirmedFree >= 0
    ? slot.confirmedFree : null;
  const missingDate = Number.isFinite(slot?.missingSince) ? new Date(slot.missingSince) : null;
  const since = missingDate && Number.isFinite(missingDate.getTime())
    ? missingDate.toISOString() : null;
  return [{ start, end, visible: observed.has(key), confirmed, since }];
}).sort((a, b) => a.start.localeCompare(b.start));

console.log(`Takvim günü: ${date}; son okuma: ${page.lastSuccessAt}`);
console.log(`Son yanıtta görünen: ${rows.filter(row => row.visible).length}/${rows.length} kayıtlı saat`);
for (const row of rows) {
  const hour = `${row.start}–${row.end}`;
  if (row.visible) {
    console.log(`${hour}: görünüyor; son doğrulanmış boş yer ${row.confirmed ?? '?'}`);
  } else {
    console.log(`${hour}: son yanıtta görünmüyor; eski doğrulanmış boş yer ${row.confirmed ?? '?'}${
      row.since ? `; yokluk sayacı ${row.since} sonrası` : ''}`);
  }
}
console.log('Görünmeyen saatlerin eski sayıları güncel müsaitlik değildir; nedeni bu dosyadan anlaşılamaz.');
