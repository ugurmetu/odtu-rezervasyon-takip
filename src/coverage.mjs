import {isPublicationWait} from './publication-wait.mjs';
import {isOperatorChannel} from './operator-alerts.mjs';
import {scheduleFreshMs,facilityCadenceMs} from './reader-facilities.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import {msg,language,withChatLanguage,facilityLabel} from './i18n.mjs';

const FRESH_MS = 3 * 60_000;
const STALE_OWNER_NOTICE_MS = 30 * 60_000;
const OWNER_ACTION_KINDS = new Set(['waiting_verification', 'credentials_missing', 'credentials_locked', 'credentials_unavailable',
  'login_failed', 'login_required', 'site_access_denied', 'site_rate_limited', 'stale',
  // Legacy manual-tab mode: only the owner can reopen the tab or pick a day.
  'no_tab', 'calendar_date_expired', 'calendar_day_advance_failed']);
const CHECK_MS = 30_000;
const STARTUP_DELIVERY_LOOKBACK_MS = 5 * 60_000;
const TELEGRAM_POLL_STALE_MS = 2 * 60_000;
const TELEGRAM_POLL_RECOVERY_MS = 60_000;
const TELEGRAM_POLL_ALERT_COOLDOWN_MS = 30 * 60_000;

const TECHNICAL_NOTICE_COOLDOWN_MS=60*60_000;
async function sendTechnicalNotice(store,api,ownerChatId,text,now,{useCooldown=true}={}){
  if(!isOperatorChannel(api,ownerChatId))return false;
  const last=store.state.lastTechnicalNoticeAt;
  if(useCooldown&&Number.isFinite(last)&&now-last>=0&&now-last<TECHNICAL_NOTICE_COOLDOWN_MS)return false;
  await api.sendMessage(ownerChatId,text);
  store.state.lastTechnicalNoticeAt=now;
  store.state.operatorAlerts={...store.state.operatorAlerts,configured:true,ready:true,reason:'ready',lastSentAt:new Date(now).toISOString()};
  store.save();return true;
}

function recent(timestamp, now) {
  const at = Date.parse(timestamp || '');
  return Number.isFinite(at) && now - at >= 0 && now - at <= FRESH_MS;
}

function problemText(store,problem){
 if(language()!=='en')return problem.text;
 const messages={
  waiting_verification:'The collector session needs human verification. The operator must check the server screen; monitoring resumes after verification.',
  credentials_missing:'Save the METU sign-in credentials once in the extension Session section.',
  credentials_locked:'The Mac password vault is locked. Monitoring will retry after you unlock the Mac.',
  credentials_unavailable:'The Mac password vault is unavailable. Check the extension Session section.',
  site_access_denied:'METU denied access. Automatic monitoring has paused; check access to the official site.',
  site_rate_limited:'METU limited the requests. Automatic monitoring has paused; the limit will not be bypassed.',
  login_failed:'METU sign-in failed. Automatic sign-in has stopped retrying; check the saved credentials.',
  login_required:'The METU reservation session has ended. Sign in on the official site and resume monitoring.',
  stale:'No current data has arrived from Chrome for three minutes. Check the Mac, Chrome, session and extension.',
  intermittent_sessions:'Some selected sessions could not be checked. The connection is being retried.',
  empty:'The selected calendar response is empty. This is not treated as availability; check the official facility and day.',
  no_tab:'The monitored reservation tab is closed. Open it and check the facility, day and monitoring status.',
  calendar_date_expired:'The selected calendar day has passed. Select a current day on the official site.',
  calendar_day_advance_failed:'The calendar could not advance automatically. Check the facility and day on the official site.',
  calendar_unavailable:'The reservation calendar could not be verified. Check the official site and extension status.'
 };
 if(problem.kind==='plan_incomplete'){
  const names=(problem.facilityIds||[]).map(id=>facilityLabel(store.catalogFacility(id)?.label||`Facility ${id}`));
  return `Waiting for current calendars:\n${names.slice(0,5).join('\n')}${names.length>5?`\nand ${names.length-5} more facilities`:''}\nRetrying the calendar connection. Other up-to-date selections remain monitored.`;
 }
 return messages[problem.kind]||messages.calendar_unavailable;
}

