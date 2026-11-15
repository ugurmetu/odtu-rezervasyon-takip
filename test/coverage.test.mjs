import {createOperatorChannel} from '../src/operator-alerts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../src/store.mjs';
import { checkCoverage, checkDeliveryHealth, checkTelegramPolling, coverageProblem } from '../src/coverage.mjs';

const INVITE = 'test_only_invite_code_2026';

function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'rez-coverage-test-'));
  const file = join(folder, 'state.json');
  const store = new LocalStore(file, { betaInviteCode: INVITE });
  assert.equal(store.approveBetaChat(123, INVITE), 'approved');
  const sent = [];
  const api = createOperatorChannel({ async sendMessage(chatId, message) { sent.push({ chatId, message }); } },'123');
  return { folder, file, store, sent, api };
}

test('a stalled facility is still detected per facility, but a self-recovering delay does not message the owner',async()=>{
 const f=fixture();try{
  const now=Date.parse('2026-10-27T14:00:00Z');
  f.store.state.readerPlan={facilityIds:['17','21'],dates:['2026-10-28']};
  f.store.engine.health={lastState:'empty_unconfirmed',lastSeenAt:new Date(now).toISOString()};
  f.store.engine.pages['17|2026-10-28']={lastSuccessAt:new Date(now).toISOString()};
  f.store.state.readerState={phase:'preparing',at:new Date(now).toISOString(),since:new Date(now).toISOString()};
  assert.equal(await checkCoverage(f.store,f.api,'123',now),'pending');
  f.store.state.readerState.phase='reconnecting';
  f.store.engine.pages['17|2026-10-28'].lastSuccessAt=new Date(now+10*60000).toISOString();
  const problem=coverageProblem(f.store,now+10*60000);assert.equal(problem.kind,'plan_incomplete');assert.deepEqual(problem.facilityIds,['21']);
  assert.equal(await checkCoverage(f.store,f.api,'123',now+10*60000),'quiet');
  assert.equal(await checkCoverage(f.store,f.api,'123',now+60*60000),'quiet');assert.equal(f.sent.length,0);
 }finally{rmSync(f.folder,{recursive:true,force:true});}
});

test('Chrome silent for 30 minutes reminds only the approved owner once, survives restart, and reports recovery', async () => {
  const f = fixture();
  try {
    const now = Date.parse('2026-10-18T17:00:00Z');
    f.store.engine.health = { lastState: 'ok', lastSeenAt: new Date(now).toISOString() };
    assert.equal(await checkCoverage(f.store, f.api, '456', now), 'disabled');
    assert.equal(await checkCoverage(f.store, f.api, '123', now), 'healthy');
    assert.equal(f.sent.length, 0);

    f.store.engine.health.lastSeenAt = new Date(now - 4 * 60_000).toISOString();
    assert.equal(await checkCoverage(f.store, f.api, '123', now), 'pending');
    assert.equal(f.sent.length, 0, 'a few silent minutes are not worth a message');
    assert.equal(await checkCoverage(f.store, f.api, '123', now + 26 * 60_000), 'alerted');
    assert.equal(await checkCoverage(f.store, f.api, '123', now + 29 * 60_000), 'already_alerted');
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].chatId, '123');
    assert.match(f.sent[0].message, /30 dakikadır takvim gelmiyor/);
    assert.doesNotMatch(f.sent[0].message, /aksama/);
    const restarted = new LocalStore(f.file, { betaInviteCode: INVITE });
    assert.equal(await checkCoverage(restarted, f.api, '123', now + 30 * 60_000), 'already_alerted');
    assert.equal(f.sent.length, 1);

    restarted.engine.health = { lastState: 'ok', lastSeenAt: new Date(now + 30 * 60_000).toISOString() };
    assert.equal(await checkCoverage(restarted, f.api, '123', now + 30 * 60_000), 'recovered');
    assert.equal(await checkCoverage(restarted, f.api, '123', now + 30 * 60_000), 'healthy');
    assert.equal(f.sent.length, 1);
  } finally {
    rmSync(f.folder, { recursive: true, force: true });
  }
});

