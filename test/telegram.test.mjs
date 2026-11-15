import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../src/store.mjs';
import { flushOutbox, formatAvailability, handleBotCallback, handleBotCommand, pollRetryDelayMs, runTelegramLoop } from '../src/telegram.mjs';

test('a returning session alert describes the observed appearance without claiming a cancellation', () => {
  const message = formatAvailability({ kind: 'reappeared', facility: { label: 'Baraka Fitness' },
    date: '2026-10-19', start: '11:00', end: '12:45', free: 1 });
  assert.match(message, /seans yeniden göründü/);
  assert.match(message, /Son kontrolde boş yer: 1/);
  assert.doesNotMatch(message, /iptal/);
});

test('Telegram polling backs off during outages and honors a server retry interval', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(failures => pollRetryDelayMs(failures)),
    [5_000, 10_000, 20_000, 30_000, 30_000]);
  assert.equal(pollRetryDelayMs(2, 60_000), 60_000);
  assert.equal(pollRetryDelayMs(0, -1), 5_000);
});

function callback(data, chatId = 123) {
  return { id: 'test-callback', from: { id: chatId }, message: { message_id: 9, chat: { id: chatId, type: 'private' } }, data };
}

const buttonData = reply => reply.replyMarkup?.inline_keyboard.flat().map(item => item.callback_data) || [];
const TEST_INVITE_CODE = 'test_only_invite_code_2026';
const futureTestDay = () => new Date(Date.now() + 48 * 60 * 60_000).toISOString().slice(0, 10);

function admittedStore(file) {
  const store = new LocalStore(file, { betaInviteCode: TEST_INVITE_CODE });
  store.setFacilityCatalog([{ id: '17', label: 'Baraka Fitness', unit: 'Spor Müdürlüğü' }]);
  for (const chatId of [123, 456, 111, 222, 123456789]) {
    assert.equal(store.approveBetaChat(chatId, TEST_INVITE_CODE), 'approved');
  }
  return store;
}