export function coverageProblem(store, now = Date.now()) {
  const health = store.engine.health;
  if (health.lastState === 'paused') return null;
  const reader=store.state.readerState;
  const readerProblems={
    waiting_verification:'Toplayıcı oturumunda insan doğrulaması bekleniyor. Yönetici sunucu ekranını kontrol etmeli; doğrulama tamamlanınca takip devam eder.',
    credentials_missing:'Otomatik giriş için uzantının Oturum bölümüne ODTÜ giriş bilgilerini bir kez kaydet.',
    credentials_locked:'Mac parola kasası kilitli. Mac oturumunu açtıktan sonra takip yeniden deneyecek.',
    credentials_unavailable:'Mac parola kasasına erişilemedi. Uzantının Oturum bölümünü kontrol et.',
    site_access_denied:'ODTÜ sitesi erişimi reddetti. Otomatik takip duraklatıldı; site erişimi kontrol edilmeli.',
    site_rate_limited:'ODTÜ sitesi sorguları sınırladı. Otomatik takip duraklatıldı; sınır zorlanmıyor.',
    login_failed:'ODTÜ giriş denemesi başarısız oldu. Tekrar tekrar denemek yerine otomatik giriş bekletildi; uzantıdaki giriş bilgilerini kontrol et.'
  };
  if(reader&&readerProblems[reader.phase])return {kind:reader.phase,waitMs:120000,text:readerProblems[reader.phase]};
  if(isPublicationWait({state:store.state,engine:store.engine,now}))return null;
  const plan=store.state.readerPlan;
  if(plan?.facilityIds?.length&&plan?.dates?.length){
    const scopes=plan.facilityIds.flatMap(id=>plan.dates.map(date=>`${id}|${date}`));
    const missing=scopes.filter(scope=>{
      const at=Date.parse(store.engine.pages[scope]?.lastSuccessAt||'');
      const id=scope.split('|')[0],started=Date.parse(store.state.readerScopeStartedAt?.[scope]||'');
      if(!Number.isFinite(at)&&Number.isFinite(started)&&now-started<Math.max(120000,facilityCadenceMs(store,id)*3+60000))return false;
      return !Number.isFinite(at)||now-at<0||now-at>scheduleFreshMs(store,id);
    });
    const fresh=scopes.length-missing.length;
    if(missing.length){
      const names=[...new Set(missing.map(scope=>scope.split('|')[0]))].map(id=>{
        const label=store.catalogFacility(id)?.label||`Tesis ${id}`;
        return /baraka.*fitness/i.test(label)?'Baraka Fitness':/ODTÜ Spor Merkezi.*Fitness/i.test(label)?'Teknokent Fitness':label.slice(0,40);
      });
      return {kind:'plan_incomplete',waitMs:10*60000,facilityIds:[...new Set(missing.map(scope=>scope.split('|')[0]))],
        text:`Güncel takvim bekleniyor:\n${names.slice(0,5).join('\n')}${names.length>5?`\nve ${names.length-5} tesis daha`:''}\nTakvim bağlantısı yeniden deneniyor. Güncel diğer seçimler takipte.`};
    }
    // An availability-only calendar can legitimately omit full days. A fresh
    // empty result in the final date of a healthy batch is not an outage of
    // the other days and must not generate recurring technical warnings.
    if(fresh===scopes.length&&['ok','empty_unconfirmed','empty_confirmed'].includes(health.lastState))return null;
  }
  if(reader&&['preparing','signing_in','reconnecting','network_wait'].includes(reader.phase)
    &&now-Date.parse(reader.since||reader.at)<10*60000)return null;
  // An authenticated, freshly fetched empty list is a waiting state. It does
  // not prove availability, but also does not require user intervention.
  if(health.lastState==='empty_unconfirmed'&&recent(health.lastSeenAt,now))return null;
  // These states intentionally stop further site checks. Their observation
  // will age, but the cause remains actionable and must not turn into a
  // second generic stale-data alert a minute after the first warning.
  if (health.lastState === 'login_required') {
    return { kind: 'login_required', waitMs: 2 * 60_000,
      text: 'ODTÜ rezervasyon oturumu kapanmış. Resmî sitede yeniden giriş yapıp takibi başlat.' };
  }
  if (health.lastState === 'calendar_unavailable'
    && ['site_access_denied', 'site_rate_limited'].includes(store.state.lastDiagnostic)) {
    return { kind: store.state.lastDiagnostic, waitMs: 2 * 60_000,
      text: 'ODTÜ sitesi erişimi reddetti veya sınırlandırdı. Siteyi elle kontrol et; otomatik sorguyu zorlayarak yeniden başlatma.' };
  }
  if (!recent(health.lastSeenAt, now)) {
    return { kind: 'stale', waitMs: FRESH_MS,
      text: 'Chrome rezervasyon sekmesinden üç dakikadır güncel veri gelmiyor. Mac, Chrome, oturum ve uzantı durumunu kontrol et.' };
  }
  if (health.lastState === 'ok') {
    const coverage = store.status().calendarCoverage;
    if (coverage?.intermittent) {
      return { kind: 'intermittent_sessions', waitMs: 10 * 60_000,
        text: 'Seçtiğin saatlerin bir kısmı güncel okunamıyor. Bağlantı yeniden deneniyor.' };
    }
    return null;
  }
  if (health.lastState === 'empty_unconfirmed') {
    return { kind: 'empty', waitMs: 10 * 60_000,
      text: 'Seçili takvimin yanıtı boş. Sistem bunu boş yer saymıyor; tesisi ve günü resmî sitede kontrol et.' };
  }
  if (health.lastState === 'no_tab') {
    return { kind: 'no_tab', waitMs: 2 * 60_000,
      text: 'İzlenen rezervasyon sekmesi açık değil. Sekmeyi açıp tesis/gün seçimini ve takibi kontrol et.' };
  }
  if (health.lastState === 'calendar_unavailable'
    && store.state.lastDiagnostic === 'calendar_date_expired') {
    return { kind: 'calendar_date_expired', waitMs: 2 * 60_000,
      text: 'Takvimde seçili gün geçti. Resmî sitede yeni günü seç; eski gün için takip sürmez.' };
  }
  if (health.lastState === 'calendar_unavailable'
    && store.state.lastDiagnostic === 'calendar_day_advance_failed') {
    return { kind: 'calendar_day_advance_failed', waitMs: 2 * 60_000,
      text: 'Takvim yeni güne otomatik geçirilemedi. Resmî sitede seçili tesis ve günü kontrol et.' };
  }
  return { kind: 'calendar_unavailable', waitMs: 5 * 60_000,
    text: 'Rezervasyon takvimi doğrulanamıyor. Resmî siteyi ve uzantının durumunu kontrol et.' };
}