test('no first calendar reading keeps a 30-minute grace before the owner reminder', async () => {
  const f = fixture();
  try {
    const now = Date.parse('2026-10-18T17:00:00Z');
    f.store.engine.health = { lastState: 'ok', lastSeenAt: null };
    assert.equal(await checkCoverage(f.store, f.api, '123', now), 'pending');
    assert.equal(await checkCoverage(f.store, f.api, '123', now + 29 * 60_000), 'pending');
    assert.equal(await checkCoverage(f.store, f.api, '123', now + 30 * 60_000), 'alerted');
    assert.equal(f.sent.length, 1);
  } finally {
    rmSync(f.folder, { recursive: true, force: true });
  }
});

test('a repeatedly partial session list is detected but stays quiet and clears when complete', async () => {
  const f = fixture();
  try {
    const now = Date.parse('2026-10-18T21:00:00Z');
    const facility = { id: '17', label: 'Baraka Fitness' };
    const day = '2026-10-19';
    const page = { facility, date: day, lastSuccessAt: new Date(now).toISOString(),
      baselineConfirmed: true, slots: { a: { free: 1 }, b: { free: 2 } },
      observedSlotKeys: ['a'] };
    f.store.engine.pages[`17|${day}`] = page;
    f.store.engine.health = { lastState: 'ok', lastSeenAt: page.lastSuccessAt,
      lastFacility: facility };
    assert.equal(f.store.status().calendarCoverage.intermittent, true);
    assert.equal(await checkCoverage(f.store, f.api, '123', now), 'pending');
    page.lastSuccessAt = new Date(now + 10 * 60_000).toISOString();
    f.store.engine.health.lastSeenAt = page.lastSuccessAt;
    assert.equal(coverageProblem(f.store, now + 10 * 60_000).kind, 'intermittent_sessions');
    assert.equal(await checkCoverage(f.store, f.api, '123', now + 10 * 60_000), 'quiet');
    page.observedSlotKeys = ['a', 'b'];
    page.lastSuccessAt = new Date(now + 12 * 60_000).toISOString();
    f.store.engine.health.lastSeenAt = page.lastSuccessAt;
    assert.equal(await checkCoverage(f.store, f.api, '123', now + 12 * 60_000), 'healthy');
    assert.equal(f.sent.length, 0);
  } finally {
    rmSync(f.folder, { recursive: true, force: true });
  }
});

test('expired day needs action while a freshly fetched empty calendar waits silently', async () => {
  const f = fixture();
  try {
    const now = Date.parse('2026-10-18T17:00:00Z');
    f.store.engine.health = { lastState: 'calendar_unavailable', lastSeenAt: new Date(now).toISOString() };
    f.store.state.lastDiagnostic = 'calendar_date_expired';
    assert.equal(coverageProblem(f.store, now).kind, 'calendar_date_expired');
    assert.equal(await checkCoverage(f.store, f.api, '123', now), 'pending');
    assert.equal(await checkCoverage(f.store, f.api, '123', now + 2 * 60_000), 'alerted');
    assert.match(f.sent[0].message, /yeni günü seç/);

    f.store.engine.health = { lastState: 'paused', lastSeenAt: new Date(now + 3 * 60_000).toISOString() };
    assert.equal(await checkCoverage(f.store, f.api, '123', now + 3 * 60_000), 'paused');
    assert.equal(f.sent.length, 1);

    f.store.engine.health = { lastState: 'empty_unconfirmed', lastSeenAt: new Date(now + 4 * 60_000).toISOString() };
    assert.equal(await checkCoverage(f.store, f.api, '123', now + 4 * 60_000), 'recovered');
    // A continuously empty calendar must have fresh site reads, not an old one.
    f.store.engine.health.lastSeenAt = new Date(now + 13 * 60_000).toISOString();
    assert.equal(await checkCoverage(f.store, f.api, '123', now + 13 * 60_000), 'healthy');
    f.store.engine.health.lastSeenAt = new Date(now + 14 * 60_000).toISOString();
    assert.equal(await checkCoverage(f.store, f.api, '123', now + 14 * 60_000), 'healthy');
    assert.equal(f.sent.length,1);
  } finally {
    rmSync(f.folder, { recursive: true, force: true });
  }
});

