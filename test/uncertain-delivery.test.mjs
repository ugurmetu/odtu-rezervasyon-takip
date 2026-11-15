import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../src/store.mjs';
import { flushOutbox } from '../src/telegram.mjs';

const INVITE = 'synthetic_invite_only';
const tomorrow = () => new Date(Date.now() + 48 * 60 * 60_000).toISOString().slice(0, 10);

function queuedStore(file) {
  const store = new LocalStore(file, { betaInviteCode: INVITE });
  store.setFacilityCatalog([{ id: '17', label: 'Sample Fitness', unit: 'Spor Müdürlüğü' }]);
  assert.equal(store.approveBetaChat(123, INVITE), 'approved');
  store.state.outbox.push({ id: 'vacancy-1', chatId: '123', attempts: 0,
    nextAt: Date.now() - 1, status: 'queued', event: {
      facility: { id: '17', label: 'Sample Fitness' }, date: tomorrow(),
      start: '11:00', end: '12:45', free: 1,
      observedAt: new Date().toISOString()
    } });
  store.save();
  return store;
}

test('an ambiguous Telegram HTTP response is quarantined without a duplicate retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rez-ambiguous-send-'));
  const file = join(dir, 'state.json');
  try {
    const store = queuedStore(file);
    let attempts = 0;
    const api = { async sendMessage() {
      attempts++;
      const error = new Error('gateway response unavailable');
      error.status = 502;
      throw error;
    } };
    assert.equal(await flushOutbox(store, api), 1);
    assert.equal(store.status().uncertain, 1);
    assert.equal(store.status().queued, 0);
    assert.equal(store.state.outbox[0].event, undefined);
    assert.equal(await flushOutbox(store, api), 0);
    assert.equal(attempts, 1);
    const restarted = new LocalStore(file, { betaInviteCode: INVITE });
    assert.equal(restarted.status().uncertain, 1);
    assert.deepEqual(restarted.dueDeliveries(), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an interrupted in-flight send cannot replay after service restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rez-interrupted-send-'));
  const file = join(dir, 'state.json');
  try {
    const store = queuedStore(file);
    assert.equal(store.beginDelivery('vacancy-1'), true);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).outbox[0].status, 'sending');
    const restarted = new LocalStore(file, { betaInviteCode: INVITE });
    assert.equal(restarted.state.outbox[0].status, 'uncertain');
    assert.equal(restarted.state.outbox[0].reason, 'send_result_unknown_after_restart');
    assert.deepEqual(restarted.dueDeliveries(), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a lost socket response remains uncertain while a definite 429 remains retryable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rez-send-classification-'));
  try {
    const socketStore = queuedStore(join(dir, 'socket.json'));
    let socketCalls = 0;
    const socketApi = { async sendMessage() { socketCalls++; throw new Error('socket closed'); } };
    await flushOutbox(socketStore, socketApi);
    await flushOutbox(socketStore, socketApi);
    assert.equal(socketCalls, 1);
    assert.equal(socketStore.status().uncertain, 1);

    const limitedStore = queuedStore(join(dir, 'limited.json'));
    let limitedCalls = 0;
    const limitedApi = { async sendMessage() {
      limitedCalls++;
      if (limitedCalls === 1) {
        const error = new Error('rate limited');
        error.status = 429;
        error.retryAfterMs = 5_000;
        throw error;
      }
      return { message_id: 1 };
    } };
    assert.equal(await flushOutbox(limitedStore, limitedApi), 1);
    assert.equal(limitedStore.state.outbox[0].status, 'queued');
    limitedStore.state.outbox[0].nextAt = Date.now() - 1;
    assert.equal(await flushOutbox(limitedStore, limitedApi), 0);
    // Model the server-requested window ending, not just one queue row's due time.
    limitedStore.state.deliveryBlockedUntil = Date.now() - 1;
    assert.equal(await flushOutbox(limitedStore, limitedApi), 1);
    assert.equal(limitedStore.state.outbox[0].status, 'sent');
    assert.equal(limitedStore.state.outbox[0].attempts, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