async function checkCoverageInLanguage(store, api, ownerChatId, now = Date.now()) {
  if (!isOperatorChannel(api,ownerChatId)) return 'disabled';
  const problem = coverageProblem(store, now);
  let prior = store.state.coverageNotice || null;
  if (!problem) {
    // A deliberate pause is neither a failure nor a recovery.
    if (store.engine.health.lastState === 'paused') return 'paused';
    const reader=store.status().reader;
    if(reader&&(reader.phase!=='ready'||reader.fresh<reader.total))return 'recovering';
    if (prior) {
      store.state.coverageNotice = null;
      store.save();
    }
    return prior?.alerted ? 'recovered' : 'healthy';
  }
  const verification = problem.kind === 'waiting_verification';
  if (prior?.kind !== problem.kind) {
    const lastSeenAt = Date.parse(store.engine.health.lastSeenAt || '');
    // Staleness is measured from the last actual reading. Waiting a second
    // three-minute window after detecting it would alert six minutes late.
    // Before the first reading, keep a full startup grace period.
    const since = problem.kind === 'stale' && Number.isFinite(lastSeenAt)
      ? Math.min(lastSeenAt, now) : now;
    const verificationAlerted = prior?.verificationAlerted ?? (prior?.kind === 'waiting_verification' && prior.alerted === true);
    prior = {
      kind: problem.kind,
      since: prior?.since ?? since,
      alerted: prior?.alerted === true,
      ...(prior?.alertedAt ? { alertedAt: prior.alertedAt } : {}),
      verificationAlerted,
      ...(verification ? { verificationSince: now } : {})
    };
    store.state.coverageNotice = prior;
    store.save();
    if (now - since < problem.waitMs) return 'pending';
  }
  if (verification ? (prior.verificationAlerted ?? prior.alerted) : prior.alerted) return 'already_alerted';
  // The owner is only messaged when they can do something: sign-in
  // verification, credentials, a site block, or Chrome silent for 30 minutes.
  // Short calendar delays recover on their own and stay quiet.
  if (!OWNER_ACTION_KINDS.has(problem.kind)) return 'quiet';
  const waitMs = problem.kind === 'stale' ? STALE_OWNER_NOTICE_MS : problem.waitMs;
  const since = verification ? (prior.verificationSince ?? prior.since) : prior.since;
  if (now - Number(since) < waitMs) return 'pending';
  const text = problem.kind === 'stale'
    ? msg('ℹ️ Toplayıcıdan 30 dakikadır takvim gelmiyor. Sunucu ve okuyucu kontrol edilmeli.', 'ℹ️ No calendar has arrived from the collector for 30 minutes. Check the server and reader.')
    : `${msg('🔧 Yönetici işlemi gerekiyor','🔧 Operator action required')}\n${problemText(store,problem)}`;
  // A different warning cannot resolve a human verification requirement.
  // Keep this notice once per outage, even when an earlier alert used the budget.
  if(!await sendTechnicalNotice(store,api,ownerChatId,text,now,{useCooldown:!verification}))return 'cooldown';
  store.state.coverageNotice = { ...prior, alerted: true, alertedAt: now, ...(verification ? { verificationAlerted: true } : {}) };
  store.save();
  return 'alerted';
}

