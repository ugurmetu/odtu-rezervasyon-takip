import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keyFile = resolve(project, '.local/ingest.key');
const extensionConfig = resolve(project, 'extension/local-config.json');

mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
mkdirSync(dirname(extensionConfig), { recursive: true });
let key;
try { key = readFileSync(keyFile, 'utf8').trim(); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  key = randomBytes(32).toString('hex');
  writeFileSync(keyFile, `${key}\n`, { mode: 0o600, flag: 'wx' });
}
if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('local key file is invalid');
chmodSync(keyFile, 0o600);
writeFileSync(extensionConfig, `${JSON.stringify({ ingestUrl: 'http://127.0.0.1:8765/ingest', key }, null, 2)}\n`, { mode: 0o600 });
chmodSync(extensionConfig, 0o600);
console.log('Yerel anahtar ve uzantı ayarı hazır. Anahtar ekrana yazılmadı.');
