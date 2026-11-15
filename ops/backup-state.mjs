import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function validState(state) {
  return state && typeof state === 'object' && !Array.isArray(state)
    && state.version === 1 && state.engine && typeof state.engine === 'object'
    && Array.isArray(state.subscriptions) && Array.isArray(state.outbox)
    && Number.isSafeInteger(state.telegramOffset) && state.telegramOffset >= 0;
}

// The live store uses atomic rename, so a read observes either complete
// revision. Backups contain chat IDs and must stay in an owner-only directory.
export function backupState(file, backupDir, now = new Date()) {
  const contents = readFileSync(file);
  let state;
  try { state = JSON.parse(contents.toString('utf8')); }
  catch { throw new Error('state file is not valid JSON'); }
  if (!validState(state)) throw new Error('state file has an unsupported shape');
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  chmodSync(backupDir, 0o700);
  const stamp = now.toISOString().replace(/[-:.]/g, '');
  const name = `state-${stamp}-${randomBytes(4).toString('hex')}.json`;
  const destination = join(backupDir, name);
  const temporary = `${destination}.tmp`;
  try {
    writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600, flush: true });
    chmodSync(temporary, 0o600);
    renameSync(temporary, destination);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
  return destination;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const file = resolve(project, '.local/state.json');
    const backupDir = resolve(project, '.local/backups');
    const destination = backupState(file, backupDir);
    console.log(`Yerel durum yedeği oluşturuldu: ${destination}`);
  } catch (error) {
    console.error(`Durum yedeği oluşturulamadı: ${error.message}`);
    process.exitCode = 1;
  }
}
