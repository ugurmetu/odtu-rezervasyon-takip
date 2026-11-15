import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionCoverage } from '../src/store.mjs';

// Read-only health check. It does not contact ODTÜ or Telegram, and it never
// prints the local ingest key, bot token, chat IDs, or subscription details.
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const key = readFileSync(resolve(project, '.local/ingest.key'), 'utf8').trim();
const endpoint = 'http://127.0.0.1:8765/health';
const freshWithinMs = 3 * 60_000;
const serviceModules = [
  'src/server.mjs', 'src/store.mjs', 'src/core.mjs',
  'src/telegram.mjs', 'src/coverage.mjs', 'src/health-history.mjs'
];

function ageSeconds(timestamp) {
  const time = Date.parse(timestamp || '');
  return Number.isFinite(time) ? Math.max(0, Math.round((Date.now() - time) / 1000)) : null;
}

let health;
let incompleteSubscribedFacilities = false;
try {
  const response = await fetch(endpoint, {
    headers: { 'X-Local-Key': key },
    signal: AbortSignal.timeout(3000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  health = await response.json();
} catch {
  console.error('Yerel rezervasyon servisi yanıt vermiyor.');
  process.exitCode = 1;
}

if (health) {
  const observation = health.lastObservation || {};
  const telegram = health.telegram || {};
  const calendarAge = ageSeconds(observation.lastSeenAt);
  const botAge = ageSeconds(telegram.lastPollAt);
  const freshCalendar = observation.lastState === 'ok'
    && calendarAge !== null && calendarAge * 1000 <= freshWithinMs;
  const recentEmpty = observation.lastState === 'empty_unconfirmed'
    && calendarAge !== null && calendarAge * 1000 <= freshWithinMs;
  const freshBot = telegram.configured === true
    && botAge !== null && botAge * 1000 <= freshWithinMs;

  console.log(`Yerel servis: ${health.ok === true ? 'çalışıyor' : 'sorun var'}`);
  const startedAt = Date.parse(telegram.startedAt || '');
  if (Number.isFinite(startedAt)) {
    const changedModules = serviceModules.filter(path => {
      try { return statSync(resolve(project, path)).mtimeMs > startedAt; }
      catch { return false; }
    });
    if (changedModules.length) {
      console.log(`Kod uyarısı: ${changedModules.join(', ')} çalışan süreç başladıktan sonra değişti; bu düzeltmeler canlı süreçte henüz etkin değil.`);
    }
  }
  const calendarMessage = freshCalendar ? 'güncel'
    : recentEmpty ? 'site yanıtı alındı, seans listesi boş; müsaitlik doğrulanmadı'
      : 'güncel okuma doğrulanmadı';
  console.log(`Takvim: ${calendarMessage}; son durum ${observation.lastState || 'yok'}; son okuma ${calendarAge === null ? 'yok' : `${calendarAge} sn önce`}`);
  const scope = health.calendarCoverage;
  if (scope) {
    console.log(`Seans kapsamı: son yanıtta ${scope.observedSessions}, bu gün önceden görülen ${scope.recordedSessions}${scope.intermittent ? '; bazı saatlerin güncel takibi doğrulanmıyor' : ''}`);
  }
  if (observation.lastFacility?.label) console.log(`Son tesis: ${observation.lastFacility.label}`);
  console.log(`Telegram: ${freshBot ? 'bağlantı etkin' : 'bağlantı doğrulanmadı'}; son yoklama ${botAge === null ? 'yok' : `${botAge} sn önce`}`);
  try {
    const state = JSON.parse(readFileSync(resolve(project, '.local/state.json'), 'utf8'));
    const approved = Array.isArray(state.betaApprovedChatIds) ? state.betaApprovedChatIds.length : 0;
    console.log(`Kapalı beta: ${approved} onaylı özel sohbet; ${Number(health.subscriptions || 0)} kayıtlı saat tercihi`);
    const subscribed = new Set((state.subscriptions ?? [])
      .filter(item => item?.active === true).map(item => String(item.facilityId)));
    if (subscribed.size) {
      const now = Date.now();
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(new Date(now)).filter(part => part.type !== 'literal')
        .map(part => [part.type, part.value]));
      const today = `${parts.year}-${parts.month}-${parts.day}`;
      const pages = Object.values(state.engine?.pages ?? {});
      const latestByFacility = new Map();
      for (const page of pages) {
        const id = String(page?.facility?.id ?? '');
        const at = Date.parse(page?.lastSuccessAt || '');
        if (!subscribed.has(id) || typeof page?.date !== 'string'
          || page.date < today || !Number.isFinite(at)) continue;
        if (at > (latestByFacility.get(id)?.at ?? -Infinity)) {
          latestByFacility.set(id, { page, at });
        }
      }
      let freshFacilities = 0;
      let completeFacilities = 0;
      for (const id of observation.lastState === 'ok' ? subscribed : []) {
        const latest = latestByFacility.get(id);
        if (!latest || latest.at > now + 30_000
          || now - latest.at > freshWithinMs) continue;
        freshFacilities++;
        const unit = state.facilityCatalog?.find(item => String(item.id) === id)?.unit;
        if (unit && !sessionCoverage(latest.page, now, unit).intermittent) completeFacilities++;
      }
      incompleteSubscribedFacilities = freshFacilities !== subscribed.size
        || completeFacilities !== subscribed.size;
      console.log(`Abonelikli tesis kapsamı: ${freshFacilities}/${subscribed.size} tesis taze; ${completeFacilities}/${subscribed.size} tesisin önceden görülen seansları son yanıtta tam`);
    }
    const lastAcceptedAt = Array.isArray(state.outbox)
      ? state.outbox.filter(item => item?.status === 'sent')
        .map(item => Date.parse(item.sentAt || ''))
        .filter(Number.isFinite).reduce((latest, at) => Math.max(latest, at), 0) : 0;
    if (lastAcceptedAt) {
      const localTime = new Intl.DateTimeFormat('tr-TR', {
        timeZone: 'Europe/Istanbul', dateStyle: 'short', timeStyle: 'medium'
      }).format(new Date(lastAcceptedAt));
      console.log(`Son boş yer mesajı Telegram API kabulü: ${localTime}; alıcı cihazda görünme ayrıca doğrulanmalıdır`);
    }
  } catch {
    console.log('Kapalı beta sohbet sayısı yerel durumdan okunamadı.');
    incompleteSubscribedFacilities = true;
  }
  if (health.coverageNotice?.alerted === true) {
    console.log(`Sahibe takip kesintisi uyarısı gönderildi: ${health.coverageNotice.kind}`);
  }
  console.log(`Bildirim kuyruğu: ${Number(health.queued || 0)} bekleyen, ${Number(health.sending || 0)} gönderilmekte, ${Number(health.uncertain || 0)} sonucu belirsiz, ${Number(health.failed || 0)} başarısız kayıt`);
  if (process.platform === 'darwin') {
    try {
      const power = execFileSync('pmset', ['-g', 'batt'], { encoding: 'utf8', timeout: 1000 });
      if (power.includes("Now drawing from 'Battery Power'")) {
        console.log('Güç: pilde. Uyku önleme yalnız adaptörde etkili; kapak açık kalmalı. Uyku sırasında takvim ve bildirimler duraklar.');
      } else if (power.includes("Now drawing from 'AC Power'")) {
        console.log('Güç: adaptöre bağlı. Adaptör kapak kapanınca oluşan uykuyu tek başına önlemez; kapak açık ve Chrome sekmesi etkin kalmalı.');
      }
    } catch { /* Power source is optional diagnostic data. */ }
  }
  if (Number(health.expired || 0) > 0) {
    const expiredAge = ageSeconds(health.lastExpiredAt);
    console.log(`Süresi geçmiş boş yer uyarısı: ${Number(health.expired)}; sonuncusu ${expiredAge === null ? 'bilinmiyor' : `${expiredAge} sn önce`}. Eski uyarılar gönderilmedi.`);
  }

  if (health.ok !== true || !freshCalendar || scope?.intermittent
    || incompleteSubscribedFacilities || !freshBot || Number(health.queued || 0) > 0
    || Number(health.sending || 0) > 0 || Number(health.uncertain || 0) > 0
    || Number(health.failed || 0) > 0) process.exitCode = 2;
}
