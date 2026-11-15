import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportPublicSource } from '../ops/export-public-source.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('paylaşılabilir kaynak dışa aktarımı işletim sırlarını dışlar ve gömülü sırrı reddeder', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'rez-export-'));
  try {
    const exported = join(temporary, 'exported');
    const count = exportPublicSource(project, exported);
    const manifest = JSON.parse(readFileSync(join(exported, 'EXPORT-MANIFEST.json'), 'utf8'));
    assert.equal(manifest.files.length, count);
    assert.ok(count >= 40);
    assert.equal(existsSync(join(exported, '.local')), false);
    assert.equal(existsSync(join(exported, 'extension/local-config.json')), false);
    assert.ok(existsSync(join(exported, 'extension/local-config.example.json')));
    assert.ok(existsSync(join(exported, 'src/telegram-multi-picker.mjs')));
    for (const file of ['ops/vps/MONITOR-NOTIFICATIONS.md', 'ops/vps/notify-operator.mjs', 'ops/vps/notify-operator.test.mjs']) {
      assert.ok(existsSync(join(exported, file)));
    }
    assert.equal(existsSync(join(exported, 'ops/VPS-DEVIR-NOTU.md')),false);
    assert.equal(existsSync(join(exported, 'ops/vps/CHAT-HANDOFF-2026-10-29.md')),false);
    assert.equal(existsSync(join(exported, 'ops/vps/SHARED-SERVICES.md')),false);
    for (const file of manifest.files) {
      assert.equal(createHash('sha256').update(readFileSync(join(exported, file.path))).digest('hex'), file.sha256);
    }

    const alias = join(temporary, 'project-alias');
    symlinkSync(project, alias, 'dir');
    assert.throws(() => exportPublicSource(project, join(alias, 'inside-project')),
      /proje klasörünün dışında/);

    const cloned = join(temporary, 'cloned');
    cpSync(exported, cloned, { recursive: true });
    unlinkSync(join(cloned, 'EXPORT-MANIFEST.json'));
    mkdirSync(join(cloned, '.local'));
    const fakeSecret = ['12345678', 'a'.repeat(32)].join(':');
    writeFileSync(join(cloned, '.local/telegram-token'), `${fakeSecret}\n`);
    appendFileSync(join(cloned, 'README.md'), `\n${fakeSecret}\n`);
    const rejected = join(temporary, 'rejected');
    assert.throws(() => exportPublicSource(cloned, rejected), /gizli bilgi/);
    assert.equal(existsSync(rejected), false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
