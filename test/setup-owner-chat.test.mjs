import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureOwnerChat } from '../ops/setup-owner-chat.mjs';

test('ilk davetli, açık sahip kimliği olmadan sahip olamaz', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rez-owner-'));
  const stateFile = join(dir, 'state.json');
  const ownerFile = join(dir, 'owner-chat-id');
  writeFileSync(stateFile, JSON.stringify({ betaApprovedChatIds: ['12345'] }));

  assert.throws(() => configureOwnerChat({ stateFile, ownerFile }), /--chat-id/);
  assert.equal(configureOwnerChat({ stateFile, ownerFile, chatId: '12345' }), 'created');
  assert.equal(readFileSync(ownerFile, 'utf8'), '12345\n');
  assert.equal(statSync(ownerFile).mode & 0o777, 0o600);
});

test('mevcut sahip kimliği başka bir davetliyle değiştirilmez', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rez-owner-'));
  const stateFile = join(dir, 'state.json');
  const ownerFile = join(dir, 'owner-chat-id');
  writeFileSync(stateFile, JSON.stringify({ betaApprovedChatIds: ['12345', '67890'] }));
  writeFileSync(ownerFile, '12345\n');

  assert.throws(() => configureOwnerChat({ stateFile, ownerFile, chatId: '67890' }), /farklı/);
  assert.equal(configureOwnerChat({ stateFile, ownerFile }), 'already_configured');
  assert.equal(readFileSync(ownerFile, 'utf8'), '12345\n');
});

test('davet onayı olmayan kimlik sahip yapılamaz', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rez-owner-'));
  const stateFile = join(dir, 'state.json');
  const ownerFile = join(dir, 'owner-chat-id');
  writeFileSync(stateFile, JSON.stringify({ betaApprovedChatIds: ['12345'] }));

  assert.throws(() => configureOwnerChat({ stateFile, ownerFile, chatId: '67890' }), /onaylı/);
});
