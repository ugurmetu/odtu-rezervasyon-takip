import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowedFiles = Object.freeze([
  'AGENTS.md',
  'ops/GITHUB-YAYIN.md',
  'ops/vps/scheduled-backup.mjs', 'ops/vps/odtu-rez-backup.service', 'ops/vps/odtu-rez-backup.timer', 'test/scheduled-backup.test.mjs',
  'ops/vps/odtu-rez-session-proof.service', 'ops/vps/odtu-rez-session-proof.timer', 'ops/vps/official-session-proof.py', 'ops/vps/refresh-session-proof.mjs', 'test/official-session-proof.test.mjs',
  'src/publication-wait.mjs', 'test/publication-wait.test.mjs',
  'src/native-verification.mjs', 'test/native-verification.test.mjs', 'test/native-route.test.mjs',
  'extension/worker-0.11.1.js', 'extension/worker-0.11.2.js',
  'extension/worker-0.11.3.js',
  'extension/worker-0.11.4.js',
  'src/telegram-multi-picker.mjs',
  'src/memory-guard.mjs',
  'src/operator-alerts.mjs',
  'src/site-link.mjs',
  'test/site-link.test.mjs',
  'test/memory-guard.test.mjs',
  'test/memory-route.test.mjs',
  'test/operator-alerts.test.mjs',
  'extension/memory-guard.js',
  'extension/test/memory-guard.test.mjs',
  'extension/worker-0.10.3.js',
  'extension/worker-0.10.4.js',
  'extension/worker-0.10.5.js',
  'extension/worker-0.10.6.js',
  'extension/worker-0.10.7.js',
  'extension/worker-0.10.8.js',
  'extension/worker-0.10.9.js',
  'ops/vps/odtu-rez.service',
  'ops/vps/odtu-rez-watchdog.service',
  'ops/vps/odtu-rez-watchdog.timer',
  'ops/vps/WATCHDOG.md',
  'src/intervention.mjs', 'src/watchdog.mjs', 'test/watchdog.test.mjs', 'test/store-save.test.mjs', 'test/chat-gone.test.mjs', 'src/owner-stats.mjs', 'test/owner-stats.test.mjs',
  'ops/vps/provision.sh',
  'ops/vps/OPERATOR-ALERTS.md',
  'ops/vps/MONITOR-NOTIFICATIONS.md',
  'ops/vps/notify-operator.mjs',
  'ops/vps/notify-operator.test.mjs',
  'ops/vps/DEPLOYMENT-2026-10-29.md',
  'ops/vps/odtu-rez-browser.service',
  'ops/vps/check-remote.mjs',
  'ops/vps/stage-bootstrap.mjs',
  'ops/vps/README.md',
  'ops/vps/audit-inventory.mjs',
  'ops/vps/nightly-audit.mjs',
  'ops/vps/NIGHTLY-AUDIT.md',
  'test/nightly-audit.test.mjs',
  'ops/vps/SCREEN-VIEW.md',
  'ops/vps/odtu-rez-display.service',
  'ops/vps/build-release.mjs',
  'ops/vps/boot.html',
  'ops/vps/MEMORY-GUARD.md',
  '.gitignore', 'README.md', 'package.json', 'package-lock.json',
  'assets/brand/rezervasyon-mark-source.png',
  'assets/brand/telegram-avatar-512.jpg',
  'assets/brand/telegram-avatar-512.png',
  'data/facilities-2026-10-18.json',
  'extension/.gitignore', 'extension/README.md',
  'extension/background.js', 'extension/content.js', 'extension/main.js',
  'extension/manifest.json', 'extension/parser.js', 'extension/popup.html', 'extension/popup.js',
  'extension/icons/icon-16.png', 'extension/icons/icon-32.png',
  'extension/icons/icon-48.png', 'extension/icons/icon-128.png',
  'extension/local-config.example.json',
  'extension/verification.js', 'extension/verification-checkbox.js', 'extension/verification-content.js',
  'extension/test/verification.test.mjs', 'extension/test/verification-checkbox.test.mjs', 'extension/test/verification-content.test.mjs',
  'extension/test/background.test.mjs', 'extension/test/content.test.mjs',
  'extension/test/diagnostics.test.mjs', 'extension/test/main.test.mjs', 'extension/test/direct-read.test.mjs', 'test/capacity.test.mjs',
  'extension/test/parser.test.mjs', 'extension/test/popup.test.mjs',
  'ops/HERKESE-ACIK-KULLANIM.md', 'ops/ARKADAS-BETA-TESTI.md', 'ops/KABUL-DENETIMI.md',
  'ops/KAYNAK-KAPSAM-KARARI.md', 'ops/MAC-BETA.md',
  'ops/MERKEZI-GECIS-KAPILARI.md', 'ops/ODTU-TEKNIK-SORU-TASLAGI.md',
  'ops/SECURITY-REVIEW.md', 'ops/SUNUCU-SECIMI.md',
  'ops/backup-state.mjs', 'ops/beta-status.mjs', 'ops/e2e-delivery-probe.mjs',
  'ops/coverage-diagnosis.mjs', 'ops/export-public-source.mjs', 'ops/health-report.mjs', 'ops/scale-probe.mjs', 'ops/setup-owner-chat.mjs',
  'ops/slot-trace.mjs',
  'ops/tr.ugurmetu.rez-pilot.example.plist', 'ops/update-bot-profile.mjs',
  'src/core.mjs', 'src/coverage.mjs', 'src/demo.mjs', 'src/fake-site.mjs',
  'src/health-history.mjs', 'src/server.mjs', 'src/setup.mjs', 'src/store.mjs',
  'src/i18n.mjs', 'test/i18n.test.mjs', 'src/reader-facilities.mjs', 'src/reader-plan.mjs', 'test/reader-plan.test.mjs', 'src/legacy-redirect.mjs', 'src/telegram.mjs', 'src/slot-alerts.mjs', 'test/slot-alerts.test.mjs',
  'test/backup-state.test.mjs', 'test/core.test.mjs', 'test/coverage.test.mjs',
  'test/export-public-source.test.mjs', 'test/fake-site.test.mjs',
  'test/health-history.test.mjs', 'test/server.test.mjs',
  'test/setup-owner-chat.test.mjs', 'test/slot-trace.test.mjs', 'test/store.test.mjs', 'test/telegram.test.mjs',
  'test/uncertain-delivery.test.mjs',
  'extension/single-reader.js', 'extension/test/single-reader.test.mjs', 'extension/parallel-reader.js', 'extension/test/parallel-reader.test.mjs', 'extension/scheduler.js', 'extension/catalog.js', 'extension/test/catalog.test.mjs', 'extension/test/scheduler.test.mjs', 'extension/recovery.js', 'extension/reader-clock.js', 'src/reader-clock.mjs', 'test/reader-clock.test.mjs', 'extension/test/reader-clock.test.mjs', 'extension/test/recovery.test.mjs',
  'ops/keychain.swift', 'src/credentials.mjs', 'src/telegram-picker.mjs',
  'test/linux-credentials.test.mjs', 'test/public-access.test.mjs', 'test/availability-watch.test.mjs', 'test/credentials.test.mjs', 'test/telegram-picker.test.mjs', 'test/telegram-menu-latency.test.mjs'
]);

