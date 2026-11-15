import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupState } from '../backup-state.mjs';

const ownedName = /^scheduled-state-\d{8}T\d{9}Z-[a-f0-9]{8}\.json$/;

// Only this job's verified, owner-only regular files are eligible for retention.
// Existing deployment/manual backups and unrecognised files are never removed.
export function scheduledBackup(file, directory, { keep = 32, now = new Date() } = {}) {
  if (!Number.isInteger(keep) || keep < 2 || keep > 1000) throw Error('invalid retention');
  const created = backupState(file, directory, now);
  const destination = join(directory, `scheduled-${basename(created)}`);
  renameSync(created, destination);
  const bytes = readFileSync(destination);
  const copied = JSON.parse(bytes);
  if (copied.version !== 1 || !Array.isArray(copied.subscriptions) || !Array.isArray(copied.outbox)) {
    throw Error('backup validation failed');
  }
  const owner = lstatSync(destination).uid;
  const eligible = [];
  for (const name of readdirSync(directory)) {
    if (!ownedName.test(name)) continue;
    const path = join(directory, name), info = lstatSync(path);
    if (!info.isFile() || info.uid !== owner || (info.mode & 0o077) !== 0) continue;
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.subscriptions) || !Array.isArray(value.outbox)) continue;
    } catch { continue; }
    eligible.push({ path, mtime: info.mtimeMs });
  }
  // Always preserve the new recovery copy, even after a backwards clock jump.
  eligible.sort((a, b) => a.path === destination ? -1 : b.path === destination ? 1 : b.mtime - a.mtime);
  let pruned = 0;
  for (const old of eligible.slice(keep)) { unlinkSync(old.path); pruned++; }
  return { ok: true, createdAt: now.toISOString(), bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), pruned };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(scheduledBackup('/var/lib/odtu-rez/private/state.json', '/var/lib/odtu-rez/private/backups')));
  } catch (error) {
    const reason = /^[A-Z0-9_]{1,32}$/.test(error.code || '') ? error.code : 'validation_failed';
    console.error(JSON.stringify({ ok: false, reason }));
    process.exitCode = 1;
  }
}