async function checkDeliveryHealthInLanguage(store, api, ownerChatId, now = Date.now()) {
  if (!isOperatorChannel(api,ownerChatId)) return 'disabled';
  const losses = store.state.outbox.filter(item =>
    ['failed', 'expired', 'uncertain'].includes(item.status) && typeof item.id === 'string');
  const retainedIds = new Set(losses.map(item => item.id));
  const prior = store.state.deliveryNotice;
  // On first activation, old failures are history rather than a new alarm.
  // Recent losses still deserve an alert after a service restart.
  const seen = new Set(Array.isArray(prior?.seenIds) ? prior.seenIds.filter(id => retainedIds.has(id))
    : losses.filter(item => {
      const at = Date.parse(item.failedAt || item.uncertainAt || '');
      return !Number.isFinite(at) || now - at > STARTUP_DELIVERY_LOOKBACK_MS;
    }).map(item => item.id));
  const newLosses = losses.filter(item => !seen.has(item.id));
  if (newLosses.length) {
    const failed = newLosses.filter(item => item.status === 'failed').length;
    const expired = newLosses.filter(item => item.status === 'expired').length;
    const uncertain = newLosses.filter(item => item.status === 'uncertain').length;
    if(!await sendTechnicalNotice(store,api,ownerChatId,
      msg(`⚠️ Bildirim tesliminde sorun var.\nGönderilemeyen: ${failed} · Süresi geçen: ${expired} · Sonucu belirsiz: ${uncertain}${uncertain?'\nBelirsiz mesajlar otomatik tekrar edilmiyor.':''}`,`⚠️ Notification delivery needs attention.\nFailed: ${failed} · Expired: ${expired} · Uncertain: ${uncertain}${uncertain?'\nMessages with an uncertain result are not resent automatically.':''}`),now))return 'cooldown';
    for (const item of newLosses) seen.add(item.id);
  }
  const nextSeen = [...seen];
  if (!prior || nextSeen.length !== prior.seenIds?.length
    || nextSeen.some((id, index) => id !== prior.seenIds[index])) {
    store.state.deliveryNotice = { seenIds: nextSeen };
    store.save();
  }
  return newLosses.length ? 'alerted' : 'healthy';
}