// Operational handoffs are local context, not part of the public source.
const localOnlyFiles=new Set(['ops/VPS-DEVIR-NOTU.md','ops/vps/CHAT-HANDOFF-2026-10-29.md','ops/vps/SHARED-SERVICES.md']);

function listedFiles(root, subdir, result) {
  for (const entry of readdirSync(join(root, subdir), { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const path = subdir ? `${subdir}/${entry.name}` : entry.name;
    if (localOnlyFiles.has(path)) continue;
    if (path === '.local' || path === 'node_modules' || path === '.git'
      || path === 'extension/local-config.json') continue;
    if (entry.isSymbolicLink()) throw new Error(`Sembolik bağlantı incelenmeden dışa aktarılamaz: ${path}`);
    if (entry.isDirectory()) listedFiles(root, path, result);
    else if (entry.isFile()) result.push(path);
    else throw new Error(`Özel dosya incelenmeden dışa aktarılamaz: ${path}`);
  }
}

function localSecretValues(root) {
  return ['.local/telegram-token', '.local/beta-invite-code', '.local/ingest.key']
    .flatMap(path => existsSync(join(root, path)) ? [readFileSync(join(root, path), 'utf8').trim()] : [])
    .filter(value => value.length >= 12);
}

export function exportPublicSource(root, output) {
  const source = realpathSync(resolve(root));
  if (!isAbsolute(output)) throw new Error('Mutlak dışa aktarma hedefi gerekli.');
  const target = resolve(output);
  const parent = realpathSync(dirname(target));
  const physicalTarget = join(parent, basename(target));
  const nested = relative(source, physicalTarget);
  if (!nested || (!nested.startsWith(`..${sep}`) && nested !== '..')) {
    throw new Error('Dışa aktarma hedefi proje klasörünün dışında olmalı.');
  }
  if (existsSync(target)) throw new Error('Dışa aktarma hedefi zaten var; üzerine yazılmadı.');

  const actual = [];
  listedFiles(source, '', actual);
  const expected = new Set(allowedFiles);
  const unknown = actual.filter(path => !expected.has(path));
  const missing = allowedFiles.filter(path => !actual.includes(path));
  if (unknown.length || missing.length) {
    throw new Error(`Dosya listesi yeniden incelenmeli: yeni=${unknown.join(', ') || 'yok'}; eksik=${missing.join(', ') || 'yok'}`);
  }

  const secrets = localSecretValues(source);
  const manifest = [];
  const inspected = new Map();
  for (const path of allowedFiles) {
    const original = join(source, path);
    if (!lstatSync(original).isFile()) throw new Error(`Normal dosya değil: ${path}`);
    const bytes = readFileSync(original);
    if (secrets.some(value => bytes.includes(Buffer.from(value)))
      || /\b\d{7,15}:[A-Za-z0-9_-]{20,}\b/.test(bytes.toString('utf8'))) {
      throw new Error(`Olası gizli bilgi bulundu; dışa aktarma durduruldu: ${path}`);
    }
    inspected.set(path, bytes);
    manifest.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') });
  }

  const staging = mkdtempSync(join(parent, '.rez-public-source-'));
  try {
    for (const { path } of manifest) {
      const destination = join(staging, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, inspected.get(path), { mode: 0o644 });
    }
    writeFileSync(join(staging, 'EXPORT-MANIFEST.json'), `${JSON.stringify({ files: manifest }, null, 2)}\n`, { mode: 0o644 });
    renameSync(staging, target);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return manifest.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output') {
    throw new Error('Kullanım: node ops/export-public-source.mjs --output /mutlak/yeni/klasor');
  }
  console.log(`${exportPublicSource(project, args[1])} incelenmiş kaynak dosyası dışa aktarıldı.`);
}