test('a failed automatic day advance is reported to the owner without a vacancy alert', async () => {
  const f = fixture();
  try {
    const now = Date.parse('2026-10-18T18:00:00Z');
    f.store.engine.health = {
      lastState: 'calendar_unavailable', lastSeenAt: new Date(now).toISOString()
    };
    f.store.state.lastDiagnostic = 'calendar_day_advance_failed';
    assert.equal(coverageProblem(f.store, now).kind, 'calendar_day_advance_failed');
    assert.equal(await checkCoverage(f.store, f.api, '123', now), 'pending');
    assert.equal(await checkCoverage(f.store, f.api, '123', now + 2 * 60_000), 'alerted');
    assert.match(f.sent[0].message, /otomatik geçirilemedi/);
    assert.equal(f.store.status().queued, 0);
  } finally {
    rmSync(f.folder, { recursive: true, force: true });
  }
});

test('stopped login and site-denial states do not become duplicate stale-data alerts', async () => {
  for (const [state, diagnostic, expected] of [
    ['login_required', null, /oturumu kapanmış/],
    ['calendar_unavailable', 'site_access_denied', /erişimi reddetti/],
    ['calendar_unavailable', 'site_rate_limited', /sınırlandırdı/]
  ]) {
    const f = fixture();
    try {
      const now = Date.parse('2026-10-18T17:00:00Z');
      f.store.engine.health = { lastState: state, lastSeenAt: new Date(now).toISOString() };
      f.store.state.lastDiagnostic = diagnostic;
      const kind = diagnostic || state;
      assert.equal(coverageProblem(f.store, now + 4 * 60_000).kind, kind);
      assert.equal(await checkCoverage(f.store, f.api, '123', now), 'pending');
      assert.equal(await checkCoverage(f.store, f.api, '123', now + 2 * 60_000), 'alerted');
      assert.match(f.sent[0].message, expected);
      assert.equal(await checkCoverage(f.store, f.api, '123', now + 4 * 60_000), 'already_alerted');
      assert.equal(f.sent.length, 1);
    } finally {
      rmSync(f.folder, { recursive: true, force: true });
    }
  }
});

test('failed Telegram delivery is retried and does not mark an alert as sent', async () => {
  const f = fixture();
  try {
    const now = Date.parse('2026-10-18T17:00:00Z');
    f.store.engine.health = { lastState: 'no_tab', lastSeenAt: new Date(now).toISOString() };
    assert.equal(await checkCoverage(f.store, f.api, '123', now), 'pending');
    const failed = createOperatorChannel({ async sendMessage() { throw new Error('offline'); } },'123');
    await assert.rejects(checkCoverage(f.store, failed, '123', now + 2 * 60_000), /offline/);
    assert.equal(f.store.state.coverageNotice.alerted, false);
    assert.equal(await checkCoverage(f.store, f.api, '123', now + 2 * 60_000), 'alerted');
    assert.equal(f.sent.length, 1);
  } finally {
    rmSync(f.folder, { recursive: true, force: true });
  }
});

