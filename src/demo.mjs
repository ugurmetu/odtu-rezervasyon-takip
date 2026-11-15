import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeSite } from './fake-site.mjs';
import { startLocalServer } from './server.mjs';
import { flushOutbox } from './telegram.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'rez-pilot-demo-'));
const key = randomBytes(32).toString('hex');
const inviteCode = randomBytes(18).toString('base64url');
const fake = await startFakeSite();
const local = await startLocalServer({ port: 0, key, betaInviteCode: inviteCode,
  stateFile: join(scratch, 'state.json') });
const call = (path, options = {}) => fetch(`${fake.baseUrl}${path}`, options);
let cookie;
const messenger = { sent: [], async sendMessage(chatId, text) { this.sent.push({ chatId, text }); } };

async function ingestFromFake(facilityId, date) {
  const response = await call(`/calendar?facility=${facilityId}`, { headers: { cookie } });
  if (!response.ok) {
    const state = response.status === 401 || response.status === 403 ? 'login_required' : 'calendar_unavailable';
    await fetch(`${local.url}/ingest`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-local-key': key },
      body: JSON.stringify({ schema: 1, source: 'rez-calendar-extension', observed_at: new Date().toISOString(), state })
    });
    return response.status;
  }
  const calendar = await response.json();
  const snapshot = {
    schema: 1, source: 'rez-calendar-extension', observed_at: new Date().toISOString(), state: 'ok',
    fresh: true, refresh_id: randomUUID(),
    facility: { id: facilityId === 'fitness' ? '17' : '21', label: facilityId === 'fitness' ? 'Örnek Spor Salonu' : 'Örnek Yüzme Havuzu' },
    view: { type: 'day', date },
    slots: calendar.sessions.filter(slot => slot.date === date && slot.free > 0).map(slot => ({ date, start: slot.start, end: slot.end, free: slot.free, text: `Boş: ${slot.free}` }))
  };
  const result = await fetch(`${local.url}/ingest`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-local-key': key }, body: JSON.stringify(snapshot)
  });
  if (!result.ok) throw new Error(`local ingest failed: ${result.status}`);
  return result.status;
}

try {
  const login = await call('/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'demo', password: 'demo' }) });
  if (!login.ok) throw new Error('synthetic login failed');
  cookie = login.headers.get('set-cookie').split(';')[0];
  // The demo has no real Telegram token. Explicitly configure the same closed
  // beta and curated catalog gates that a deployed bot uses.
  local.store.setFacilityCatalog([
    { id: '17', label: 'Örnek Spor Salonu', unit: 'Spor Müdürlüğü' },
    { id: '21', label: 'Örnek Yüzme Havuzu', unit: 'Havuz Müdürlüğü' }
  ]);
  if (local.store.approveBetaChat('123456', inviteCode) !== 'approved') {
    throw new Error('synthetic chat was not admitted');
  }
  local.store.subscribe('123456', '17');
  await ingestFromFake('fitness', '2026-10-19');
  if (local.store.dueDeliveries().length) throw new Error('baseline sent an alert');

  const sessions = fake.state.getSessions('fitness');
  sessions[1].free = 2;
  fake.state.setSessions('fitness', sessions);
  await ingestFromFake('fitness', '2026-10-19');
  if (local.store.dueDeliveries().length) throw new Error('unconfirmed change sent an alert');
  await ingestFromFake('fitness', '2026-10-19');
  await flushOutbox(local.store, messenger);
  if (messenger.sent.length !== 1) throw new Error(`expected one fake Telegram message; got ${messenger.sent.length}`);

  fake.state.expireSession();
  if (await ingestFromFake('fitness', '2026-10-19') !== 401) throw new Error('session expiry was not detected');
  fake.state.setAuthMode('turnstile');
  if (await ingestFromFake('fitness', '2026-10-19') !== 403) throw new Error('Turnstile was not detected');
  if (messenger.sent.length !== 1) throw new Error('error state sent an alert');
  const bookingWrites = fake.state.requestLog.filter(item => item.method === 'POST' && /reservation/.test(item.path));
  if (bookingWrites.length) throw new Error('booking write was attempted');
  console.log('Yerel demo geçti: giriş, iki okumayla değişim, sahte Telegram, oturum düşmesi, Turnstile, rezervasyon yazmama.');
} finally {
  await local.close();
  await fake.close();
  rmSync(scratch, { recursive: true, force: true });
}
