import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const origin = 'https://rez.metu.edu.tr';

async function captureContentEvidence(evidence) {
  let onRuntimeMessage;
  const chrome = { runtime: { onMessage: { addListener(listener) { onRuntimeMessage = listener; } } } };
  runInNewContext(readFileSync(new URL('../content.js', import.meta.url), 'utf8'), {
    chrome, location: { origin, href: `${origin}/view/home.jsf` }, document: {},
    RezCalendarParser: { extract: () => ({ state: 'ok' }),
      extractFreshEvents: (_doc, _url, result) => result.ok
        ? { schema: 1, state: 'ok', fresh: true, slots: [] } : null },
    Date
  });
  return new Promise((resolve) => {
    onRuntimeMessage({ type: 'rez:parse', evidence }, {}, resolve);
  });
}

function evidenceFor(result) {
  if (result?.state === 'login_required') return { ok: false, reason: 'login_required' };
  if (result?.state === 'calendar_unavailable' && result.detail) {
    return { ok: false, reason: result.detail };
  }
  return { ok: true, date: '2026-10-18', facilityId: '17',
    refreshId: '123e4567-e89b-42d3-a456-426614174000', events: [] };
}

async function captureBackgroundScenario({ result, rejectMessage = false, rejectQuery = false,
  tabs = [{ id: 1, url: `${origin}/view/home.jsf`, lastAccessed: 1 }], targetTabId = null }) {
  let onAlarm;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const storage = { paused: false, lastAttemptAt: 0, targetTabId };
  let sent;
  let captures = 0;
  let capturedTabId = null;
  const chrome = {
    alarms: {
      get: async () => ({ name: 'rez-calendar-capture' }),
      onAlarm: { addListener(listener) { onAlarm = listener; } },
      create: async () => {}
    },
    runtime: {
      getURL: () => 'chrome-extension://pilot/local-config.json',
      onInstalled: { addListener() {} }, onStartup: { addListener() {} },
      onMessage: { addListener() {} }
    },
    storage: { local: {
      get: async () => ({ ...storage }),
      set: async (value) => {
        Object.assign(storage, value);
        if (value.lastStatus) finish(value.lastStatus);
      }
    } },
    tabs: {
      query: async () => {
        if (rejectQuery) throw new Error('private account data');
        return tabs;
      },
      sendMessage: async (_tabId, message) => {
        assert.equal(message.type, 'rez:parse');
        if (rejectMessage) throw new Error('private account data');
        return result;
      }
    },
    scripting: { executeScript: async (injection) => {
      captures += 1;
      capturedTabId = injection.target.tabId;
      assert.deepEqual(Array.from(injection.target.frameIds), [0]);
      assert.equal(injection.world, 'MAIN');
      assert.deepEqual(Array.from(injection.files), ['main.js']);
      return [{ frameId: 0, result: evidenceFor(result) }];
    } }
  };
  const fetch = async (url) => String(url).startsWith('chrome-extension:')
    ? { ok: true, json: async () => ({ ingestUrl: 'http://127.0.0.1:8765/ingest',
      key: 'a'.repeat(64) }) }
    : { ok: true, json: async () => ({ ok: true }) };
  const recordingFetch = async (url, options) => {
    if (String(url).startsWith('chrome-extension:') || String(url).endsWith('/health')) return fetch(url);
    sent = JSON.parse(options.body);
    return { ok: true };
  };
  runInNewContext(readFileSync(new URL('../background.js', import.meta.url), 'utf8'), {
    chrome, fetch: recordingFetch, Date, AbortController, setTimeout, clearTimeout
  });
  onAlarm({ name: 'rez-calendar-capture' });
  const status = await done;
  return { status, sent, storage, captures, capturedTabId, onAlarm };
}

async function captureBackgroundDetail(detail) {
  return captureBackgroundScenario({ result: { schema: 1, state: 'calendar_unavailable',
    fresh: false, slots: [], detail } });
}

test('isolated parser accepts only browser-delivered evidence', async () => {
  const known = await captureContentEvidence({ ok: false, reason: 'no_schedule_request' });
  assert.equal(known.state, 'calendar_unavailable');
  assert.equal(known.detail, 'unverified_response');
  assert.equal(known.fresh, false);

  const verified = await captureContentEvidence({ ok: true });
  assert.equal(verified.fresh, true);
});

