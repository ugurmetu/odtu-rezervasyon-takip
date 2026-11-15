import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessLocalMonitoringWindow, summarizeHealthHistory } from '../src/health-history.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = resolve(project, '.local/health-history.ndjson');
let samples;
try {
  samples = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
} catch (error) {
  if (error.code === 'ENOENT') {
    console.log('Henüz sağlık örneği yok. Yerel servis başladığında ilk örnek alınır.');
    process.exit(0);
  }
  throw error;
}
const report = summarizeHealthHistory(samples);
// Five-minute snapshots can miss a brief getUpdates failure that recovers
// before the next sample. Count only timestamped polling errors in the local
// process log; older untimestamped lines cannot be placed in this window.
let transientPollErrors = [];
try {
  const now = Date.now();
  const since = now - 24 * 60 * 60_000;
  transientPollErrors = readFileSync(resolve(project, '.local/launchd.err.log'), 'utf8')
    .split('\n')
    .map(line => /^([^ ]+) Telegram bağlantısı geçici hata: HTTP (?:\d+|network); ardışık=(\d+)$/.exec(line))
    .filter(match => match && Number.isFinite(Date.parse(match[1]))
      && Date.parse(match[1]) >= since && Date.parse(match[1]) <= now)
    .map(match => ({ at: match[1], consecutive: Number(match[2]) }));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const maxConsecutivePollErrors = transientPollErrors.reduce(
  (max, item) => Math.max(max, item.consecutive), 0);
const window = assessLocalMonitoringWindow(samples, Date.now(), { maxConsecutivePollErrors });
const transportWindow = assessLocalMonitoringWindow(samples, Date.now(),
  { maxConsecutivePollErrors, requireCompleteCoverage: false });
console.log(`Sağlık örnekleri: ${report.samples}`);
if (report.samples) {
  console.log(`Aralık (UTC): ${report.firstAt} – ${report.lastAt}`);
  console.log(`Taze takvim: ${report.calendarFresh}/${report.samples} örnek`);
  console.log(`Önceden görülen seansların bir kısmı eksik: ${report.calendarIntermittent}/${report.samples} örnek`);
  if (report.coverageSamples) {
    console.log(`Seans sayısı: son ${report.lastObservedSessions}/${report.lastRecordedSessions}; gözlenen aralık ${report.observedSessionsMin}–${report.observedSessionsMax} (${report.coverageSamples} sayılı örnek)`);
  }
  if (report.subscribedCoverageSamples) {
    console.log(`Abonelikli tesisler: son ${report.lastFreshSubscribedFacilityCount}/${report.lastSubscribedFacilityCount} taze, ${report.lastCompleteSubscribedFacilityCount}/${report.lastSubscribedFacilityCount} tam kapsamlı (${report.subscribedCoverageSamples} sayılı örnek)`);
  } else console.log('Abonelikli tesislerin geçmiş kapsamı henüz ölçülmedi.');
  console.log(`Etkin Telegram yoklaması: ${report.telegramFresh}/${report.telegramEvaluable} değerlendirilebilir örnek; ${report.telegramStarting} başlangıç örneği`);
  console.log(`Bekleyen/gönderilen/belirsiz/başarısız bildirim görülen: ${report.samplesWithDeliveryTrouble} örnek`);
  console.log(`Sahip takvim uyarısı açık: ${report.ownerAlertSamples} örnek`);
  console.log(`En uzun örnek arası: ${report.longestGapSeconds} sn`);
  console.log(`Son 24 saatte Telegram yoklama hatası: ${transientPollErrors.length}; en yüksek ardışık sayı ${
    maxConsecutivePollErrors}${
    transientPollErrors.length ? `; sonuncusu ${transientPollErrors.at(-1).at}` : ''}`);
  console.log(`24 saatlik tam takip kabulü: ${window.ready ? 'koşullar sağlandı' : `bekliyor (${window.reasons.join(', ')})`}`);
  console.log(`24 saatlik servis ve Telegram sürekliliği: ${transportWindow.ready
    ? 'koşullar sağlandı' : `bekliyor (${transportWindow.reasons.join(', ')})`}`);
  console.log('Servis sürekliliği tek başına tüm seansların izlendiğini veya telefona gerçek boş yer bildirimi ulaştığını kanıtlamaz.');
  console.log('Beş dakikalık örnekler aradaki kısa kesintileri ve gerçek boş yer artışını tek başına kanıtlamaz; günlük dönerse eski hata sayısı eksik olabilir.');
}
