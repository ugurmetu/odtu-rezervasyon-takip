import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupState } from '../ops/backup-state.mjs';
import { LocalStore } from '../src/store.mjs';

test('state backup captures a restorable revision without copying token files', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-backup-test-'));
  try {
    const file = join(folder, 'state.json');
    const backupDir = join(folder, 'backups');
    const store = new LocalStore(file);
    store.subscribe(123, 17);
    writeFileSync(join(folder, 'telegram-token'), 'test-secret', { mode: 0o600 });
    const backup = backupState(file, backupDir);
    store.unsubscribe(123, 17);
    assert.equal(new LocalStore(file).subscriptionsFor(123).length, 0);
    assert.equal((statSync(backupDir).mode & 0o777), 0o700);
    assert.equal((statSync(backup).mode & 0o777), 0o600);
    assert.equal(new LocalStore(backup).subscriptionsFor(123).length, 1);
    assert.equal(readFileSync(backup, 'utf8').includes('test-secret'), false);
    assert.equal(readdirSync(backupDir).length, 1);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('state backup refuses invalid data rather than writing a false recovery copy', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-backup-invalid-'));
  try {
    const file = join(folder, 'state.json');
    writeFileSync(file, '{broken');
    assert.throws(() => backupState(file, join(folder, 'backups')), /not valid JSON/);
    assert.equal(readdirSync(folder).includes('backups'), false);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
