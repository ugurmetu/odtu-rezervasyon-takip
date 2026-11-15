import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

const MAX_SAMPLES = 2_016; // Seven days at five-minute intervals.
const CALENDAR_STATES = new Set([
  'ok', 'empty_unconfirmed', 'calendar_unavailable', 'login_required',
  'no_tab', 'paused', 'passive'
]);

function ageSeconds(timestamp, now) {
  const at = Date.parse(timestamp || '');
  return Number.isFinite(at) && at <= now ? Math.round((now - at) / 1_000) : null;
}

function sessionCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 200 ? value : null;
}

export function publicHealthSample(status, now = Date.now(), uptimeSeconds = process.uptime()) {
  const calendar = status?.lastObservation || {};
  const telegram = status?.telegram || {};
  return {
    at: new Date(now).toISOString(),
    uptimeSeconds: Math.round(uptimeSeconds),
    calendarState: CALENDAR_STATES.has(calendar.lastState) ? calendar.lastState : 'unknown',
    calendarAgeSeconds: ageSeconds(calendar.lastSeenAt, now),
    calendarSessionsIntermittent: status?.calendarCoverage?.intermittent === true,
    calendarObservedSessions: sessionCount(status?.calendarCoverage?.observedSessions),
    calendarRecordedSessions: sessionCount(status?.calendarCoverage?.recordedSessions),
    subscribedFacilityCount: sessionCount(status?.subscribedFacilityCoverage?.subscribed),
    freshSubscribedFacilityCount: sessionCount(status?.subscribedFacilityCoverage?.fresh),
    completeSubscribedFacilityCount: sessionCount(status?.subscribedFacilityCoverage?.complete),
    calendarDiagnostic: /^[a-z_]{1,50}$/.test(status?.lastDiagnostic || '')
      ? status.lastDiagnostic : '',
    telegramConfigured: telegram.configured === true,
    telegramPollAgeSeconds: ageSeconds(telegram.lastPollAt, now),
    queued: Number(status?.queued || 0),
    sending: Number(status?.sending || 0),
    uncertain: Number(status?.uncertain || 0),
    failed: Number(status?.failed || 0),
    expired: Number(status?.expired || 0),
    ownerCoverageAlerted: status?.coverageNotice?.alerted === true
  };
}