test('new failed or expired vacancy deliveries alert only the owner once and survive restart', async () => {
  const f = fixture();
  try {
    const now = Date.now();
    f.store.state.outbox.push({ id: 'historical', status: 'failed', failedAt: new Date(now - 6 * 60_000).toISOString() });
    f.store.save();
    assert.equal(await checkDeliveryHealth(f.store, f.api, '456', now), 'disabled');
    assert.equal(await checkDeliveryHealth(f.store, f.api, '123', now), 'healthy');
    assert.equal(f.sent.length, 0);

    f.store.state.outbox.push({ id: 'expired-new', status: 'expired', failedAt: new Date(now + 1_000).toISOString() });
    f.store.save();
    assert.equal(await checkDeliveryHealth(f.store, f.api, '123', now + 1_000), 'alerted');
    assert.match(f.sent[0].message, /Gönderilemeyen: 0 · Süresi geçen: 1/);
    assert.equal(f.sent[0].chatId, '123');
    assert.equal(await checkDeliveryHealth(f.store, f.api, '123', now + 2_000), 'healthy');
    assert.equal(f.sent.length, 1);

    const restarted = new LocalStore(f.file, { betaInviteCode: INVITE });
    assert.equal(await checkDeliveryHealth(restarted, f.api, '123', now + 3_000), 'healthy');
    restarted.state.outbox.push({ id: 'failed-new', status: 'failed', failedAt: new Date(now + 4_000).toISOString() });
    restarted.save();
    assert.equal(await checkDeliveryHealth(restarted,f.api,'123',now+4000),'cooldown');
    await assert.rejects(checkDeliveryHealth(restarted,
      createOperatorChannel({ async sendMessage() { throw new Error('offline'); } },'123'), '123', now + 3_602_000), /offline/);
    assert.equal(restarted.state.deliveryNotice.seenIds.includes('failed-new'), false);
    assert.equal(await checkDeliveryHealth(restarted, f.api, '123', now + 3_603_000), 'alerted');
    assert.match(f.sent[1].message, /Gönderilemeyen: 1 · Süresi geçen: 0/);
    assert.equal(await checkDeliveryHealth(restarted, f.api, '123', now + 3_604_000), 'healthy');
    assert.equal(f.sent.length, 2);
  } finally {
    rmSync(f.folder, { recursive: true, force: true });
  }
});

test('an uncertain Telegram result alerts only the owner without claiming the vacancy message was lost', async () => {
  const f = fixture();
  try {
    const now = Date.now();
    f.store.state.outbox.push({ id: 'uncertain-delivery', status: 'uncertain',
      uncertainAt: new Date(now).toISOString(), reason: 'send_result_unknown' });
    f.store.save();
    assert.equal(await checkDeliveryHealth(f.store, f.api, '456', now), 'disabled');
    assert.equal(await checkDeliveryHealth(f.store, f.api, '123', now), 'alerted');
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].message, /Sonucu belirsiz: 1/);
    assert.match(f.sent[0].message, /otomatik tekrar edilmiyor/);
    assert.doesNotMatch(f.sent[0].message, /1 bildirim Telegram'a gönderilemedi/);
    const restarted = new LocalStore(f.file, { betaInviteCode: INVITE });
    assert.equal(await checkDeliveryHealth(restarted, f.api, '123', now + 1_000), 'healthy');
    assert.equal(f.sent.length, 1);
  } finally {
    rmSync(f.folder, { recursive: true, force: true });
  }
});

