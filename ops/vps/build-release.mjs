import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, lstatSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(readFileSync(resolve(root, 'extension/manifest.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Invalid extension version');
// Chrome can retain an unpacked worker's old script across a path/symlink
// switch. Each release must use a new entry URL, not just a new manifest label.
const workerEntry=`worker-${manifest.version}.js`;
if(manifest.background?.service_worker!==workerEntry
  ||readFileSync(resolve(root,'extension',workerEntry),'utf8').trim().split('\n').at(-1)!=='importScripts("background.js");'){
 throw new Error('Create the versioned worker entry and update manifest.background.service_worker before release');
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = resolve(root, '.local/vps-releases', `${manifest.version}-${stamp}`);
const stage = resolve(output, 'source');
mkdirSync(stage, { recursive: true, mode: 0o700 });
const files = ['package.json', 'package-lock.json'];
const allowed = new Set(['.js', '.mjs', '.json', '.html', '.css', '.png', '.svg', '.md']);
function collect(folder) {
  for (const entry of readdirSync(resolve(root, folder), { withFileTypes: true })) {
    const path = `${folder}/${entry.name}`;
    if (entry.name.startsWith('.') || entry.name === 'test' || entry.name === 'node_modules'
        || path === 'extension/local-config.json') continue;
    if(folder==='extension'&&/^worker-\d+\.\d+\.\d+\.js$/.test(entry.name)&&entry.name!==workerEntry)continue;
    if (entry.isDirectory()) { collect(path); continue; }
    const stat = lstatSync(resolve(root, path));
    const extension = entry.name.match(/\.[^.]+$/)?.[0];
    if (!entry.isFile() || stat.isSymbolicLink() || !allowed.has(extension)) throw new Error(`Unapproved release file: ${path}`);
    if (stat.size > 2_000_000) throw new Error(`Unexpected file size: ${path}`);
    files.push(path);
  }
}
collect('src'); collect('extension');
const hashes = {};
for (const path of files.sort()) {
  const data = readFileSync(resolve(root, path));
  if (/\.(?:m?js|json|html|css|md)$/.test(path)
      && /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/.test(data.toString())) throw new Error(`Possible bot secret in ${path}`);
  const destination = resolve(stage, path);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(resolve(root, path), destination);
  hashes[path] = createHash('sha256').update(data).digest('hex');
}
const metadata = { createdAt: new Date().toISOString(), extensionVersion: manifest.version,
  files: hashes, excludes: ['.local', 'node_modules', 'extension/local-config.json', 'Mac keychain', 'runtime state and credentials'] };
writeFileSync(resolve(output, 'release.json'), JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600 });
// macOS tar otherwise writes AppleDouble metadata as ._*.mjs files on Linux.
execFileSync('tar', ['-czf', resolve(output, 'source.tar.gz'), '-C', stage, '.'], {env:{...process.env,COPYFILE_DISABLE:'1'}});
console.log(JSON.stringify({ version: manifest.version, files: files.length, release: relative(root, output), secretsIncluded: false }));