export function appendHealthSample(file, status, now = Date.now(), uptimeSeconds = process.uptime(),
  maxSamples = MAX_SAMPLES) {
  if (!Number.isSafeInteger(maxSamples) || maxSamples < 1) throw new TypeError('invalid sample limit');
  const sample = publicHealthSample(status, now, uptimeSeconds);
  let lines = [];
  try {
    lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  lines.push(JSON.stringify(sample));
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${lines.slice(-maxSamples).join('\n')}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  return sample;
}

export function summarizeHealthHistory(samples) {
  const rows = samples.filter(row => Number.isFinite(Date.parse(row?.at || '')))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const telegramStarting = rows.filter(row => row.telegramConfigured === true
    && row.telegramPollAgeSeconds === null && Number.isFinite(row.uptimeSeconds)
    && row.uptimeSeconds < 120).length;
  const telegramEvaluable = rows.filter(row => row.telegramConfigured === true
    && !(row.telegramPollAgeSeconds === null && Number.isFinite(row.uptimeSeconds)
      && row.uptimeSeconds < 120));
  let longestGapSeconds = 0;
  for (let index = 1; index < rows.length; index++) {
    longestGapSeconds = Math.max(longestGapSeconds,
      Math.round((Date.parse(rows[index].at) - Date.parse(rows[index - 1].at)) / 1_000));
  }
  const coverageRows = rows.filter(row => sessionCount(row.calendarObservedSessions) !== null
    && sessionCount(row.calendarRecordedSessions) !== null);
  const subscribedCoverageRows = rows.filter(row => sessionCount(row.subscribedFacilityCount) !== null
    && sessionCount(row.freshSubscribedFacilityCount) !== null
    && sessionCount(row.completeSubscribedFacilityCount) !== null);
  return {
    samples: rows.length,
    firstAt: rows[0]?.at || null,
    lastAt: rows.at(-1)?.at || null,
    calendarFresh: rows.filter(row => row.calendarState === 'ok'
      && Number.isFinite(row.calendarAgeSeconds) && row.calendarAgeSeconds <= 180).length,
    calendarIntermittent: rows.filter(row => row.calendarSessionsIntermittent === true).length,
    coverageSamples: coverageRows.length,
    observedSessionsMin: coverageRows.length
      ? Math.min(...coverageRows.map(row => row.calendarObservedSessions)) : null,
    observedSessionsMax: coverageRows.length
      ? Math.max(...coverageRows.map(row => row.calendarObservedSessions)) : null,
    lastObservedSessions: coverageRows.at(-1)?.calendarObservedSessions ?? null,
    lastRecordedSessions: coverageRows.at(-1)?.calendarRecordedSessions ?? null,
    subscribedCoverageSamples: subscribedCoverageRows.length,
    lastSubscribedFacilityCount: subscribedCoverageRows.at(-1)?.subscribedFacilityCount ?? null,
    lastFreshSubscribedFacilityCount: subscribedCoverageRows.at(-1)?.freshSubscribedFacilityCount ?? null,
    lastCompleteSubscribedFacilityCount: subscribedCoverageRows.at(-1)?.completeSubscribedFacilityCount ?? null,
    telegramFresh: telegramEvaluable.filter(row =>
      Number.isFinite(row.telegramPollAgeSeconds) && row.telegramPollAgeSeconds <= 180).length,
    telegramEvaluable: telegramEvaluable.length,
    telegramStarting,
    samplesWithDeliveryTrouble: rows.filter(row => row.queued > 0 || row.sending > 0 || row.failed > 0
      || row.uncertain > 0).length,
    ownerAlertSamples: rows.filter(row => row.ownerCoverageAlerted === true).length,
    longestGapSeconds
  };
}

export function assessLocalMonitoringWindow(samples, now = Date.now(),
  { maxConsecutivePollErrors = 0, requireCompleteCoverage = true } = {}) {
  const windowMs = 24 * 60 * 60_000;
  const maxGapMs = 6 * 60_000;
  const rows = samples.filter(row => {
    const at = Date.parse(row?.at || '');
    return Number.isFinite(at) && at >= now - windowMs && at <= now;
  }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const reasons = [];
  if (rows.length < 288 || !rows.length
    || Date.parse(rows[0].at) > now - windowMs + maxGapMs) reasons.push('insufficient_history');
  if (!rows.length || now - Date.parse(rows.at(-1).at) > maxGapMs) reasons.push('last_sample_stale');
  if (rows.some((row, index) => index > 0
    && Date.parse(row.at) - Date.parse(rows[index - 1].at) > maxGapMs)) reasons.push('sample_gap');
  if (rows.some(row => row.calendarState !== 'ok'
    || !Number.isFinite(row.calendarAgeSeconds) || row.calendarAgeSeconds > 180)) {
    reasons.push('calendar_not_fresh');
  }
  if (requireCompleteCoverage && rows.some(row => row.calendarSessionsIntermittent === true)) {
    reasons.push('calendar_sessions_intermittent');
  }
  // A missing coverage count is not proof that every known session appeared.
  // Keep this separate from transport continuity, which needs only a fresh
  // calendar response and an active Telegram poll.
  if (requireCompleteCoverage && rows.some(row =>
    sessionCount(row.calendarObservedSessions) === null
    || sessionCount(row.calendarRecordedSessions) === null
    || row.calendarRecordedSessions === 0)) {
    reasons.push('calendar_coverage_unverified');
  }
  if (requireCompleteCoverage && rows.some(row => {
    const subscribed = sessionCount(row.subscribedFacilityCount);
    const fresh = sessionCount(row.freshSubscribedFacilityCount);
    const complete = sessionCount(row.completeSubscribedFacilityCount);
    return subscribed === null || subscribed === 0 || fresh === null || complete === null
      || fresh !== subscribed || complete !== subscribed;
  })) reasons.push('subscribed_facility_coverage_unverified');
  if (rows.some(row => row.telegramConfigured !== true
    || !(Number.isFinite(row.telegramPollAgeSeconds) && row.telegramPollAgeSeconds <= 180)
      && !(row.telegramPollAgeSeconds === null && Number.isFinite(row.uptimeSeconds)
        && row.uptimeSeconds < 120))) {
    reasons.push('telegram_not_fresh');
  }
  if (rows.some(row => row.queued > 0 || row.sending > 0 || row.failed > 0 || row.uncertain > 0
    || (row.ownerCoverageAlerted === true
      && (requireCompleteCoverage || row.calendarSessionsIntermittent !== true)))) {
    reasons.push('delivery_or_coverage_trouble');
  }
  if (rows.some((row, index) => index > 0 && Number.isFinite(row.uptimeSeconds)
    && Number.isFinite(rows[index - 1].uptimeSeconds)
    && row.uptimeSeconds < rows[index - 1].uptimeSeconds)) reasons.push('process_restarted');
  // A restart very near the beginning of the window can fall between two
  // samples without making the sampled uptime counter decrease. The latest
  // process must itself have lived through the whole observation window.
  if (rows.length >= 288 && rows.length
    && Date.parse(rows[0].at) <= now - windowMs + maxGapMs) {
    const latestUptime = rows.at(-1).uptimeSeconds;
    const lastSampleAgeSeconds = (now - Date.parse(rows.at(-1).at)) / 1_000;
    const minimumUptimeSeconds = windowMs / 1_000 - lastSampleAgeSeconds - 60;
    if (!Number.isFinite(latestUptime) || latestUptime < minimumUptimeSeconds) {
      reasons.push('process_uptime_unverified');
    }
  }
  // An isolated network failure followed by a successful poll is visible in
  // the report, but does not by itself disprove continuous operation. A second
  // consecutive failure or stale poll does.
  if (maxConsecutivePollErrors >= 2) reasons.push('telegram_poll_repeated_errors');
  return { ready: reasons.length === 0, reasons, samples: rows.length,
    firstAt: rows[0]?.at || null, lastAt: rows.at(-1)?.at || null };
}