async function checkTelegramPollingInLanguage(store, api, ownerChatId, now = Date.now()) {
  if (!isOperatorChannel(api,ownerChatId)
      || store.telegramHealth.configured !== true) return 'disabled';
  const lastPollAt = Date.parse(store.telegramHealth.lastPollAt || '');
  const startedAt = Date.parse(store.telegramHealth.startedAt || '');
  const healthy = Number.isFinite(lastPollAt) && now - lastPollAt >= 0
    && now - lastPollAt < TELEGRAM_POLL_STALE_MS;
  const prior = store.state.telegramPollNotice || null;
  if (!Number.isFinite(lastPollAt) && Number.isFinite(startedAt)
      && now - startedAt >= 0 && now - startedAt < TELEGRAM_POLL_STALE_MS) {
    return prior?.alerted ? 'already_alerted' : 'starting';
  }
  if (!healthy) {
    if (prior?.alerted) {
      if (prior.recoverySince) {
        store.state.telegramPollNotice = { ...prior, recoverySince: null };
        store.save();
      }
      return 'already_alerted';
    }
    if (prior?.lastAlertAt && now - prior.lastAlertAt < TELEGRAM_POLL_ALERT_COOLDOWN_MS) return 'cooldown';
    if(!await sendTechnicalNotice(store,api,ownerChatId,msg('⚠️ Bot bağlantısı aksıyor. Otomatik yeniden deneniyor.','⚠️ The bot connection is interrupted. Retrying automatically.'),now))return 'cooldown';
    store.state.telegramPollNotice = { alerted: true, lastAlertAt: now, recoverySince: null };
    store.save();
    return 'alerted';
  }
  if (!prior?.alerted) return 'healthy';
  if (!prior.recoverySince) {
    store.state.telegramPollNotice = { ...prior, recoverySince: now };
    store.save();
    return 'recovering';
  }
  // One successful long-poll response followed by a stalled connection is
  // insufficient evidence that command handling really recovered.
  if (now - prior.recoverySince < TELEGRAM_POLL_RECOVERY_MS
      || lastPollAt - prior.recoverySince < CHECK_MS
      || now - lastPollAt > CHECK_MS + 15_000) return 'recovering';

  store.state.telegramPollNotice = { alerted: false, lastAlertAt: prior.lastAlertAt, recoverySince: null };
  store.save();
  return 'recovered';
}

export async function runCoverageLoop(store, api, ownerChatId, signal) {
  if (!isOperatorChannel(api,ownerChatId)) return;
  while (!signal.aborted) {
    try {
      await checkCoverage(store, api, ownerChatId);
    } catch (error) {
      store.state.operatorAlerts={...store.state.operatorAlerts,ready:false,reason:'send_unavailable',lastErrorAt:new Date().toISOString()};store.save();
      console.error(`${new Date().toISOString()} Yönetici bildirim kanalı geçici hata: HTTP ${error.status || 'network'}`);
    }
    // Delivery and polling hiccups recover on their own and are already in the
    // service log; they are no longer sent to the chat (owner's request).
    if (!signal.aborted) await delay(CHECK_MS, undefined, { signal }).catch(() => {});
  }
}

export function checkCoverage(store,api,ownerChatId,now=Date.now()){return withChatLanguage(store,ownerChatId,()=>checkCoverageInLanguage(store,api,ownerChatId,now));}

export function checkDeliveryHealth(store,api,ownerChatId,now=Date.now()){return withChatLanguage(store,ownerChatId,()=>checkDeliveryHealthInLanguage(store,api,ownerChatId,now));}

export function checkTelegramPolling(store,api,ownerChatId,now=Date.now()){return withChatLanguage(store,ownerChatId,()=>checkTelegramPollingInLanguage(store,api,ownerChatId,now));}