test('one fresh calendar serves each matching private chat once without notifying unrelated hours', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-two-chat-delivery-'));
  try {
    const store = admittedStore(join(folder, 'state.json'));
    store.replaceFacilityFilters(123, '17', [
      { startAfter: '09:00', endBefore: '10:00' },
      { startAfter: '06:00', endBefore: '12:00' }
    ]);
    store.replaceFacilityFilters(456, '17', [{ startAfter: '17:00', endBefore: '18:00' }]);
    store.replaceFacilityFilters(111, '17', [{ startAfter: '12:00', endBefore: '14:00' }]);
    const date = '2099-10-19';
    const snapshot = (id, free) => ({
      schema: 1, source: 'rez-calendar-extension', state: 'ok', fresh: true,
      observed_at: new Date().toISOString(), refresh_id: id,
      facility: { id: '17', label: 'Baraka Fitness' },
      view: { type: 'day', date },
      slots: [
        { date, start: '09:00', end: '10:00', free },
        { date, start: '17:00', end: '18:00', free }
      ]
    });
    assert.deepEqual(store.ingest(snapshot('sharedread01', 0)), []);
    assert.deepEqual(store.ingest(snapshot('sharedread02', 1)), []);
    assert.equal(store.ingest(snapshot('sharedread03', 1)).length, 2);
    assert.equal(store.status().queued, 2);
    const sent = [];
    await flushOutbox(store, { sendMessage: async (chatId, message) => {
      sent.push({ chatId: String(chatId), message });
      return { ok: true };
    } });
    assert.deepEqual(sent.map(item => item.chatId).sort(), ['123', '456']);
    assert.match(sent.find(item => item.chatId === '123').message, /09:00–10:00/);
    assert.match(sent.find(item => item.chatId === '456').message, /17:00–18:00/);
    assert.equal(store.status().queued, 0);
    assert.deepEqual(store.ingest(snapshot('sharedread04', 1)), []);
    assert.equal(store.state.outbox.filter(item => item.status === 'sent').length, 2);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('every submenu offers an explicit way back to the main menu', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-telegram-navigation-test-'));
  try {
    const store = admittedStore(join(folder, 'state.json'));
    store.setFacilityCatalog([{ id: '17', label: 'Baraka Fitness', unit: 'Spor Müdürlüğü' }]);
    store.subscribe(123, '17');
    const units = handleBotCallback(store, callback('u'));
    const unitCode = buttonData(units).find(data => data.startsWith('u:'));
    const submenus = [
      units,
      handleBotCallback(store, callback(unitCode)),
      handleBotCallback(store, callback('t:17')),
      handleBotCallback(store, callback('p')),
      handleBotCallback(store, callback('s')),
      handleBotCallback(store, callback('c')),
      handleBotCommand(store, { chat: { id: 123, type: 'private' }, text: '/test' }),
      handleBotCommand(store, { chat: { id: 123, type: 'private' }, text: '/izle' })
    ];
    for (const reply of submenus) assert.ok(buttonData(reply).includes('h'), reply.text);
    const home = handleBotCallback(store, callback('h'));
    assert.ok(buttonData(home).includes('settings'));
    assert.ok(buttonData(handleBotCallback(store, callback('settings'))).includes('c'));
    assert.match(home.text, /ODTÜ Rezervasyon Takip/);
    assert.match(home.text, /ODTÜ'nün resmî botu değildir/);
    assert.match(handleBotCommand(store, { chat: { id: 123, type: 'private' }, text: '/menu' }).text,
      /ODTÜ Rezervasyon Takip/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('support screen uses a configured address, explains reply behavior, and never invents a contact', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-telegram-support-test-'));
  const original = process.env.REZ_SUPPORT_EMAIL;
  try {
    const store = admittedStore(join(folder, 'state.json'));
    delete process.env.REZ_SUPPORT_EMAIL;
    const unset = handleBotCommand(store, { chat: { id: 123, type: 'private' }, text: '/destek' });
    assert.match(unset.text, /henüz ayarlanmadı/);
    assert.match(unset.text, /serbest mesajlar destek ekibine iletilmez/);
    assert.ok(buttonData(unset).includes('h'));
    process.env.REZ_SUPPORT_EMAIL = 'pilot@example.edu';
    const configured = handleBotCallback(store, callback('c'));
    assert.match(configured.text, /pilot@example\.edu/);
    assert.equal(configured.editMessageId, 9);
    assert.ok(buttonData(configured).includes('h'));
    process.env.REZ_SUPPORT_EMAIL = 'fake@example.edu\nFake official reply';
    const invalid = handleBotCommand(store, { chat: { id: 123, type: 'private' }, text: '/destek' });
    assert.match(invalid.text, /henüz ayarlanmadı/);
    assert.equal(invalid.text.includes('Fake official reply'), false);
  } finally {
    if (original === undefined) delete process.env.REZ_SUPPORT_EMAIL;
    else process.env.REZ_SUPPORT_EMAIL = original;
    rmSync(folder, { recursive: true, force: true });
  }
});

test('free text and unknown commands explain how to reach support instead of silently discarding them', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-telegram-unrecognized-test-'));
  try {
    const store = admittedStore(join(folder, 'state.json'));
    const message = text => handleBotCommand(store, { chat: { id: 123, type: 'private' }, text });
    assert.match(message('Yardım eder misiniz?').text, /serbest mesajları destek talebine dönüştürmez/);
    assert.ok(buttonData(message('Yardım eder misiniz?')).includes('settings'));
    assert.match(message('/bilinmeyen').text, /Bu komutu tanımıyorum/);
    assert.ok(buttonData(message('/bilinmeyen')).includes('h'));
    assert.equal(message(''), null);
    assert.equal(handleBotCommand(store, { chat: { id: 123, type: 'group' }, text: '/destek' }), null);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the invite gate admits only invited private chats without persisting the code', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-beta-gate-test-'));
  try {
    const file = join(folder, 'state.json');
    const inviteCode = 'test_only_invite_code_2026';
    const store = new LocalStore(file, { betaInviteCode: inviteCode });
    assert.match(handleBotCommand(store, { chat: { id: 123, type: 'private' }, text: '/start' }).text, /yalnız davetli/);
    assert.equal(handleBotCommand(store, { chat: { id: 123, type: 'private' }, text: '/test' }), null);
    assert.equal(handleBotCallback(store, callback('a:17')), null);
    assert.equal(handleBotCommand(store, { chat: { id: 456, type: 'private' }, text: '/start wrong_code' }).text.includes(inviteCode), false);
    assert.match(handleBotCommand(store, { chat: { id: 123, type: 'private' }, text: `/start ${inviteCode}` }).text, /rezervasyon garantisi değildir/);
    assert.equal(store.isChatAllowed(123), true);
    assert.equal(store.isChatAllowed(456), false);
    assert.equal(readFileSync(file, 'utf8').includes(inviteCode), false);
    assert.equal(new LocalStore(file, { betaInviteCode: inviteCode }).isChatAllowed(123), true);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('missing invite configuration denies even previously approved chats and queued deliveries', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-beta-missing-code-'));
  try {
    const file = join(folder, 'state.json');
    const admitted = admittedStore(file);
    admitted.subscribe(123, '17');
    admitted.state.outbox.push({ id: 'old-alert', chatId: '123', status: 'queued', attempts: 0,
      nextAt: Date.now() - 1, event: { facility: { id: '17', label: 'Baraka Fitness' },
        date: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
        start: '11:00', end: '12:45', free: 1,
        observedAt: new Date().toISOString() } });
    admitted.save();
    const withoutCode = new LocalStore(file);
    assert.equal(withoutCode.isChatAllowed(123), false);
    assert.match(handleBotCommand(withoutCode,
      { chat: { id: 123, type: 'private' }, text: '/start' }).text, /yalnız davetli/);
    assert.equal(handleBotCallback(withoutCode, callback('a:17')), null);
    const sent = [];
    await flushOutbox(withoutCode, { async sendMessage(...args) { sent.push(args); } });
    assert.deepEqual(sent, []);
    assert.equal(withoutCode.state.outbox[0].reason, 'chat_not_approved');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('old subscriptions do not grant beta access, while explicit approvals survive unsubscription and restart', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-beta-existing-test-'));
  try {
    const file = join(folder, 'state.json');
    new LocalStore(file).subscribe(123, '17');
    const closed = new LocalStore(file, { betaInviteCode: 'test_only_invite_code_2026' });
    assert.equal(closed.isChatAllowed(123), false);
    assert.match(handleBotCommand(closed, { chat: { id: 123, type: 'private' }, text: '/start' }).text, /yalnız davetli/);
    assert.equal(closed.approveBetaChat(123, TEST_INVITE_CODE), 'approved');
    closed.unsubscribe(123, '17');
    assert.equal(closed.isChatAllowed(123), true);
    assert.equal(closed.isChatAllowed(456), false);
    assert.equal(new LocalStore(file, { betaInviteCode: TEST_INVITE_CODE }).isChatAllowed(123), true);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('closed beta enforces its configured cap and gives valid excess invites a capacity message', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-beta-cap-test-'));
  try {
    const file = join(folder, 'state.json');
    const inviteCode = 'test_only_invite_code_2026';
    new LocalStore(file).subscribe(111, '17');
    const store = new LocalStore(file, { betaInviteCode: inviteCode, betaMaxChats: 3 });
    const requestInvite = (chatId, code = inviteCode) => handleBotCommand(store,
      { chat: { id: chatId, type: 'private' }, text: `/start ${code}` });
    assert.equal(store.isChatAllowed(111), false);
    assert.match(requestInvite(111).text, /rezervasyon garantisi değildir/);
    assert.match(requestInvite(222).text, /rezervasyon garantisi değildir/);
    assert.match(requestInvite(333).text, /rezervasyon garantisi değildir/);
    assert.match(requestInvite(444).text, /Davetli kullanıcı sınırına ulaşıldı/);
    assert.equal(store.isChatAllowed(444), false);
    assert.match(requestInvite(555, 'wrong_code').text, /yalnız davetli/);
    assert.equal(store.isChatAllowed(111), true);
    assert.equal(store.isChatAllowed(222), true);
    assert.equal(store.isChatAllowed(333), true);
    assert.equal(new LocalStore(file, { betaInviteCode: inviteCode, betaMaxChats: 2 }).isChatAllowed(333), true);
    assert.equal(readFileSync(file, 'utf8').includes(inviteCode), false);
    assert.throws(() => new LocalStore(file, { betaInviteCode: inviteCode, betaMaxChats: 7 }), /invalid beta chat limit/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('test delivery is limited per chat across command and button while other chats can test', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-beta-test-limit-'));
  try {
    const store = admittedStore(join(folder, 'state.json'));
    const command = chatId => handleBotCommand(store, { chat: { id: chatId, type: 'private' }, text: '/test' });
    assert.equal(command(123).kind, 'test');
    const cooldownCommand = command(123);
    assert.match(cooldownCommand.text, /bir dakika bekle/);
    assert.notEqual(cooldownCommand.kind, 'test');
    const cooldownButton = handleBotCallback(store, callback('test', 123));
    assert.match(cooldownButton.text, /bir dakika bekle/);
    assert.equal(cooldownButton.editMessageId, 9);
    assert.ok(buttonData(cooldownButton).includes('h'));
    assert.equal(command(456).kind, 'test');
    store.lastTestAt.set('123', Date.now() - 60_000);
    assert.equal(handleBotCallback(store, callback('test', 123)).kind, 'test');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('one observed vacancy can notify two private chats without additional site polling', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-beta-two-chats-'));
  try {
    const store = admittedStore(join(folder, 'state.json'));
    store.subscribe(123, '17');
    store.subscribe(456, '17');
    const day = futureTestDay();
    const observedAt = [120_000, 60_000, 0].map(ms => new Date(Date.now() - ms).toISOString());
    const snapshot = (free, refreshId, at) => ({ schema: 1, source: 'rez-calendar-extension', state: 'ok',
      observed_at: at, fresh: true, refresh_id: refreshId,
      facility: { id: '17', label: 'Baraka Fitness' }, view: { type: 'day', date: day },
      slots: [{ date: day, start: '11:00', end: '12:45', free }] });
    assert.equal(store.ingest(snapshot(0, 'refresh001', observedAt[0])).length, 0);
    assert.equal(store.ingest(snapshot(1, 'refresh002', observedAt[1])).length, 0);
    assert.equal(store.ingest(snapshot(1, 'refresh003', observedAt[2])).length, 1);
    assert.equal(store.dueDeliveries().length, 2);
    const sent = [];
    await flushOutbox(store, { async sendMessage(chatId, message) { sent.push({ chatId, message }); } });
    assert.deepEqual(sent.map(item => item.chatId).sort(), ['123', '456']);
    assert.equal(sent[0].message, sent[1].message);
    assert.equal(store.status().queued, 0);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a confirmed returning session reaches only its subscribed chat and sends once', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-beta-returning-session-'));
  try {
    const store = admittedStore(join(folder, 'state.json'));
    store.subscribe(123, '17', { startAfter: '11:00', endBefore: '12:45' });
    store.subscribe(456, '17', { startAfter: '15:00', endBefore: '16:45' });
    const day = futureTestDay();
    const current = Date.now();
    const first = { date: day, start: '11:00', end: '12:45', free: 0 };
    const other = { date: day, start: '15:00', end: '16:45', free: 3 };
    const reading = (id, offset, slots) => ({
      schema: 1, source: 'rez-calendar-extension', state: 'ok', fresh: true,
      refresh_id: id, observed_at: new Date(current + offset).toISOString(),
      facility: { id: '17', label: 'Baraka Fitness' }, view: { type: 'day', date: day }, slots
    });
    store.ingest(reading('return0001', -240_000, [first, other]));
    store.ingest(reading('return0002', -180_000, [other]));
    store.ingest(reading('return0003', -120_000, [other]));
    store.ingest(reading('return0004', -60_000, [other]));
    const key = `${day}|11:00|12:45`;
    store.engine.pages[`17|${day}`].slots[key].missingSince = current - 11 * 60_000;
    assert.equal(store.ingest(reading('return0005', -30_000,
      [{ ...first, free: 1 }, other])).length, 0);
    assert.equal(store.ingest(reading('return0006', 0,
      [{ ...first, free: 1 }, other])).length, 1);
    assert.equal(store.dueDeliveries().length, 1);
    const sent = [];
    await flushOutbox(store, { async sendMessage(chatId, message) { sent.push({ chatId, message }); } });
    assert.deepEqual(sent.map(item => item.chatId), ['123']);
    assert.match(sent[0].message, /seans yeniden göründü/);
    assert.doesNotMatch(sent[0].message, /iptal/);
    assert.equal(store.status().queued, 0);
    store.ingest(reading('return0007', 1000, [{ ...first, free: 1 }, other]));
    assert.equal(store.dueDeliveries().length, 0);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('curated catalog owns names and unknown page facilities cannot reach menus or alerts', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-catalog-authority-'));
  try {
    const file = join(folder, 'state.json');
    const store = admittedStore(file);
    store.subscribe(123, '17');
    const snapshot = (id, label, free, refreshId) => ({
      schema: 1, source: 'rez-calendar-extension', state: 'ok',
      observed_at: new Date().toISOString(), fresh: true, refresh_id: refreshId,
      facility: { id, label }, view: { type: 'day', date: futureTestDay() },
      slots: [{ date: futureTestDay(), start: '11:00', end: '12:45', free }]
    });
    assert.equal(store.ingest(snapshot('99', 'Sahte Yeni Tesis', 1, 'unknown001')).length, 0);
    assert.equal(store.status().lastDiagnostic, 'unknown_facility');
    assert.equal(store.availableFacilities().some(item => item.id === '99'), false);
    assert.equal(store.engine.pages[`99|${futureTestDay()}`], undefined);
    assert.equal(store.ingest(snapshot('17', 'Sahte Eski Ad', 0, 'known0001')).length, 0);
    assert.equal(store.ingest(snapshot('17', 'Sahte Eski Ad', 1, 'known0002')).length, 0);
    assert.equal(store.ingest(snapshot('17', 'Sahte Eski Ad', 1, 'known0003')).length, 1);
    assert.equal(store.engine.pages[`17|${futureTestDay()}`].facility.label, 'Baraka Fitness');
    assert.deepEqual(store.availableFacilities().map(item => item.label), ['Baraka Fitness']);
    const sent = [];
    await flushOutbox(store, { async sendMessage(chatId, text) { sent.push({ chatId, text }); } });
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Baraka Fitness/);
    assert.doesNotMatch(sent[0].text, /Sahte/);
    const restored = new LocalStore(file, { betaInviteCode: TEST_INVITE_CODE });
    assert.deepEqual(restored.availableFacilities().map(item => item.label), ['Baraka Fitness']);
    assert.equal(restored.isChatAllowed(123), true);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('an unsubscribe during one send cancels later alerts from the same queued batch', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-telegram-cancel-batch-'));
  try {
    const store = admittedStore(join(folder, 'state.json'));
    store.subscribe(123, '17');
    const event = { facility: { id: '17', label: 'Örnek Spor Salonu' }, date: futureTestDay(),
      start: '11:00', end: '12:45', free: 2, observedAt: new Date().toISOString() };
    const laterEvent = { ...event, start: '13:00', end: '14:45' };
    store.state.outbox.push(
      { id: 'first', chatId: '123', event, attempts: 0, nextAt: Date.now() - 1, status: 'queued' },
      { id: 'second', chatId: '123', event: laterEvent, attempts: 0, nextAt: Date.now() - 1, status: 'queued' }
    );
    store.save();
    const sent = [];
    await flushOutbox(store, { async sendMessage(chatId) {
      sent.push(chatId);
      if (sent.length === 1) store.unsubscribe(123, '17');
    } });
    assert.deepEqual(sent, ['123']);
    assert.equal(store.subscriptionsFor(123).length, 0);
    assert.equal(store.status().queued, 0);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('bot accepts only private commands and a 429 pauses all queued messages', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-telegram-test-'));
  try {
    const store = admittedStore(join(folder, 'state.json'));
    assert.equal(handleBotCommand(store, { chat: { id: 123, type: 'group' }, text: '/start' }), null);
    assert.match(handleBotCommand(store, { chat: { id: 123, type: 'private' }, text: '/start' }).text, /rezervasyon garantisi değildir/);
    const event = { facility: { id: '17', label: 'Örnek Spor Salonu' }, date: futureTestDay(), start: '11:00', end: '12:45', free: 2 };
    store.state.outbox.push(
      { id: 'one', chatId: '123', event, attempts: 0, nextAt: Date.now() - 1, status: 'queued' },
      { id: 'two', chatId: '456', event, attempts: 0, nextAt: Date.now() - 1, status: 'queued' }
    );
    const attempts = [];
    const api = { async sendMessage(chatId) {
      attempts.push(chatId);
      const error = new Error('rate limit');
      error.status = 429;
      error.retryAfterMs = 60_000;
      throw error;
    } };
    assert.equal(await flushOutbox(store, api), 1);
    assert.deepEqual(attempts, ['123']);
    assert.deepEqual(store.dueDeliveries(), []);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a 429-delayed vacancy is not sent when a later partial calendar omits its session', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-telegram-revoked-after-429-'));
  try {
    const store = admittedStore(join(folder, 'state.json'));
    const date = futureTestDay();
    const observedAt = new Date(Date.now() - 20_000).toISOString();
    store.state.outbox.push({ id: 'delayed-vacancy', chatId: '123', attempts: 0,
      nextAt: Date.now() - 1, status: 'queued', event: {
        facility: { id: '17', label: 'Baraka Fitness' }, date,
        start: '11:00', end: '12:45', free: 2, observedAt
      } });
    let attempted = 0;
    await flushOutbox(store, { async sendMessage() {
      attempted++;
      const error = new Error('rate limit');
      error.status = 429;
      error.retryAfterMs = 60_000;
      throw error;
    } });
    assert.equal(attempted, 1);
    assert.equal(store.status().queued, 1);

    store.ingest({ schema: 1, source: 'rez-calendar-extension', state: 'ok',
      observed_at: new Date().toISOString(), fresh: true, refresh_id: 'partialAfter429',
      facility: { id: '17', label: 'Baraka Fitness' }, view: { type: 'day', date },
      slots: [{ date, start: '13:00', end: '14:45', free: 1 }] });
    assert.equal(store.state.outbox[0].status, 'cancelled');
    store.state.outbox[0].nextAt = Date.now() - 1;
    const sent = [];
    assert.equal(await flushOutbox(store, { async sendMessage(...args) { sent.push(args); } }), 0);
    assert.deepEqual(sent, []);
    assert.equal(store.status().failed, 0);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('bot health confirms polling and a reply without exposing the chat identifier', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-telegram-health-test-'));
  try {
    const store = admittedStore(join(folder, 'state.json'));
    store.setTelegramConfigured(true);
    const controller = new AbortController();
    const sent = [];
    const api = {
      async getUpdates() {
        return [{ update_id: 1, message: { chat: { id: 123456789, type: 'private' }, text: '/start' } }];
      },
      async sendMessage(chatId, text) {
        sent.push({ chatId, text });
        controller.abort();
      }
    };
    await runTelegramLoop(store, api, controller.signal);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, 123456789);
    assert.match(sent[0].text, /rezervasyon garantisi değildir/);
    const health = store.status().telegram;
    assert.equal(health.configured, true);
    assert.match(health.lastPollAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(health.lastReplyAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(health.lastAvailabilityDeliveryAt, null);
    assert.equal(JSON.stringify(health).includes('123456789'), false);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('unapproved Telegram bursts persist one offset per batch, including across restart', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-telegram-unapproved-burst-'));
  try {
    const file = join(folder, 'state.json');
    const store = admittedStore(file);
    const originalSave = store.save.bind(store);
    let writes = 0;
    store.save = () => { writes++; originalSave(); };
    const controller = new AbortController();
    let polls = 0;
    const api = {
      async getUpdates() {
        if (++polls === 1) return Array.from({ length: 50 }, (_, index) => ({
          update_id: index + 1,
          message: { chat: { id: 987654321, type: 'private' }, text: 'hello' }
        }));
        controller.abort();
        return [];
      },
      async sendMessage() { assert.fail('Unapproved chat must not receive a reply'); }
    };
    await runTelegramLoop(store, api, controller.signal);
    assert.equal(writes, 1);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).telegramOffset, 51);
    assert.equal(new LocalStore(file, { betaInviteCode: TEST_INVITE_CODE }).state.telegramOffset, 51);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('an approved update still persists its cursor within a mixed batch', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-telegram-mixed-batch-'));
  try {
    const file = join(folder, 'state.json');
    const store = admittedStore(file);
    const originalSave = store.save.bind(store);
    let writes = 0;
    store.save = () => { writes++; originalSave(); };
    const controller = new AbortController();
    let polls = 0;
    const api = {
      async getUpdates() {
        if (++polls === 1) return [
          { update_id: 1, message: { chat: { id: 987654321, type: 'private' }, text: 'hello' } },
          { update_id: 2, message: { chat: { id: 123, type: 'private' }, text: '/menu' } },
          { update_id: 3, message: { chat: { id: 987654321, type: 'private' }, text: 'hello again' } }
        ];
        controller.abort();
        return [];
      },
      async sendMessage() {}
    };
    await runTelegramLoop(store, api, controller.signal);
    assert.equal(writes, 2);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).telegramOffset, 4);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('rapid single-message polls do not write the full state for every unapproved update', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-telegram-unapproved-polls-'));
  try {
    const file = join(folder, 'state.json');
    const store = admittedStore(file);
    const originalSave = store.save.bind(store);
    let writes = 0;
    store.save = () => { writes++; originalSave(); };
    const controller = new AbortController();
    let polls = 0;
    const api = {
      async getUpdates() {
        if (++polls <= 20) return [{ update_id: polls,
          message: { chat: { id: 987654321, type: 'private' }, text: 'hello' } }];
        controller.abort();
        return [];
      },
      async sendMessage() { assert.fail('Unapproved chat must not receive a reply'); }
    };
    await runTelegramLoop(store, api, controller.signal);
    assert.ok(writes <= 2, `Expected no more than two writes, got ${writes}`);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).telegramOffset, 21);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('successful availability delivery records a distinct health timestamp', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-telegram-delivery-test-'));
  try {
    const store = admittedStore(join(folder, 'state.json'));
    const event = { facility: { id: '17', label: 'Örnek Spor Salonu' }, date: futureTestDay(), start: '11:00', end: '12:45', free: 2 };
    store.state.outbox.push({ id: 'test-event', chatId: '123', event, attempts: 0, nextAt: Date.now() - 1, status: 'queued' });
    const sent = [];
    await flushOutbox(store, { async sendMessage(chatId, text) { sent.push({ chatId, text }); } });
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Son kontrolde boş yer: 2/);
    assert.match(store.status().telegram.lastAvailabilityDeliveryAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(store.status().queued, 0);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a permanently blocked chat does not prevent other bot commands', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-telegram-blocked-test-'));
  try {
    const store = admittedStore(join(folder, 'state.json'));
    const controller = new AbortController();
    const api = {
      async getUpdates() {
        return [
          { update_id: 10, message: { chat: { id: 111, type: 'private' }, text: '/start' } },
          { update_id: 11, message: { chat: { id: 222, type: 'private' }, text: '/start' } }
        ];
      },
      async sendMessage(chatId) {
        if (chatId === 111) {
          const error = new Error('blocked');
          error.status = 403;
          throw error;
        }
        controller.abort();
      }
    };
    await runTelegramLoop(store, api, controller.signal);
    assert.equal(store.state.telegramOffset, 12);
    assert.match(store.status().telegram.lastReplyAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a transient menu delivery failure does not block later vacancy messages', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-telegram-reply-failure-test-'));
  try {
    const store = admittedStore(join(folder, 'state.json'));
    const event = { facility: { id: '17', label: 'Örnek Spor Salonu' }, date: '2026-10-19', start: '11:00', end: '12:45', free: 1 };
    store.state.outbox.push({ id: 'vacancy', chatId: '222', event, attempts: 0,
      nextAt: Date.now() - 1, status: 'queued' });
    const controller = new AbortController();
    const delivered = [];
    let polls = 0;
    const api = {
      async getUpdates() {
        polls++;
        return polls === 1
          ? [{ update_id: 20, message: { chat: { id: 111, type: 'private' }, text: '/start' } }]
          : [];
      },
      async sendMessage(chatId, text) {
        if (chatId === 111) {
          const error = new Error('temporary error');
          error.status = 502;
          throw error;
        }
        delivered.push({ chatId, text });
        controller.abort();
      }
    };
    await runTelegramLoop(store, api, controller.signal);
    assert.equal(store.state.telegramOffset, 21);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].chatId, '222');
    assert.match(delivered[0].text, /yer göründü/);
    assert.equal(store.status().telegram.lastError, 'http_502');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('menu reply 429 limits that chat without delaying another chat vacancy', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-telegram-menu-rate-limit-'));
  try {
    const store = admittedStore(join(folder, 'state.json'));
    store.state.outbox.push({ id: 'vacancy', chatId: '222', status: 'queued', attempts: 0,
      nextAt: Date.now() - 1,
      event: { facility: { id: '17', label: 'Untrusted Page Name' }, date: '2026-10-19',
        start: '11:00', end: '12:45', free: 1, observedAt: new Date().toISOString() } });
    const controller = new AbortController();
    const delivered = [];
    let polls = 0;
    const api = {
      async getUpdates() {
        return ++polls === 1
          ? [{ update_id: 1, message: { chat: { id: 111, type: 'private' }, text: '/start' } }]
          : [];
      },
      async sendMessage(chatId, text) {
        if (chatId === 111) {
          const error = new Error('menu rate limited');
          error.status = 429;
          error.retryAfterMs = 60_000;
          throw error;
        }
        delivered.push({ chatId, text });
        controller.abort();
      }
    };
    await runTelegramLoop(store, api, controller.signal);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].chatId, '222');
    assert.match(delivered[0].text, /Baraka Fitness/);
    assert.equal(store.status().queued, 0);
    assert.equal(store.canSendMenuReply(111), false);
    assert.equal(store.canSendMenuReply(222), true);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('menu reply rate limit is per chat and resets after its window', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-telegram-menu-burst-'));
  try {
    const store = admittedStore(join(folder, 'state.json'));
    const now = Date.now();
    for (let i = 0; i < 12; i++) assert.equal(store.canSendMenuReply(123, now + i), true);
    assert.equal(store.canSendMenuReply(123, now + 12), false);
    assert.equal(store.canSendMenuReply(456, now + 12), true);
    assert.equal(store.canSendMenuReply(123, now + 10_001), true);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a failed first Telegram update poll does not strand outgoing alerts', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-telegram-poll-failure-'));
  try {
    const store = admittedStore(join(folder, 'state.json'));
    const event = { facility: { id: '17', label: 'Örnek Spor Salonu' }, date: '2026-10-19',
      start: '11:00', end: '12:45', free: 1, observedAt: new Date().toISOString() };
    store.state.outbox.push({ id: 'vacancy', chatId: '222', event, attempts: 0,
      nextAt: Date.now() - 1, status: 'queued' });
    store.save();
    const controller = new AbortController();
    const delivered = [];
    let polls = 0;
    const api = {
      async getUpdates() {
        polls++;
        const error = new Error('incoming updates unavailable');
        error.status = 409;
        throw error;
      },
      async sendMessage(chatId, text) {
        delivered.push({ chatId, text });
        controller.abort();
      }
    };
    await runTelegramLoop(store, api, controller.signal);
    assert.equal(polls, 1);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].chatId, '222');
    assert.match(delivered[0].text, /yer göründü/);
    assert.equal(store.status().queued, 0);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('test command uses Telegram delivery but never counts as availability', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-telegram-test-delivery-'));
  try {
    const store = admittedStore(join(folder, 'state.json'));
    const controller = new AbortController();
    const sent = [];
    const api = {
      async getUpdates() {
        return [{ update_id: 15, message: { chat: { id: 123, type: 'private' }, text: '/test' } }];
      },
      async sendMessage(chatId, text) {
        sent.push({ chatId, text });
        controller.abort();
      }
    };
    await runTelegramLoop(store, api, controller.signal);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /^🧪 TEST/);
    assert.match(sent[0].text, /gerçek boş yer bildirimi değildir/);
    assert.match(store.status().telegram.lastTestDeliveryAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(store.status().telegram.lastAvailabilityDeliveryAt, null);
    assert.equal(store.status().queued, 0);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('inline menu asks for dates before real sessions and preserves multiple facilities', () => {
 const folder=mkdtempSync(join(tmpdir(),'rez-telegram-menu-'));
 try{
  const store=admittedStore(join(folder,'state.json')),date=futureTestDay(),code=date.replaceAll('-','');
  store.setFacilityCatalog([{id:'17',label:'Baraka Fitness',unit:'Spor Müdürlüğü'},
   {id:'18',label:'Başka Spor Salonu',unit:'Spor Müdürlüğü'}]);
  store.engine.pages[`17|${date}`]={facility:{id:'17'},date,lastSuccessAt:new Date().toISOString(),baselineConfirmed:true,
   slots:{[`${date}|11:00|12:45`]:{free:1},[`${date}|17:00|18:45`]:{free:0}}};
  const day=handleBotCallback(store,callback('t:17'));assert.match(day.text,/Hangi gün/);
  assert.equal(store.subscriptionsFor(123).length,0);
  const sessions=handleBotCallback(store,callback(`d:17:${code}`));
  assert.match(JSON.stringify(sessions),/11:00–12:45/);assert.doesNotMatch(JSON.stringify(sessions),/06:00–13:00/);
  handleBotCallback(store,callback(`q:17:${code}:11001245:1`));
  handleBotCallback(store,callback(`q:17:${code}:17001845:1`));
  handleBotCallback(store,callback(`q:17:${code}:17001845:1`));
  handleBotCallback(store,callback(`da:18:${code}:1`));
  assert.equal(store.filtersFor(123,'17').length,2);assert.equal(store.filtersFor(123,'18').length,1);
  const preferences=handleBotCallback(store,callback('p'));
  assert.match(preferences.text,/11:00–12:45/);assert.match(preferences.text,/17:00–18:45/);
  assert.match(preferences.text,/Tüm seanslar/);
  assert.equal(handleBotCallback(store,{...callback('u'),from:{id:999}}),null);
 }finally{rmSync(folder,{recursive:true,force:true});}
});

test('a new week offers its own dated sessions and legacy every-day preferences remain removable', t => {
 t.mock.method(Date,'now',()=>Date.parse('2026-10-19T06:00:00Z'));
 const folder=mkdtempSync(join(tmpdir(),'rez-new-week-'));
 try{
  const store=admittedStore(join(folder,'state.json'));
  for(const [date,start,end]of[['2026-10-18','08:00','09:00'],['2026-10-19','11:00','12:45']]){
   store.engine.pages[`17|${date}`]={facility:{id:'17'},date,lastSuccessAt:new Date(Date.now()).toISOString(),baselineConfirmed:true,
    slots:{[`${date}|${start}|${end}`]:{free:1}}};
  }
  store.subscribe(123,'17',{startAfter:'09:00',endBefore:'10:00'});
  const menu=handleBotCallback(store,callback('d:17:20261019'));
  assert.match(JSON.stringify(menu),/11:00–12:45/);assert.doesNotMatch(JSON.stringify(menu),/08:00–09:00/);
  assert.ok(buttonData(menu).includes('lg:17'));
  handleBotCallback(store,callback('lg:17'));assert.equal(store.filtersFor(123,'17').length,0);
 }finally{rmSync(folder,{recursive:true,force:true});}
});

test('a past booking window is not offered as a current session, but its saved hour stays removable', t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-19T09:05:00Z')); // 12:05 in Istanbul
  const folder = mkdtempSync(join(tmpdir(), 'rez-telegram-booking-window-'));
  try {
    const store = admittedStore(join(folder, 'state.json'));
    const at = new Date(Date.now()).toISOString();
    store.engine.pages['17|2026-10-19'] = {
      facility: { id: '17', label: 'Baraka Fitness' }, date: '2026-10-19',
      lastSuccessAt: at, baselineConfirmed: true,
      slots: {
        '2026-10-19|11:00|12:45': { free: 1 },
        '2026-10-19|14:00|15:45': { free: 2 }
      },
      observedSlotKeys: ['2026-10-19|11:00|12:45', '2026-10-19|14:00|15:45']
    };
    store.engine.health = { lastState: 'ok', lastSeenAt: at,
      lastFacility: { id: '17', label: 'Baraka Fitness' } };
    store.subscribe(123, '17', {date:'2026-10-19',startAfter:'11:00',endBefore:'12:45',exactTime:true,notifyAvailable:true});
    const menu = handleBotCallback(store, callback('d:17:20261019'));
    const labels = menu.replyMarkup.inline_keyboard.flat().map(item => item.text);
    assert.ok(labels.some(label => label.includes('11:00–12:45 · süresi geçti')));
    assert.ok(labels.some(label => label.includes('▫️ 14:00–15:45')));
    assert.equal(labels.some(label => label.includes('▫️ 11:00–12:45')), false);
    handleBotCallback(store, callback('q:17:20261019:14001545:1'));
    handleBotCallback(store, callback('q:17:20261019:11001245:0'));
    assert.deepEqual(store.filtersFor(123, '17').map(item => [item.startAfter, item.endBefore]),
      [['14:00', '15:45']]);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a retained but omitted session is not offered as current after a partial calendar', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-telegram-partial-calendar-'));
  try {
    const store = admittedStore(join(folder, 'state.json'));
    const at = new Date().toISOString();
    const date = futureTestDay();
    store.engine.pages[`17|${date}`] = {
      facility: { id: '17', label: 'Baraka Fitness' }, date,
      lastSuccessAt: at, baselineConfirmed: true,
      slots: {
        [`${date}|11:00|12:45`]: { free: 1, confirmedFree: 1 },
        [`${date}|13:00|14:45`]: { free: 2, confirmedFree: 2 }
      },
      observedSlotKeys: [`${date}|11:00|12:45`]
    };
    store.engine.health = { lastState: 'ok', lastSeenAt: at,
      lastFacility: { id: '17', label: 'Baraka Fitness' } };
    const menu = handleBotCallback(store, callback(`d:17:${date.replaceAll('-','')}`));
    assert.match(menu.text,/Birden fazla seans/);
    const labels = menu.replyMarkup.inline_keyboard.flat().map(item => item.text);
    assert.ok(labels.some(label => label.includes('▫️ 11:00–12:45')));
    assert.ok(labels.some(label=>label.includes('13:00–14:45 · son görülen')));
    store.subscribe(123, '17', {date,startAfter:'13:00',endBefore:'14:45',exactTime:true,notifyAvailable:true});
    assert.equal(store.status().calendarCoverage.intermittent, true);
    assert.match(handleBotCommand(store, { chat: { id: 123, type: 'private' }, text: '/start' }).text,
      /Görünmeyen saatler dolu, henüz açılmamış veya geçici olarak listelenmiyor olabilir/);
    assert.match(handleBotCommand(store, { chat: { id: 123, type: 'private' }, text: '/durum' }).text,
      /önceden görülen 2 gelecek seanstan yalnız 1 tanesi var/);
    const saved = handleBotCallback(store, callback(`d:17:${date.replaceAll('-','')}`));
    assert.ok(saved.replyMarkup.inline_keyboard.flat()
      .some(item => item.text.includes('13:00–14:45 · son görülen')));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('long selection lists paginate within Telegram limits and keep every facility reachable', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-telegram-long-selections-'));
  try {
    const store = admittedStore(join(folder, 'state.json'));
    const facilities = Array.from({ length: 20 }, (_, index) => ({
      id: String(index + 1), label: `Spor salonu ${index + 1} ${'A'.repeat(150)}`, unit: 'Spor Müdürlüğü'
    }));
    store.setFacilityCatalog(facilities);
    for (const facility of facilities) store.subscribe(123, facility.id);
    const preferences = handleBotCallback(store, callback('p'));
    assert.ok(preferences.text.length < 4096);
    const seen=new Set();let page=preferences;
    for(let i=0;i<4;i++){
      assert.ok(page.text.length<4096);
      for(const id of buttonData(page).filter(data=>data.startsWith('t:'))){assert.ok(!seen.has(id));seen.add(id);}
      const next=buttonData(page).find(data=>/^p:\d+$/.test(data)&&Number(data.slice(2))>i);
      if(!next)break;
      page=handleBotCallback(store,callback(next));
    }
    assert.equal(seen.size,facilities.length);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('coverage menu identifies only a recent successful facility and day as current', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-telegram-coverage-test-'));
  try {
    const store = admittedStore(join(folder, 'state.json'));
    const at = new Date(Date.now() - 30_000).toISOString();
    const facility = { id: '17', label: 'Baraka Fitness' };
    store.engine.pages['17|2026-10-18'] = {
      facility, date: '2026-10-18', lastSuccessAt: at, baselineConfirmed: true,
      slots: { '2026-10-18|11:00|12:45': { free: 0, confirmedFree: 0 } }
    };
    store.engine.health = { lastState: 'ok', lastSeenAt: at, lastFacility: facility };
    store.subscribe(123, '17');
    const home = () => handleBotCommand(store, { chat: { id: 123, type: 'private' }, text: '/start' }).text;
    assert.match(home(), /Son 3 dakikada seçtiğin tesisin takvimi doğrulandı: Baraka Fitness · 2026-10-18/);
    const command = { chat: { id: 123, type: 'private' }, text: '/durum' };
    assert.match(handleBotCommand(store, command).text,
      /Son 3 dakikada doğrulanan: Baraka Fitness · 2026-10-18/);
    store.engine.health.lastState = 'empty_unconfirmed';
    assert.match(handleBotCommand(store, command).text, /Takvim yanıtı boş; müsaitlik doğrulanamadı/);
    assert.doesNotMatch(handleBotCommand(store, command).text, /Son 3 dakikada doğrulanan:/);
    assert.match(handleBotCallback(store, callback('t:17')).text, /Hangi gün/);
    assert.doesNotMatch(handleBotCallback(store, callback('p')).text, /Son doğrulanan takvim/);
    store.engine.health.lastState = 'empty_confirmed';
    assert.match(handleBotCommand(store, command).text, /Takvim yanıtı boş; müsaitlik doğrulanamadı/);
    store.engine.health.lastState = 'calendar_unavailable';
    assert.match(handleBotCommand(store, command).text, /aktif takip doğrulanamıyor/);
    assert.match(handleBotCallback(store, callback('t:17')).text, /Hangi gün/);
    store.engine.health.lastState = 'ok';
    store.engine.pages['17|2026-10-18'].slots = {};
    assert.match(home(), /Son 3 dakikada doğrulanmış takvim yok/);
    assert.match(handleBotCommand(store, command).text, /aktif takip doğrulanamıyor/);
    assert.match(handleBotCommand(store, command).text, /Geçmişte takvim verisi gelen: 0/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('menus distinguish a saved preference from the single recently verified calendar', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-telegram-active-selection-test-'));
  try {
    const store = admittedStore(join(folder, 'state.json'));
    store.setFacilityCatalog([
      { id: '17', label: 'Baraka Fitness', unit: 'Spor Müdürlüğü' },
      { id: '18', label: 'Başka Salon', unit: 'Spor Müdürlüğü' }
    ]);
    store.subscribe(123, '18');
    const seenAt = new Date().toISOString();
    store.engine.pages['17|2026-10-18'] = {
      facility: { id: '17', label: 'Baraka Fitness' }, date: '2026-10-18',
      lastSuccessAt: seenAt, baselineConfirmed: true,
      slots: { '2026-10-18|11:00|12:45': { free: 1 } }
    };
    store.engine.health = { lastState: 'ok', lastSeenAt: seenAt,
      lastFacility: { id: '17', label: 'Baraka Fitness' } };
    const start = () => handleBotCommand(store, { chat: { id: 123, type: 'private' }, text: '/start' });
    assert.match(start().text, /Seçtiğin tesisler için güncel okuma yok/);
    const unitCode = buttonData(handleBotCallback(store, callback('u'))).find(data => data.startsWith('u:'));
    const facilities = handleBotCallback(store, callback(unitCode));
    assert.match(facilities.text, /Ardından gün ve seans/);
    assert.match(facilities.replyMarkup.inline_keyboard.flat().find(item => item.callback_data === 't:17').text, /🏋️/);
    assert.doesNotMatch(facilities.replyMarkup.inline_keyboard.flat().find(item => item.callback_data === 't:18').text, /🟢/);
    assert.match(handleBotCallback(store, callback('t:18')).text, /Hangi gün/);
    assert.match(handleBotCallback(store, callback('t:17')).text, /Hangi gün/);
    const status = handleBotCallback(store, callback('s')).text;
    assert.match(status, /Son okuma: \d{2}\.\d{2}\.\d{4}/);
    assert.doesNotMatch(status, /T\d{2}:\d{2}:\d{2}/);
    store.engine.health.lastState = 'no_tab';
    assert.match(start().text, /Son 3 dakikada doğrulanmış takvim yok/);
    assert.doesNotMatch(handleBotCallback(store, callback(unitCode)).text, /🟢 son 3 dakikada takvimi doğrulanan tesis\.\nSon doğrulanan:/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('main menu reports only this chat’s fresh and complete subscribed facilities', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-telegram-multi-coverage-'));
  try {
    const store = admittedStore(join(folder, 'state.json'));
    store.setFacilityCatalog([
      { id: '17', label: 'Baraka Fitness', unit: 'Spor Müdürlüğü' },
      { id: '18', label: 'Başka Salon', unit: 'Spor Müdürlüğü' },
      { id: '19', label: 'Başka Kişinin Salonu', unit: 'Spor Müdürlüğü' }
    ]);
    store.subscribe(123, '17');
    store.subscribe(123, '18');
    store.subscribe(456, '19');
    const date = futureTestDay();
    const at = new Date().toISOString();
    const slots = { [`${date}|11:00|12:45`]: { free: 1 },
      [`${date}|14:00|15:45`]: { free: 1 } };
    store.engine.pages[`17|${date}`] = {
      facility: { id: '17', label: 'Baraka Fitness' }, date,
      lastSuccessAt: at, baselineConfirmed: true, slots,
      observedSlotKeys: [`${date}|11:00|12:45`]
    };
    store.engine.health = { lastState: 'ok', lastSeenAt: at,
      lastFacility: { id: '17', label: 'Baraka Fitness' } };
    const start = () => handleBotCommand(store,
      { chat: { id: 123, type: 'private' }, text: '/start' }).text;
    const status = () => handleBotCommand(store,
      { chat: { id: 123, type: 'private' }, text: '/durum' }).text;
    assert.match(start(), /🟠 Seçtiğin 1\/2 tesisin takvimi/);
    assert.match(start(), /0\/2 tesisin önceden görülen seansları/);
    assert.match(status(), /Son 3 dakikada güncel: 1\/2/);
    assert.match(status(), /Önceden görülen seansları tam: 0\/2/);
    store.engine.pages[`17|${date}`].observedSlotKeys = Object.keys(slots);
    store.engine.pages[`18|${date}`] = { facility: { id: '18', label: 'Başka Salon' },
      date, lastSuccessAt: at, baselineConfirmed: true, slots,
      observedSlotKeys: Object.keys(slots) };
    assert.match(start(), /🟢 Seçtiğin 2\/2 tesisin takvimi/);
    assert.match(status(), /Önceden görülen seansları tam: 2\/2/);
    store.engine.pages[`18|${date}`].slots = {};
    assert.match(start(), /🟠 Seçtiğin 2\/2 tesisin takvimi/);
    assert.match(status(), /Önceden görülen seansları tam: 1\/2/);
    store.engine.health.lastState = 'no_tab';
    assert.match(start(), /⚪ Seçtiğin 0\/2 tesisin takvimi/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('empty catalog directs invited friends to support rather than asking them to operate the host site', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-telegram-empty-catalog-test-'));
  try {
    const store = admittedStore(join(folder, 'state.json'));
    store.setFacilityCatalog([]);
    const units = handleBotCallback(store, callback('u'));
    assert.match(units.text, /tesis listesi henüz bu bota eklenmedi/i);
    assert.doesNotMatch(units.text, /sayfasında bir tesis seç/);
    assert.ok(buttonData(units).includes('c'));
    assert.ok(buttonData(units).includes('h'));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('changing a session selection drops obsolete queued alerts before delivery', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-telegram-queue-test-'));
  try {
    const store = admittedStore(join(folder, 'state.json'));
    store.setFacilityCatalog([{ id: '17', label: 'Baraka Fitness', unit: 'Spor Müdürlüğü' }]);
    const day = futureTestDay();
    store.engine.pages[`17|${day}`] = {
      facility: { id: '17', label: 'Baraka Fitness' }, date: day,
      lastSuccessAt: new Date().toISOString(), baselineConfirmed: true,
      slots: { [`${day}|11:00|12:45`]: {}, [`${day}|17:00|18:45`]: {} }
    };
    store.engine.health = { lastState: 'ok', lastSeenAt: store.engine.pages[`17|${day}`].lastSuccessAt,
      lastFacility: { id: '17', label: 'Baraka Fitness' } };
    store.subscribe(123, '17', {date:day,notifyAvailable:true});
    for (const [id, start, end] of [['morning', '11:00', '12:45'], ['evening', '17:00', '18:45']]) {
      store.state.outbox.push({ id, chatId: '123', status: 'queued', nextAt: Date.now(), attempts: 0,
        event: { facility: { id: '17', label: 'Baraka Fitness' }, date: day, start, end, free: 1 } });
    }
    handleBotCallback(store, callback(`q:17:${day.replaceAll('-','')}:11001245:1`));
    assert.deepEqual(store.dueDeliveries().map(item => item.id), ['morning']);
    handleBotCallback(store, callback('f:17:0'));
    assert.equal(store.dueDeliveries().length, 0);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('callback query edits its bot menu and does not count as an availability message', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-telegram-callback-test-'));
  try {
    const store = admittedStore(join(folder, 'state.json'));
    const controller = new AbortController();
    const actions = [];
    const api = {
      async getUpdates() { return [{ update_id: 34, callback_query: callback('u') }]; },
      async answerCallbackQuery(id) { actions.push(['ack', id]); },
      async editMessageText(chatId, messageId, text, markup) {
        actions.push(['edit', chatId, messageId, text, markup]); controller.abort();
      },
      async sendMessage() { throw new Error('unexpected new message'); }
    };
    await runTelegramLoop(store, api, controller.signal);
    assert.equal(actions[0][0], 'ack');
    assert.equal(actions[1][0], 'edit');
    assert.equal(actions[1][1], 123);
    assert.equal(actions[1][2], 9);
    assert.equal(store.status().telegram.lastAvailabilityDeliveryAt, null);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('callback acknowledgement starts before a subscription write', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-telegram-early-ack-test-'));
  try {
    const store = admittedStore(join(folder, 'state.json'));
    store.setFacilityCatalog([{ id: '17', label: 'Baraka Fitness', unit: 'Spor Müdürlüğü' }]);
    const actions = [];
    const originalReplace = store.replaceFacilityFilters.bind(store);
    store.replaceFacilityFilters = (...args) => {
      actions.push('save choice');
      return originalReplace(...args);
    };
    const controller = new AbortController();
    const api = {
      async getUpdates() { return [{ update_id: 1, callback_query: callback('a:17') }]; },
      async answerCallbackQuery() { actions.push('ack'); },
      async editMessageText() { actions.push('edit'); controller.abort(); }
    };
    await runTelegramLoop(store, api, controller.signal);
    assert.deepEqual(actions, ['ack', 'save choice', 'edit']);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a slow vacancy send cannot hold the next bot menu update', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-telegram-independent-outbox-test-'));
  const controller = new AbortController();
  let releaseDelivery;
  let timeout;
  try {
    const store = admittedStore(join(folder, 'state.json'));
    store.state.outbox.push({ id: 'queued', chatId: '222', status: 'queued', nextAt: Date.now() - 1, attempts: 0,
      event: { facility: { id: '17', label: 'Baraka Fitness' }, date: '2026-10-19', start: '11:00', end: '12:45', free: 1 } });
    const deliveryBlocked = new Promise(resolve => { releaseDelivery = resolve; });
    let menuEdited;
    const edited = new Promise(resolve => { menuEdited = resolve; });
    let polls = 0;
    const api = {
      async getUpdates() {
        return ++polls === 1 ? [] : [{ update_id: 3, callback_query: callback('u') }];
      },
      async sendMessage() { await deliveryBlocked; },
      async answerCallbackQuery() {},
      async editMessageText() { menuEdited(); controller.abort(); }
    };
    const running = runTelegramLoop(store, api, controller.signal);
    await Promise.race([
      edited,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('menu blocked by vacancy send')), 1_000); })
    ]);
    assert.ok(polls >= 2);
    releaseDelivery();
    await running;
  } finally {
    controller.abort();
    releaseDelivery?.();
    clearTimeout(timeout);
    rmSync(folder, { recursive: true, force: true });
  }
});
