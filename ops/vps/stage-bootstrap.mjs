import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
const root = process.cwd();
const releases = resolve(root, '.local/vps-releases');
const latest = readdirSync(releases).sort().at(-1);
if (!latest) throw new Error('Build the release first');
const release = resolve(releases, latest);
const identityFile = resolve(root, '.local/vps-extension-identity.json');
let identity;
try { identity = JSON.parse(readFileSync(identityFile, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ format: 'der', type: 'spki' });
  const id = [...createHash('sha256').update(der).digest().subarray(0, 16)]
    .map(b => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join('');
  identity = { key: der.toString('base64'), id };
  writeFileSync(identityFile, JSON.stringify(identity, null, 2) + '\n', { mode: 0o600 });
}
const manifestPath = resolve(release, 'source/extension/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.key = identity.key;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
const bootstrap = resolve(release, 'bootstrap');
mkdirSync(bootstrap, { recursive: true, mode: 0o700 });
let key;
try { key = readFileSync(resolve(bootstrap, 'ingest.key'), 'utf8').trim(); }
catch (error) { if (error.code !== 'ENOENT') throw error; key = randomBytes(32).toString('hex'); }
writeFileSync(resolve(bootstrap, 'ingest.key'), key + '\n', { mode: 0o600 });
const config = { ingestUrl: 'http://127.0.0.1:8765/ingest', key, maintenance: true,
  autoManage: false, autoLogin: false, singleTab: true, fastWatch: true, scanMode: 'single-tab',
  catalogDiscovery: true, watchFacilities: [], watchDates: [] };
writeFileSync(resolve(bootstrap, 'local-config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
writeFileSync(resolve(bootstrap, 'runtime.env'), [
  `REZ_EXTENSION_ID=${identity.id}`,
  'REZ_READER_CONFIG_FILES=/opt/odtu-rez/current/extension/local-config.json',
  'REZ_CREDENTIALS_FILE=/var/lib/odtu-rez/private/metu-credentials.json',
  'REZ_ACCESS_MODE=public',
  'REZ_SUPPORT_EMAIL=kilic.ugur@metu.edu.tr',
].join('\n') + '\n', { mode: 0o600 });
console.log(JSON.stringify({ release: latest, version: manifest.version, extensionId: identity.id, maintenance: true, telegramTokenIncluded: false }));
