import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const FACILITIES = Object.freeze([
  { id: 'fitness', name: 'Örnek Spor Salonu' },
  { id: 'pool', name: 'Örnek Yüzme Havuzu' },
]);

function dayAfter(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new TypeError('weekStart must be an ISO date');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function initialSessions(weekStart) {
  return new Map([
    ['fitness', [
      { id: 'fitness-morning', date: dayAfter(weekStart, 0), start: '07:00', end: '08:00', free: 0 },
      { id: 'fitness-evening', date: dayAfter(weekStart, 0), start: '17:00', end: '18:00', free: 1 },
    ]],
    ['pool', [
      { id: 'pool-noon', date: dayAfter(weekStart, 1), start: '12:00', end: '13:00', free: 2 },
      { id: 'pool-evening', date: dayAfter(weekStart, 2), start: '18:00', end: '19:00', free: 0 },
    ]],
  ]);
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 4096) throw new RangeError('request body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

/**
 * Starts a synthetic reservation-calendar server on loopback only.
 * No endpoint can create or cancel a reservation. No external request is made.
 */
export async function startFakeSite({ port = 0, weekStart = '2026-10-19', credentials = { username: 'demo', password: 'demo' } } = {}) {
  dayAfter(weekStart, 0);
  const sessions = initialSessions(weekStart);
  const activeSessions = new Set();
  const requestLog = [];
  let authMode = 'normal';
  let failure = null;

  const state = {
    requestLog,
    facilities: FACILITIES.map((item) => ({ ...item })),
    setSessions(facilityId, nextSessions) {
      if (!sessions.has(facilityId)) throw new RangeError(`unknown facility: ${facilityId}`);
      if (!Array.isArray(nextSessions)) throw new TypeError('sessions must be an array');
      sessions.set(facilityId, structuredClone(nextSessions));
    },
    getSessions(facilityId) {
      if (!sessions.has(facilityId)) throw new RangeError(`unknown facility: ${facilityId}`);
      return structuredClone(sessions.get(facilityId));
    },
    setFailure(statusOrOptions, count = Infinity) {
      if (statusOrOptions == null) {
        failure = null;
        return;
      }
      const status = typeof statusOrOptions === 'object' ? statusOrOptions.status : statusOrOptions;
      const remaining = typeof statusOrOptions === 'object' ? (statusOrOptions.count ?? Infinity) : count;
      if (!Number.isInteger(status) || ![403, 429].includes(status) && (status < 500 || status > 599)) {
        throw new RangeError('failure status must be 403, 429 or 5xx');
      }
      if (remaining !== Infinity && (!Number.isInteger(remaining) || remaining < 1)) {
        throw new RangeError('failure count must be a positive integer or Infinity');
      }
      failure = { status, remaining };
    },
    setAuthMode(mode) {
      if (!['normal', 'expired', 'turnstile'].includes(mode)) throw new RangeError('unknown auth mode');
      authMode = mode;
      if (mode !== 'normal') activeSessions.clear();
    },
    expireSession() {
      activeSessions.clear();
    },
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const entry = { method: request.method, path, facility: url.searchParams.get('facility'), status: null };
    requestLog.push(entry);
    const send = (status, body, headers) => {
      entry.status = status;
      json(response, status, body, headers);
    };

    try {
      if (request.method === 'POST' && (/^\/reservations(?:\/|$)/.test(path) || /^\/reservation(?:\/|$)/.test(path))) {
        send(405, { error: 'reservation_mutation_disabled' }, { allow: 'GET' });
        return;
      }
      if (request.method === 'GET' && path === '/health') {
        send(200, { ok: true, synthetic: true });
        return;
      }
      if (request.method === 'POST' && path === '/login') {
        if (authMode === 'turnstile') {
          send(403, { error: 'turnstile_required' });
          return;
        }
        if (authMode === 'expired') {
          send(401, { error: 'login_expired' });
          return;
        }
        const body = await readJson(request);
        if (body.username !== credentials.username || body.password !== credentials.password) {
          send(401, { error: 'invalid_credentials' });
          return;
        }
        const sessionId = randomUUID();
        activeSessions.add(sessionId);
        send(200, { ok: true }, { 'set-cookie': `pilot_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/` });
        return;
      }
      if (request.method === 'GET' && (path === '/facilities' || path === '/calendar')) {
        if (authMode === 'turnstile') {
          send(403, { error: 'turnstile_required' });
          return;
        }
        const sessionId = /(?:^|;\s*)pilot_session=([^;]+)/.exec(request.headers.cookie ?? '')?.[1];
        if (authMode === 'expired' || !sessionId || !activeSessions.has(sessionId)) {
          send(401, { error: 'login_expired' });
          return;
        }
        if (failure) {
          const status = failure.status;
          if (failure.remaining !== Infinity && --failure.remaining === 0) failure = null;
          send(status, { error: status === 429 ? 'rate_limited' : status === 403 ? 'access_denied' : 'site_unavailable' }, status === 429 ? { 'retry-after': '60' } : undefined);
          return;
        }
        if (path === '/facilities') {
          send(200, { facilities: FACILITIES });
          return;
        }
        const facilityId = url.searchParams.get('facility');
        if (!sessions.has(facilityId)) {
          send(404, { error: 'unknown_facility' });
          return;
        }
        send(200, { facility: facilityId, week: weekStart, sessions: structuredClone(sessions.get(facilityId)) });
        return;
      }
      send(404, { error: 'not_found' });
    } catch (error) {
      send(error instanceof RangeError ? 413 : 400, { error: 'bad_request' });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    state,
    close: () => new Promise((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