test('background shows only approved diagnostic codes in lastStatus', async () => {
  const known = await captureBackgroundDetail('unverified_response');
  assert.equal(known.status.state, 'calendar_unavailable');
  assert.equal(known.status.detail, 'unverified_response');
  assert.equal(known.sent.detail, 'unverified_response');

  const unknown = await captureBackgroundDetail('private response text');
  assert.equal(unknown.status.detail, 'calendar_unavailable');
  assert.equal(unknown.sent.detail, 'calendar_unavailable');
  assert.equal(JSON.stringify(unknown).includes('private response text'), false);

  const expired = await captureBackgroundDetail('calendar_date_expired');
  assert.equal(expired.status.detail, 'calendar_date_expired');
  assert.equal(expired.sent.detail, 'calendar_date_expired');
});

test('missing or malformed content responses are distinct without exposing error text', async () => {
  const noResponse = await captureBackgroundScenario({ result: undefined });
  assert.equal(noResponse.status.detail, 'content_no_response');
  assert.equal(noResponse.sent.detail, 'content_no_response');

  const malformed = await captureBackgroundScenario({ result: { schema: 1,
    state: 'ok', fresh: true, slots: [], refresh_id: 'bad' } });
  assert.equal(malformed.status.detail, 'invalid_capture_payload');
  assert.equal(malformed.sent.detail, 'invalid_capture_payload');

  const unreachable = await captureBackgroundScenario({ rejectMessage: true });
  assert.equal(unreachable.status.detail, 'content_unreachable');
  assert.equal(JSON.stringify(unreachable).includes('private account data'), false);

  const queryFailure = await captureBackgroundScenario({ rejectQuery: true });
  assert.equal(queryFailure.status.detail, 'tab_query_failed');
  assert.equal(JSON.stringify(queryFailure).includes('private account data'), false);
});

test('site 403 and 429 stop future calendar requests until manually restarted', async () => {
  for (const detail of ['site_access_denied', 'site_rate_limited']) {
    const result = await captureBackgroundDetail(detail);
    assert.equal(result.status.detail, detail);
    assert.equal(result.sent.state, 'calendar_unavailable');
    assert.equal(result.sent.fresh, false);
    assert.equal(result.storage.paused, true);
    assert.equal(result.storage.pausedReason, detail);
    result.onAlarm({ name: 'rez-calendar-capture' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(result.captures, 1);
  }
});

test('an expired login pauses site polling until the user restarts', async () => {
  const result = await captureBackgroundScenario({ result: { schema: 1, state: 'login_required',
    fresh: false, slots: [] } });
  assert.equal(result.status.state, 'login_required');
  assert.equal(result.sent.state, 'login_required');
  assert.equal(result.sent.fresh, false);
  assert.equal(result.storage.paused, true);
  assert.equal(result.storage.pausedReason, 'login_required');
  result.onAlarm({ name: 'rez-calendar-capture' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.captures, 1);
});

test('pilot pins one reservation tab instead of switching to a more recently used tab', async () => {
  const tabs = [
    { id: 1, url: `${origin}/view/home.jsf`, lastAccessed: 1 },
    { id: 2, url: `${origin}/view/home.jsf`, lastAccessed: 2 }
  ];
  const result = { schema: 1, state: 'calendar_unavailable', fresh: false, slots: [] };
  const first = await captureBackgroundScenario({ result, tabs });
  assert.equal(first.capturedTabId, 2);
  assert.equal(first.storage.targetTabId, 2);

  const pinned = await captureBackgroundScenario({ result, tabs, targetTabId: 1 });
  assert.equal(pinned.capturedTabId, 1);
  assert.equal(pinned.storage.targetTabId, 1);

  const missing = await captureBackgroundScenario({ result, tabs, targetTabId: 3 });
  assert.equal(missing.captures, 0);
  assert.equal(missing.sent.state, 'no_tab');

  const reopened = await captureBackgroundScenario({ result,
    tabs: [tabs[1]], targetTabId: 3 });
  assert.equal(reopened.capturedTabId, 2);
  assert.equal(reopened.storage.targetTabId, 2);

  const redirected = await captureBackgroundScenario({ result,
    tabs: [{ id: 1, url: `${origin}/view/login.jsf` }, tabs[1]], targetTabId: 1 });
  assert.equal(redirected.captures, 0);
  assert.equal(redirected.status.state, 'login_required');
  assert.equal(redirected.storage.paused, true);

  const actualLogin = await captureBackgroundScenario({ result,
    tabs: [{ id: 1, url: `${origin}/index.jsf` }], targetTabId: 1 });
  assert.equal(actualLogin.captures, 0);
  assert.equal(actualLogin.status.state, 'login_required');
  assert.equal(actualLogin.sent.state, 'login_required');
  assert.equal(actualLogin.storage.paused, true);
});
