import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendHealthSample, assessLocalMonitoringWindow, publicHealthSample, summarizeHealthHistory } from '../src/health-history.mjs';

test('health history keeps only bounded operational fields and no account data', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-health-history-'));
  try {
    const file = join(folder, 'health.ndjson');
    const now = Date.parse('2026-10-18T20:00:00Z');
    const health = {
      lastObservation: { lastState: 'ok', lastSeenAt: new Date(now - 30_000).toISOString(),
        lastFacility: { id: '17', label: 'private facility' } },
      lastDiagnostic: 'calendar_day_advanced',
      calendarCoverage: { observedSessions: 1, recordedSessions: 2, intermittent: true },
      subscribedFacilityCoverage: { subscribed: 2, fresh: 1, complete: 0 },
      telegram: { configured: true, lastPollAt: new Date(now - 5_000).toISOString(),
        token: 'private-token', chatId: 'private-chat' },
      queued: 1, sending: 1, uncertain: 1, failed: 0, expired: 2, subscriptions: [{ chatId: 'private-chat' }],
      coverageNotice: { alerted: true }
    };
    assert.equal(publicHealthSample(health, now, 20).calendarAgeSeconds, 30);
    appendHealthSample(file, health, now, 20, 2);
    appendHealthSample(file, health, now + 5 * 60_000, 320, 2);
    appendHealthSample(file, health, now + 10 * 60_000, 620, 2);
    const raw = readFileSync(file, 'utf8');
    const rows = raw.trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].calendarAgeSeconds, 330);
    assert.equal(rows[1].calendarAgeSeconds, 630);
    assert.equal(rows[1].telegramPollAgeSeconds, 605);
    assert.equal(rows[1].queued, 1);
    assert.equal(rows[1].sending, 1);
    assert.equal(rows[1].uncertain, 1);
    assert.equal(rows[1].calendarSessionsIntermittent, true);
    assert.equal(rows[1].calendarObservedSessions, 1);
    assert.equal(rows[1].calendarRecordedSessions, 2);
    assert.equal(rows[1].subscribedFacilityCount, 2);
    assert.equal(rows[1].freshSubscribedFacilityCount, 1);
    assert.equal(rows[1].completeSubscribedFacilityCount, 0);
    const coverage = summarizeHealthHistory(rows);
    assert.equal(coverage.coverageSamples, 2);
    assert.equal(coverage.observedSessionsMin, 1);
    assert.equal(coverage.lastRecordedSessions, 2);
    assert.equal(coverage.subscribedCoverageSamples, 2);
    assert.equal(coverage.lastFreshSubscribedFacilityCount, 1);
    assert.equal(rows[1].ownerCoverageAlerted, true);
    assert.doesNotMatch(raw, /private|chatId|token|"subscriptions"|"facility"/i);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('unexpected status text is suppressed in health history', () => {
  const sample = publicHealthSample({
    lastObservation: { lastState: 'private-token' }, lastDiagnostic: 'private:token'
  }, Date.parse('2026-10-18T20:00:00Z'), 0);
  assert.equal(sample.calendarState, 'unknown');
  assert.equal(sample.calendarDiagnostic, '');
  assert.equal(publicHealthSample({ calendarCoverage: { observedSessions: 999,
    recordedSessions: 'private' } }, Date.parse('2026-10-18T20:00:00Z'), 0).calendarObservedSessions, null);
});

test('health report reveals stale samples and observation gaps without treating them as uptime', () => {
  const report = summarizeHealthHistory([
    { at: '2026-10-18T20:15:00.000Z', calendarState: 'ok', calendarAgeSeconds: 30,
      telegramConfigured: true, telegramPollAgeSeconds: 20, queued: 0, failed: 0 },
    { at: '2026-10-18T20:00:00.000Z', calendarState: 'ok', calendarAgeSeconds: 300,
      telegramConfigured: true, telegramPollAgeSeconds: null, queued: 1, failed: 0,
      ownerCoverageAlerted: true }
  ]);
  assert.equal(report.samples, 2);
  assert.equal(report.calendarFresh, 1);
  assert.equal(report.coverageSamples, 0);
  assert.equal(report.telegramFresh, 1);
  assert.equal(report.samplesWithDeliveryTrouble, 1);
  assert.equal(report.ownerAlertSamples, 1);
  assert.equal(report.longestGapSeconds, 900);
});

test('health report separates a new process waiting for its first Telegram poll', () => {
  const report = summarizeHealthHistory([
    { at: '2026-10-18T20:00:00.000Z', uptimeSeconds: 0,
      telegramConfigured: true, telegramPollAgeSeconds: null },
    { at: '2026-10-18T20:05:00.000Z', uptimeSeconds: 300,
      telegramConfigured: true, telegramPollAgeSeconds: 10 }
  ]);
  assert.equal(report.telegramStarting, 1);
  assert.equal(report.telegramEvaluable, 1);
  assert.equal(report.telegramFresh, 1);
});

