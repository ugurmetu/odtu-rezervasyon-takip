import assert from 'node:assert/strict';
import test from 'node:test';
import { safeSlotTraceRows } from '../ops/slot-trace.mjs';

test('slot trace projects only calendar counts from a private state', () => {
  const secret = 'private-token-and-chat-id';
  const key = '2026-10-19|10:00|11:30';
  const rows = safeSlotTraceRows({
    botToken: secret,
    subscriptions: [{ chatId: secret }],
    outbox: [{ chatId: secret, text: secret }],
    engine: { pages: { privateKey: {
      facility: { id: '17', label: secret }, date: '2026-10-19',
      lastSuccessAt: '2026-10-19T06:00:00.000Z', observedSlotKeys: [key],
      slots: { [key]: { free: 9, confirmedFree: 8,
        pending: { previousFree: 8, targetFree: 9 } } }
    } } }
  });
  assert.deepEqual(rows, [{ facilityId: '17', date: '2026-10-19',
    observedAt: '2026-10-19T06:00:00.000Z',
    slots: [{ start: '10:00', end: '11:30', free: 9, confirmedFree: 8,
      visible: true, pending: 'up' }] }]);
  assert.equal(JSON.stringify(rows).includes(secret), false);
});
