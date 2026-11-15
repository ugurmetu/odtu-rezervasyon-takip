import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startFakeSite } from '../src/fake-site.mjs';

async function login(baseUrl) {
  const response = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'demo', password: 'demo' }),
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';', 1)[0];
}

function get(baseUrl, path, cookie) {
  return fetch(`${baseUrl}${path}`, { headers: { cookie } });
}

test('serves two synthetic weekly calendars on loopback and refuses reservation writes', async () => {
  const site = await startFakeSite();
  try {
    assert.equal(new URL(site.baseUrl).hostname, '127.0.0.1');
    const cookie = await login(site.baseUrl);
    const facilitiesResponse = await get(site.baseUrl, '/facilities', cookie);
    assert.equal(facilitiesResponse.status, 200);
    const { facilities } = await facilitiesResponse.json();
    assert.deepEqual(facilities.map((facility) => facility.id), ['fitness', 'pool']);

    for (const facility of facilities) {
      const response = await get(site.baseUrl, `/calendar?facility=${facility.id}`, cookie);
      assert.equal(response.status, 200);
      const calendar = await response.json();
      assert.equal(calendar.facility, facility.id);
      assert.equal(calendar.week, '2026-10-19');
      assert.ok(calendar.sessions.length >= 2);
      assert.ok(calendar.sessions.every((session) =>
        session.id && session.date && session.start && session.end && Number.isInteger(session.free)));
    }

    for (const path of ['/reservations', '/reservations/123/cancel', '/reservation/save']) {
      const response = await fetch(`${site.baseUrl}${path}`, { method: 'POST' });
      assert.equal(response.status, 405);
      assert.deepEqual(await response.json(), { error: 'reservation_mutation_disabled' });
    }
    assert.ok(site.state.requestLog.every((entry) => !('body' in entry) && !('cookie' in entry)));
  } finally {
    await site.close();
  }
});

test('supports changing free counts, expiring a session, and normal re-login', async () => {
  const site = await startFakeSite();
  try {
    let cookie = await login(site.baseUrl);
    const sessions = site.state.getSessions('fitness');
    sessions[0].free = 3;
    site.state.setSessions('fitness', sessions);
    const updated = await get(site.baseUrl, '/calendar?facility=fitness', cookie);
    assert.equal((await updated.json()).sessions[0].free, 3);

    site.state.expireSession();
    const expired = await get(site.baseUrl, '/calendar?facility=fitness', cookie);
    assert.equal(expired.status, 401);
    assert.deepEqual(await expired.json(), { error: 'login_expired' });

    cookie = await login(site.baseUrl);
    const recovered = await get(site.baseUrl, '/calendar?facility=fitness', cookie);
    assert.equal(recovered.status, 200);
  } finally {
    await site.close();
  }
});

test('simulates transient 5xx, rate limit, access denial and Turnstile', async () => {
  const site = await startFakeSite();
  try {
    const cookie = await login(site.baseUrl);
    site.state.setFailure(503, 1);
    const unavailable = await get(site.baseUrl, '/calendar?facility=pool', cookie);
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { error: 'site_unavailable' });
    assert.equal((await get(site.baseUrl, '/calendar?facility=pool', cookie)).status, 200);

    site.state.setFailure({ status: 429, count: 1 });
    const limited = await get(site.baseUrl, '/calendar?facility=pool', cookie);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '60');
    site.state.setFailure(403, 1);
    const denied = await get(site.baseUrl, '/calendar?facility=pool', cookie);
    assert.equal(denied.status, 403);

    site.state.setAuthMode('turnstile');
    const challenge = await get(site.baseUrl, '/calendar?facility=pool', cookie);
    assert.equal(challenge.status, 403);
    assert.deepEqual(await challenge.json(), { error: 'turnstile_required' });
    const loginChallenge = await fetch(`${site.baseUrl}/login`, { method: 'POST' });
    assert.equal(loginChallenge.status, 403);

    site.state.setAuthMode('expired');
    assert.equal((await get(site.baseUrl, '/calendar?facility=pool', cookie)).status, 401);
    site.state.setAuthMode('normal');
    const freshCookie = await login(site.baseUrl);
    assert.equal((await get(site.baseUrl, '/calendar?facility=pool', freshCookie)).status, 200);
  } finally {
    await site.close();
  }
});