test('24-hour local monitoring gate needs a continuous and fresh sample window', () => {
  const now = Date.parse('2026-10-19T21:00:00Z');
  const rows = Array.from({ length: 289 }, (_, index) => ({
    at: new Date(now - 24 * 60 * 60_000 + index * 5 * 60_000).toISOString(),
    uptimeSeconds: 1000 + index * 300,
    calendarState: 'ok', calendarAgeSeconds: 30,
    calendarObservedSessions: 7, calendarRecordedSessions: 7,
    subscribedFacilityCount: 2, freshSubscribedFacilityCount: 2,
    completeSubscribedFacilityCount: 2,
    telegramConfigured: true, telegramPollAgeSeconds: 10,
    queued: 0, failed: 0, ownerCoverageAlerted: false
  }));
  assert.equal(assessLocalMonitoringWindow(rows, now).ready, true);
  const missingFacility = rows.map(row => ({ ...row }));
  missingFacility[40].freshSubscribedFacilityCount = 1;
  missingFacility[40].completeSubscribedFacilityCount = 1;
  assert.deepEqual(assessLocalMonitoringWindow(missingFacility, now).reasons,
    ['subscribed_facility_coverage_unverified']);
  assert.equal(assessLocalMonitoringWindow(missingFacility, now,
    { requireCompleteCoverage: false }).ready, true);
  const oldHistory = rows.map(row => ({ ...row }));
  delete oldHistory[40].subscribedFacilityCount;
  assert.deepEqual(assessLocalMonitoringWindow(oldHistory, now).reasons,
    ['subscribed_facility_coverage_unverified']);
  const emptyCalendar = rows.map(row => ({ ...row }));
  emptyCalendar[40].calendarObservedSessions = 0;
  emptyCalendar[40].calendarRecordedSessions = 0;
  assert.deepEqual(assessLocalMonitoringWindow(emptyCalendar, now).reasons,
    ['calendar_coverage_unverified']);
  const missingCoverage = rows.map(row => ({ ...row }));
  missingCoverage[40].calendarObservedSessions = null;
  assert.deepEqual(assessLocalMonitoringWindow(missingCoverage, now).reasons,
    ['calendar_coverage_unverified']);
  assert.equal(assessLocalMonitoringWindow(missingCoverage, now,
    { requireCompleteCoverage: false }).ready, true);
  const intermittent = rows.map(row => ({ ...row }));
  intermittent[40].calendarSessionsIntermittent = true;
  intermittent[40].ownerCoverageAlerted = true;
  assert.deepEqual(assessLocalMonitoringWindow(intermittent, now).reasons,
    ['calendar_sessions_intermittent', 'delivery_or_coverage_trouble']);
  assert.equal(assessLocalMonitoringWindow(intermittent, now,
    { requireCompleteCoverage: false }).ready, true);
  intermittent[41].queued = 1;
  assert.deepEqual(assessLocalMonitoringWindow(intermittent, now,
    { requireCompleteCoverage: false }).reasons, ['delivery_or_coverage_trouble']);
  intermittent[41].queued = 0;
  intermittent[41].uncertain = 1;
  assert.deepEqual(assessLocalMonitoringWindow(intermittent, now,
    { requireCompleteCoverage: false }).reasons, ['delivery_or_coverage_trouble']);
  intermittent[41].uncertain = 0;
  intermittent[41].sending = 1;
  assert.deepEqual(assessLocalMonitoringWindow(intermittent, now,
    { requireCompleteCoverage: false }).reasons, ['delivery_or_coverage_trouble']);
  intermittent[41].sending = 0;
  intermittent[42].ownerCoverageAlerted = true;
  assert.deepEqual(assessLocalMonitoringWindow(intermittent, now,
    { requireCompleteCoverage: false }).reasons, ['delivery_or_coverage_trouble']);
  assert.equal(assessLocalMonitoringWindow(rows, now, { maxConsecutivePollErrors: 1 }).ready, true);
  assert.deepEqual(assessLocalMonitoringWindow(rows, now, { maxConsecutivePollErrors: 2 }).reasons,
    ['telegram_poll_repeated_errors']);
  rows[0].telegramPollAgeSeconds = null;
  rows[0].uptimeSeconds = 60;
  assert.equal(assessLocalMonitoringWindow(rows, now).ready, true);
  assert.deepEqual(assessLocalMonitoringWindow(rows.slice(0, 20), now).reasons,
    ['insufficient_history', 'last_sample_stale']);
  const broken = rows.map(row => ({ ...row }));
  broken[100].calendarAgeSeconds = 400;
  broken[120].uptimeSeconds = 10;
  assert.deepEqual(assessLocalMonitoringWindow(broken, now).reasons,
    ['calendar_not_fresh', 'process_restarted']);
  broken.splice(130, 2);
  assert.ok(assessLocalMonitoringWindow(broken, now).reasons.includes('sample_gap'));

  const earlyRestartNotSeenBySamples = rows.map((row, index) => ({ ...row,
    uptimeSeconds: index === 0 ? 0 : (index - 1) * 300 + 1 }));
  assert.deepEqual(assessLocalMonitoringWindow(earlyRestartNotSeenBySamples, now).reasons,
    ['process_uptime_unverified']);
  earlyRestartNotSeenBySamples.at(-1).uptimeSeconds = null;
  assert.deepEqual(assessLocalMonitoringWindow(earlyRestartNotSeenBySamples, now).reasons,
    ['process_uptime_unverified']);
});