test('stalled Telegram polling alerts the owner, requires a real poll to recover, and limits repeats', async () => {
  const f = fixture();
  try {
    const start = Date.now();
    f.store.setTelegramConfigured(true);
    f.store.telegramHealth.startedAt = new Date(start).toISOString();
    assert.equal(await checkTelegramPolling(f.store, f.api, '456', start + 120_000), 'disabled');
    assert.equal(await checkTelegramPolling(f.store, f.api, '123', start + 119_000), 'starting');
    await assert.rejects(checkTelegramPolling(f.store,
      createOperatorChannel({ async sendMessage() { throw new Error('offline'); } },'123'), '123', start + 120_000), /offline/);
    assert.equal(f.store.state.telegramPollNotice, undefined);
    assert.equal(await checkTelegramPolling(f.store, f.api, '123', start + 120_000), 'alerted');
    assert.match(f.sent[0].message, /Bot bağlantısı aksıyor/);
    assert.equal(f.sent[0].chatId, '123');
    assert.equal(await checkTelegramPolling(f.store, f.api, '123', start + 130_000), 'already_alerted');

    const restarted = new LocalStore(f.file, { betaInviteCode: INVITE });
    restarted.setTelegramConfigured(true);
    restarted.telegramHealth.startedAt = new Date(start + 130_000).toISOString();
    assert.equal(await checkTelegramPolling(restarted, f.api, '123', start + 140_000), 'already_alerted');
    assert.equal(f.sent.length, 1);
    restarted.telegramHealth.lastPollAt = new Date(start + 151_000).toISOString();
    assert.equal(await checkTelegramPolling(restarted, f.api, '123', start + 151_000), 'recovering');
    assert.equal(await checkTelegramPolling(restarted, f.api, '123', start + 180_000), 'recovering');
    assert.equal(await checkTelegramPolling(restarted, f.api, '123', start + 211_000), 'recovering');
    restarted.telegramHealth.lastPollAt = new Date(start + 211_000).toISOString();
    assert.equal(await checkTelegramPolling(restarted, f.api, '123', start + 211_000), 'recovered');
    assert.equal(await checkTelegramPolling(restarted, f.api, '123', start + 331_000), 'cooldown');
    assert.equal(f.sent.length, 1);
  } finally {
    rmSync(f.folder, { recursive: true, force: true });
  }
});

test('one outage changing error kinds does not send repeated warnings, including after restart',async()=>{
 const f=fixture();try{
  const now=Date.now();f.store.engine.health={lastState:'no_tab',lastSeenAt:new Date(now).toISOString()};
  await checkCoverage(f.store,f.api,'123',now);assert.equal(await checkCoverage(f.store,f.api,'123',now+120000),'alerted');
  f.store.engine.health={lastState:'calendar_unavailable',lastSeenAt:new Date(now+180000).toISOString()};
  f.store.state.lastDiagnostic='parse_failed';
  assert.equal(await checkCoverage(f.store,f.api,'123',now+600000),'already_alerted');
  const restarted=new LocalStore(f.file,{betaInviteCode:INVITE});
  assert.equal(await checkCoverage(restarted,f.api,'123',now+700000),'already_alerted');assert.equal(f.sent.length,1);
 }finally{rmSync(f.folder,{recursive:true,force:true});}
});
test('human verification is reported once even if a prior problem already alerted', async () => {
  const f = fixture();
  try {
    const now = Date.parse('2026-11-06T15:00:00Z');
    f.store.state.readerState = { phase: 'login_failed' };
    assert.equal(await checkCoverage(f.store, f.api, '123', now), 'pending');
    assert.equal(await checkCoverage(f.store, f.api, '123', now + 120_000), 'alerted');

    const verificationAt = now + 150_000;
    f.store.state.readerState = { phase: 'waiting_verification' };
    assert.equal(await checkCoverage(f.store, f.api, '123', verificationAt), 'pending');
    assert.equal(await checkCoverage(f.store, f.api, '123', verificationAt + 119_999), 'pending');
    assert.equal(await checkCoverage(f.store, f.api, '123', verificationAt + 120_000), 'alerted');
    assert.match(f.sent[1].message, /insan doğrulaması/);

    const restarted = new LocalStore(f.file, { betaInviteCode: INVITE });
    assert.equal(await checkCoverage(restarted, f.api, '123', verificationAt + 180_000), 'already_alerted');
    restarted.state.readerState = { phase: 'login_failed' };
    await checkCoverage(restarted, f.api, '123', verificationAt + 210_000);
    restarted.state.readerState = { phase: 'waiting_verification' };
    await checkCoverage(restarted, f.api, '123', verificationAt + 240_000);
    assert.equal(await checkCoverage(restarted, f.api, '123', verificationAt + 360_000), 'already_alerted');
    assert.equal(f.sent.length, 2);
  } finally {
    rmSync(f.folder, { recursive: true, force: true });
  }
});

