import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function configureOwnerChat({ stateFile, ownerFile, chatId }) {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  const approved = state.betaApprovedChatIds;
  if (!Array.isArray(approved)) throw new Error('Onaylı özel sohbet listesi bulunamadı.');

  let existing;
  try {
    existing = readFileSync(ownerFile, 'utf8').trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existing !== undefined) {
    if (!/^\d{1,20}$/.test(existing) || !approved.includes(existing)) {
      throw new Error('Mevcut sahip sohbeti artık onaylı değil.');
    }
    if (chatId !== undefined && String(chatId) !== existing) {
      throw new Error('Sahip sohbeti zaten farklı ayarlanmış.');
    }
    chmodSync(ownerFile, 0o600);
    return 'already_configured';
  }

  const requested = String(chatId ?? '');
  if (!/^\d{1,20}$/.test(requested) || !approved.includes(requested)) {
    throw new Error('Sahip için --chat-id ile onaylı özel sohbet kimliğini açıkça belirt.');
  }
  writeFileSync(ownerFile, `${requested}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(ownerFile, 0o600);
  return 'created';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--chat-id')) {
    throw new Error('Kullanım: node ops/setup-owner-chat.mjs --chat-id ONAYLI_SOHBET_KIMLIGI');
  }
  const result = configureOwnerChat({
    stateFile: resolve(project, '.local/state.json'),
    ownerFile: resolve(project, '.local/owner-chat-id'),
    chatId: args[1]
  });
  console.log(result === 'created'
    ? 'Açıkça belirtilen onaylı sohbet sahip olarak kaydedildi.'
    : 'Sahip sohbeti zaten güvenli yerel dosyada kayıtlı.');
}
