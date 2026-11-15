import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scheduledBackup } from '../ops/vps/scheduled-backup.mjs';
import { LocalStore } from '../src/store.mjs';

test('scheduled copy restores preferences and offset offline without changing the live state or copying secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rez-scheduled-'));
  try {
    const file = join(dir, 'state.json'), backups = join(dir, 'backups');
    const store = new LocalStore(file); store.subscribe(123, 17);
    store.state.telegramOffset = 321; store.save();
    writeFileSync(join(dir, 'telegram-token'), 'not-for-backup', { mode: 0o600 });
    const before = readFileSync(file), result = scheduledBackup(file, backups);
    assert.equal(result.ok, true); assert.deepEqual(readFileSync(file), before);
    const copy = join(backups, readdirSync(backups)[0]);
    assert.deepEqual(readFileSync(copy), before);
    assert.equal(statSync(copy).mode & 0o777, 0o600);
    assert.equal(statSync(backups).mode & 0o777, 0o700);
    assert.equal(readFileSync(copy, 'utf8').includes('not-for-backup'), false);
    const restored = new LocalStore(copy);
    assert.equal(restored.subscriptionsFor(123).length, 1);
    assert.equal(restored.state.telegramOffset, 321);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('retention only removes its own valid copies, preserves manual, corrupt and symlink files, and keeps the new copy on clock regression', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rez-retention-'));
  try {
    const file = join(dir, 'state.json'), backups = join(dir, 'backups');
    new LocalStore(file).save();
    scheduledBackup(file, backups, { keep: 2 });
    const manual = join(backups, 'before-deploy.json'); writeFileSync(manual, readFileSync(file), { mode: 0o600 });
    const corrupt = join(backups, 'scheduled-state-20260101T000000000Z-abcdefab.json'); writeFileSync(corrupt, '{broken', { mode: 0o600 });
    const link = join(backups, 'scheduled-state-20260102T000000000Z-abcdefab.json'); symlinkSync(file, link);
    for (let i = 0; i < 4; i++) scheduledBackup(file, backups, { keep: 2 });
    const result = scheduledBackup(file, backups, { keep: 2, now: new Date('2020-01-01T00:00:00Z') });
    assert.equal(result.pruned, 1);
    assert.deepEqual(readFileSync(manual), readFileSync(file));
    assert.equal(readFileSync(corrupt, 'utf8'), '{broken');
    const regular = readdirSync(backups, { withFileTypes: true }).filter(e => e.isFile() && e.name.startsWith('scheduled-') && e.name !== corrupt.split('/').at(-1));
    assert.equal(regular.length, 2);
    assert.ok(regular.some(e => e.name.startsWith('scheduled-state-20200101')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('invalid live state cannot replace or prune an earlier good backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rez-backup-invalid-'));
  try {
    const file = join(dir, 'state.json'), backups = join(dir, 'backups');
    new LocalStore(file).save(); scheduledBackup(file, backups, { keep: 2 });
    const before = readdirSync(backups); writeFileSync(file, '{broken');
    assert.throws(() => scheduledBackup(file, backups, { keep: 2 }));
    assert.deepEqual(readdirSync(backups), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('systemd timer is persistent and backup job is independent and has no network access', () => {
  const service = readFileSync(new URL('../ops/vps/odtu-rez-backup.service', import.meta.url), 'utf8');
  const timer = readFileSync(new URL('../ops/vps/odtu-rez-backup.timer', import.meta.url), 'utf8');
  assert.match(service, /User=rez/); assert.match(service, /PrivateNetwork=true/);
  assert.match(service, /ReadWritePaths=\/var\/lib\/odtu-rez\/private\/backups/);
  assert.doesNotMatch(service, /Restart=|odtu-rez-browser|src\/server/);
  assert.match(timer, /03,09,15,21:30:00 Europe\/Istanbul/); assert.match(timer, /Persistent=true/);
});
