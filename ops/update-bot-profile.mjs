import {botCommands} from '../src/telegram.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = (await fs.readFile(path.join(root, process.argv.includes('--new')?'.local/telegram-token.next':'.local/telegram-token'), 'utf8')).trim();
const expectedUsername = 'odtu_rezervasyon_bot';
const api = (method) => `https://api.telegram.org/bot${token}/${method}`;

async function call(method, body) {
  const response = await fetch(api(method), { method: 'POST', body });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`${method}: ${result.description || response.status}`);
  return result.result;
}

async function jsonCall(method, payload) {
  return call(method, new URLSearchParams(Object.entries(payload).map(([key, value]) => [key,
    typeof value === 'string' ? value : JSON.stringify(value)])));
}

const bot = await call('getMe');
if (bot.username !== expectedUsername) throw new Error('Beklenmeyen bot hesabı; profil değiştirilmedi.');

await jsonCall('setMyName', { name: 'ODTÜ Rezervasyon Takip' });
await jsonCall('setMyShortDescription', {
  short_description: 'ODTÜ spor tesislerinde seçtiğin seansta yer açılınca haber al. Ücretsiz.'
});
await jsonCall('setMyDescription', {
  description: 'Başlat → Tesis → Gün → Seans. Seçtiğin saatlerde yer açılınca haber veririm. rez.metu.edu.tr listesindeki ODTÜ spor tesisleri takip ediliyor; dolu seansı da seçebilirsin, yer açılırsa mesaj gelir. Rezervasyonu ve iptali sitede kendin yaparsın. ODTÜ’nün resmî botu değildir. Bildirimler takip bilgisayarı açıkken çalışır. Kayıtlarını kaldırmak için /sil.'
});
for(const language_code of ['', 'tr', 'en'])await jsonCall('setMyCommands',{commands:botCommands(language_code||'tr'),...(language_code?{language_code}:{})});

const existingPhotos = await jsonCall('getUserProfilePhotos', { user_id: bot.id, limit: 1 });
if (existingPhotos.total_count === 0 || process.argv.includes('--replace-photo')) {
  const photo = await fs.readFile(path.join(root, 'assets/brand/telegram-avatar-512.jpg'));
  const form = new FormData();
  form.set('photo', JSON.stringify({ type: 'static', photo: 'attach://avatar' }));
  form.set('avatar', new Blob([photo], { type: 'image/jpeg' }), 'telegram-avatar-512.jpg');
  await call('setMyProfilePhoto', form);
}

const [name, shortDescription, description, commands, profilePhotos] = await Promise.all([
  call('getMyName'), call('getMyShortDescription'), call('getMyDescription'), call('getMyCommands'),
  jsonCall('getUserProfilePhotos', { user_id: bot.id, limit: 1 })
]);
if (name.name !== 'ODTÜ Rezervasyon Takip' || profilePhotos.total_count < 1) {
  throw new Error('Bot profili güncellendi fakat doğrulama beklenen sonucu vermedi.');
}
console.log(JSON.stringify({ username: bot.username, name: name.name,
  short_description: shortDescription.short_description,
  description: description.description,
  commands: commands.map(({ command }) => command), photo_count: profilePhotos.total_count }, null, 2));