test('technical warning budget is shared with Telegram poll warnings and survives recovery',async()=>{
 const f=fixture();try{
  const now=Date.now();f.store.engine.health={lastState:'no_tab',lastSeenAt:new Date(now).toISOString()};
  await checkCoverage(f.store,f.api,'123',now);await checkCoverage(f.store,f.api,'123',now+120000);
  f.store.setTelegramConfigured(true);f.store.telegramHealth.startedAt=new Date(now).toISOString();
  assert.equal(await checkTelegramPolling(f.store,f.api,'123',now+180000),'cooldown');assert.equal(f.sent.length,1);
  assert.equal(await checkTelegramPolling(f.store,f.api,'123',now+3800000),'alerted');assert.equal(f.sent.length,2);
 }finally{rmSync(f.folder,{recursive:true,force:true});}
});

test('fresh planned days do not turn the last empty date of a valid batch into an outage warning',async()=>{
 const f=fixture();try{
  const now=Date.now();f.store.state.readerPlan={facilityIds:['17','21'],dates:['2026-10-28','2026-10-29','2026-10-30']};f.store.state.readerState={phase:'ready'};
  for(const id of ['17','21'])for(const date of f.store.state.readerPlan.dates)f.store.engine.pages[`${id}|${date}`]={lastSuccessAt:new Date(now).toISOString()};
  f.store.engine.health={lastState:'empty_unconfirmed',lastSeenAt:new Date(now).toISOString()};
  assert.equal(coverageProblem(f.store,now),null);assert.equal(await checkCoverage(f.store,f.api,'123',now),'healthy');assert.equal(f.sent.length,0);
  f.store.engine.pages['17|2026-10-28'].lastSuccessAt=new Date(now-300000).toISOString();assert.equal(coverageProblem(f.store,now).kind,'plan_incomplete');
 }finally{rmSync(f.folder,{recursive:true,force:true});}
});

test('explicit site rejection stays actionable even when old planned snapshots are fresh',()=>{
 const f=fixture();try{const now=Date.now();f.store.state.readerPlan={facilityIds:['17'],dates:['2026-10-28']};f.store.engine.pages['17|2026-10-28']={lastSuccessAt:new Date(now).toISOString()};f.store.engine.health={lastState:'ok',lastSeenAt:new Date(now).toISOString()};f.store.state.readerState={phase:'site_access_denied'};const p=coverageProblem(f.store,now);assert.equal(p.kind,'site_access_denied');assert.match(p.text,/duraklatıldı/);}finally{rmSync(f.folder,{recursive:true,force:true});}
});

test('a healthy wide sweep is evaluated at its declared cadence rather than falsely requiring every facility within four minutes',()=>{const f=fixture();try{const now=Date.now(),ids=Array.from({length:32},(_,i)=>String(i+1));f.store.state.readerPlan={facilityIds:ids,dates:['2026-10-28'],scanMode:'round-robin'};f.store.state.readerState={phase:'ready'};f.store.engine.health={lastState:'empty_unconfirmed',lastSeenAt:new Date(now).toISOString()};for(const id of ids)f.store.engine.pages[`${id}|2026-10-28`]={lastSuccessAt:new Date(now-300000).toISOString()};assert.equal(coverageProblem(f.store,now),null);f.store.engine.pages['1|2026-10-28'].lastSuccessAt=new Date(now-900000).toISOString();assert.equal(coverageProblem(f.store,now).kind,'plan_incomplete');}finally{rmSync(f.folder,{recursive:true,force:true});}});
