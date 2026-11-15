import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

async function renderStatus(lastStatus, paused = false, pausedReason) {
  const status = { textContent: '', dataset: {} };
  const mode = { textContent: '' };
  const button = { textContent: '', addEventListener() {} };
  const document = { getElementById: id => ({ status, mode, toggle: button })[id] };
  const chrome = { storage: { local: { get: async () => ({ paused, pausedReason, lastStatus }) } }, runtime: {} };
  runInNewContext(readFileSync(new URL('../popup.js', import.meta.url), 'utf8'), {
    document, chrome, Date, setInterval() {}
  });
  await new Promise(resolve => setImmediate(resolve));
  return { text: status.textContent, tone: status.dataset.tone, mode: mode.textContent, button: button.textContent };
}

test('popup does not call an old successful calendar read current', async () => {
  const { text, tone, mode } = await renderStatus({ state: 'ok', detail: 'local_sent',
    at: new Date(Date.now() - 4 * 60_000).toISOString(), facility: 'Baraka', fresh: true, slots: 0 });
  assert.match(text, /Takibin şu anda çalıştığı doğrulanamıyor/);
  assert.doesNotMatch(text, /Güncel takvim yanıtı doğrulandı/);
  assert.doesNotMatch(text, /Takvim yanıtı boş; müsaitlik doğrulanamadı/);
  assert.equal(tone, 'warning');
  assert.equal(mode, 'Kontrol bekleniyor');
});

test('popup shows a recent successful calendar read normally', async () => {
  const { text, tone, mode } = await renderStatus({ state: 'ok', detail: 'local_sent',
    at: new Date(Date.now() - 30_000).toISOString(), facility: 'Baraka', fresh: true, slots: 1 });
  assert.match(text, /Güncel takvim yanıtı doğrulandı/);
  assert.match(text, /Baraka/);
  assert.equal(tone, 'success');
  assert.equal(mode, 'Takip açık');
});

test('popup does not claim availability was confirmed for a fresh empty calendar', async () => {
  const { text, tone } = await renderStatus({ state: 'ok', detail: 'local_sent',
    at: new Date(Date.now() - 30_000).toISOString(), facility: 'Baraka', fresh: true, slots: 0 });
  assert.match(text, /uygun seans bekleniyor/);
  assert.doesNotMatch(text, /Güncel takvim yanıtı doğrulandı/);
  assert.match(text, /Baraka/);
  assert.equal(tone, 'success');
});

test('popup asks the user to select a new day when the old calendar expires', async () => {
  const { text } = await renderStatus({ state: 'calendar_unavailable', detail: 'calendar_date_expired',
    at: new Date().toISOString() });
  assert.match(text, /Takvimdeki gün geçti; yeni günü seçin/);
});

test('popup never presents an unverified ok response as current coverage', async () => {
  const { text, tone, mode } = await renderStatus({ state: 'ok', detail: 'local_sent',
    at: new Date().toISOString(), fresh: false, slots: 1 });
  assert.match(text, /Güncel takvim yanıtı doğrulanamadı/);
  assert.doesNotMatch(text, /Güncel takvim yanıtı doğrulandı/);
  assert.equal(tone, 'warning');
  assert.equal(mode, 'Yeniden deneniyor');
});

test('popup names manual restart when the site halted monitoring', async () => {
  const { text, tone, mode, button } = await renderStatus(null, true, 'site_rate_limited');
  assert.match(text, /Resmî siteyi kontrol ettikten sonra elle başlatabilirsin/);
  assert.equal(tone, 'warning');
  assert.equal(mode, 'İşlem gerekli');
  assert.equal(button, 'Başlat');
});

test('popup distinguishes local receiver outage from a current site reading', async () => {
  const { text, tone, mode } = await renderStatus({ state: 'error',
    detail: 'local_server_unavailable', at: new Date().toISOString() });
  assert.match(text, /site sorgusu bekletiliyor/);
  assert.equal(tone, 'error');
  assert.equal(mode, 'Bağlantı sorunu');
});

test('popup asks for sign-in before manually resuming an expired session', async () => {
  const { text, tone, button } = await renderStatus(null, true, 'login_required');
  assert.match(text, /tekrar giriş yap/);
  assert.match(text, /elle başlatabilirsin/);
  assert.equal(tone, 'warning');
  assert.equal(button, 'Başlat');
});
