import {msg,locale,language,withLanguage,withChatLanguage,facilityLabel} from './i18n.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {runSlotUpdateLoop,siteKeyboard} from './slot-alerts.mjs';
import {withFixedSiteShortcut,siteShortcutText,siteLinkReply} from './site-link.mjs';
import {canSelectFacility,requestFacility,isReaderFacility,readerSupportsTennis,readerSupportsAll,scheduleFreshMs} from './reader-facilities.mjs';
import { sessionCoverage, LocalStore } from './store.mjs';
import {dayMenu, handlePickerCallback, facilityEmoji, dateLabel, shortFacilityName, shortDateLabel, pickerDates, sessionOptions} from './telegram-picker.mjs';

const API_ROOT = 'https://api.telegram.org';
const USER_CALM_MS = 15 * 60_000;
const UNAPPROVED_OFFSET_FLUSH_MS = 5_000;

export function pollRetryDelayMs(consecutiveFailures, retryAfterMs = 0) {
  const failures = Number.isSafeInteger(consecutiveFailures) && consecutiveFailures > 0
    ? consecutiveFailures : 1;
  const backoff = Math.min(30_000, 5_000 * 2 ** Math.min(failures - 1, 3));
  return Math.max(backoff, Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 0);
}

// One shared pace for everything the bot sends (alerts, menus, status edits),
// just under Telegram's ~30 messages per second for a bot.
const SENDING_METHODS = new Set(['sendMessage', 'editMessageText', 'editMessageReplyMarkup', 'deleteMessage']);
export function createRateLimiter(perSecond = 28, now = () => Date.now(), sleep = ms => delay(ms)) {
  let tokens = perSecond, last = now(), chain = Promise.resolve();
  return { take() {
    const next = chain.then(async () => {
      for (;;) {
        const at = now();
        tokens = Math.min(perSecond, tokens + (at - last) * perSecond / 1000);
        last = at;
        if (tokens >= 1) { tokens -= 1; return; }
        await sleep(Math.ceil((1 - tokens) * 1000 / perSecond));
      }
    });
    chain = next.catch(() => {});
    return next;
  } };
}

export class TelegramApi {
  constructor(token, fetchImpl = fetch, limiter = createRateLimiter()) {
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token || '')) throw new Error('Telegram token missing or invalid');
    this.token = token;
    this.fetch = fetchImpl;
    this.limiter = limiter;
  }

  async call(method, payload, timeoutMs = 35_000) {
    if (SENDING_METHODS.has(method) && this.limiter) await this.limiter.take();
    const response = await this.fetch(`${API_ROOT}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      const error = new Error(`Telegram ${method} failed (${response.status})`);
      error.status = response.status;
      error.cannotEdit = method === 'editMessageText' && response.status === 400
        && /message to edit not found|message can't be edited|message_id_invalid/i.test(data.description || '');
      error.notModified = ['editMessageText','editMessageReplyMarkup'].includes(method) && response.status === 400
        && /message is not modified/i.test(data.description || '');
      error.replyTargetMissing = method === 'sendMessage' && response.status === 400
        && /\b(?:message to (?:be )?replied(?: to)? not found|reply message not found|reply_message_id_invalid)\b/i.test(data.description || '');
      error.retryAfterMs = Number(data.parameters?.retry_after || 0) * 1_000;
      // The person blocked the bot or deleted the account: nothing will ever reach them.
      error.chatGone = (response.status === 403 && /blocked by the user|user is deactivated|bot was kicked/i.test(data.description || ''))
        || (response.status === 400 && /chat not found/i.test(data.description || ''));
      throw error;
    }
    return data.result;
  }

  getUpdates(offset) {
    return this.call('getUpdates', { offset, timeout: 20, allowed_updates: ['message', 'callback_query'] }, 30_000);
  }

  sendMessage(chatId, text, replyMarkup, timeoutMs=20_000, replyToMessageId=null) {
    return this.call('sendMessage', {
      chat_id: chatId, text, link_preview_options: { is_disabled: true },
      ...(Number.isSafeInteger(replyToMessageId)&&replyToMessageId>0?{reply_parameters:{message_id:replyToMessageId,allow_sending_without_reply:true}}:{}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    }, timeoutMs);
  }

  editMessageText(chatId, messageId, text, replyMarkup) {
    return this.call('editMessageText', {
      chat_id: chatId, message_id: messageId, text, link_preview_options: { is_disabled: true },
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    }, 20_000);
  }

  editMessageReplyMarkup(chatId,messageId,replyMarkup={inline_keyboard:[]}) {
    return this.call('editMessageReplyMarkup',{chat_id:chatId,message_id:messageId,reply_markup:replyMarkup},10_000);
  }

  deleteMessage(chatId, messageId) {
    return this.call('deleteMessage', { chat_id: chatId, message_id: messageId }, 10_000);
  }

  answerCallbackQuery(callbackId,text) {
    return this.call('answerCallbackQuery', { callback_query_id: callbackId,...(text?{text}:{}) }, 20_000);
  }

  setChatCommands(chatId,preferredLanguage){
    return this.call('setMyCommands',{scope:{type:'chat',chat_id:chatId},commands:botCommands(preferredLanguage)},10_000);
  }

  clearChatCommands(chatId){
    return this.call('deleteMyCommands',{scope:{type:'chat',chat_id:chatId}},10_000);
  }
}

export function botCommands(preferredLanguage='tr'){
 return withLanguage(preferredLanguage,()=>[
  {command:'start',description:msg('Ana menüyü aç','Open the main menu')},
  {command:'menu',description:msg('Ana menüye dön','Return to the main menu')},
  {command:'site',description:msg('Rezervasyon bağlantısını göster','Show the reservation link')},
  {command:'settings',description:msg('Dil ve test mesajı','Language and test message')},
  {command:'facilities',description:msg('Birim, tesis ve seans seç','Choose a directorate, facility and session')},
  {command:'selections',description:msg('Seçimlerimi göster','Show my selections')},
  {command:'support',description:msg('Destek ve iletişim','Support and contact')},
  {command:'delete',description:msg('Seçimlerimi ve kayıtlarımı sil','Delete my selections and records')}
 ]);
}

export function formatAvailability(event, preferredLanguage='tr') {
 return withLanguage(preferredLanguage,()=>{
  // Two lines: count beside the title, then facility/date/session.
  return [msg(`🟢 Yer açıldı · Boş yer: ${event.free}`,`🟢 A place is available · Free places: ${event.free}`),
    `${shortFacilityName(event.facility.label)} · ${shortDateLabel(event.date)} ${event.start}–${event.end}`].join('\n');
 });
}

// Telegram Bot API style: primary (blue), success (green), danger (red).
const button = (text, data, style) => ({ text, callback_data: data, ...(style ? { style } : {}) });
const keyboard = rows => ({ inline_keyboard: rows });
const mainMenuButton = () => button(msg('⬅️ Ana menü',"⬅️ Main menu"), 'h');
const short = (value, max = 42) => value.length > max ? `${value.slice(0, max - 1)}…` : value;
const unitKey = unit => createHash('sha256').update(unit).digest('hex').slice(0, 10);
const testMessage = () => msg('🧪 TEST — ODTÜ Rezervasyon Takip deneme mesajı. Bu gerçek boş yer bildirimi değildir. Herhangi bir rezervasyon yapılmadı. Test mesajı en fazla dakikada bir gönderilir.',"🧪 TEST — METU Reservation Tracker test message. This is not a real availability alert. No reservation has been made. Test messages are limited to one per minute.");
const testReply = chatId => ({ chatId, kind: 'test', text: testMessage(),
  replyMarkup: keyboard([[mainMenuButton()]]) });
const testCooldownReply = chatId => ({
  chatId,
  text: msg('🧪 Kısa süre önce test istedin. Yeni bir test için bir dakika bekle. Bu bekleme gerçek boş yer bildirimlerini etkilemez.',"🧪 You recently requested a test. Please wait one minute before trying again. This does not delay real availability alerts."),
  replyMarkup: keyboard([[mainMenuButton()]])
});

function supportEmail() {
  const address = String(process.env.REZ_SUPPORT_EMAIL || '').trim();
  // Keep malformed configuration (especially line breaks) out of Telegram text.
  return address.length <= 254
    && /^[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(address)
    ? address : null;
}

// The owner's public LinkedIn profile, from REZ_SUPPORT_LINKEDIN or
// .local/support-linkedin. Anything that is not a linkedin.com/in URL is ignored.
function supportLinkedIn() {
  let value = String(process.env.REZ_SUPPORT_LINKEDIN || '').trim();
  if (!value) {
    try { value = readFileSync(new URL('../.local/support-linkedin', import.meta.url), 'utf8').trim(); }
    catch { value = ''; }
  }
  return /^https:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9_%-]{3,100}\/?$/.test(value) ? value : null;
}

function supportMenu(chatId) {
  const address = supportEmail(), linkedin = supportLinkedIn();
  const contact = address ? msg(`Sorun ya da öneri için:\n📧 ${address}`, `For problems or ideas:\n📧 ${address}`)
    + (linkedin ? msg('\nLinkedIn’den de yazabilirsin.', '\nYou can also message me on LinkedIn.') : '')
    : linkedin ? msg('Sorun ya da öneri için LinkedIn’den yazabilirsin.', 'For problems or ideas, message me on LinkedIn.')
      : msg('İletişim bağlantısı henüz eklenmedi.', 'No contact link has been added yet.');
  const rows = [];
  if (linkedin) rows.push([{ text: '🔗 LinkedIn', url: linkedin }]);
  rows.push([mainMenuButton()]);
  return {
    chatId,
    text: `${msg('📮 Destek ve iletişim', '📮 Support & contact')}\n\n${contact}`,
    replyMarkup: keyboard(rows)
  };
}

function settingsMenu(store,chatId,notice=''){
 const en=store.languageFor(chatId)==='en';
 return {chatId,text:`⚙️ Settings\n\n${notice?`${notice}\n\n`:''}${msg('Dil: Türkçe','Language: English')}`,
  replyMarkup:keyboard([
   [button(`${en?'':'✅ '}Türkçe`,'lang:tr'),button(`${en?'✅ ':''}English`,'lang:en')],
   [button(msg('🧪 Test mesajı','🧪 Test message'),'test')],
   [mainMenuButton()]
  ])};
}

function facilitiesByUnit(store) {
  const groups = new Map();
  for (const facility of store.availableFacilities().filter(f=>store.accessMode!=='public'||canSelectFacility(store,f.id))) {
    const unit = facility.unit || 'Birimi doğrulanmadı';
    if (!groups.has(unit)) groups.set(unit, []);
    groups.get(unit).push(facility);
  }
  return groups;
}

function observedPages(store, facilityId) {
  return Object.values(store.engine.pages)
    .filter(page => String(page?.facility?.id) === String(facilityId) && page.lastSuccessAt)
    .sort((a, b) => b.lastSuccessAt.localeCompare(a.lastSuccessAt));
}

function hasReliableSessions(page) {
  return page?.baselineConfirmed === true && Object.keys(page.slots ?? {}).length > 0;
}

function currentVerifiedPage(store) {
  const health = store.engine.health;
  if (health.lastState !== 'ok') return null;
  if (!store.catalogFacility(health.lastFacility?.id)) return null;
  const age = Date.now() - Date.parse(health.lastSeenAt || '');
  if (!Number.isFinite(age) || age < 0 || age > 3 * 60_000) return null;
  return Object.values(store.engine.pages).find(page =>
    page.lastSuccessAt === health.lastSeenAt
    && String(page.facility?.id) === String(health.lastFacility?.id)
    && hasReliableSessions(page)) ?? null;
}

function selectedFacilityCoverage(store, chatId) {
  const selected = new Set(store.subscriptionsFor(chatId).map(item => String(item.facilityId)));
  const now = Date.now();
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(now)).filter(part => part.type !== 'literal')
    .map(part => [part.type, part.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  let fresh = 0;
  let complete = 0;
  if (store.engine.health.lastState === 'ok') {
    for (const id of selected) {
      const page = observedPages(store, id).find(item => item.date >= today);
      const age = now - Date.parse(page?.lastSuccessAt || '');
      if (!Number.isFinite(age) || age < 0 || age > 3 * 60_000) continue;
      fresh++;
      const unit = store.catalogFacility(id)?.unit;
      const coverage = unit ? sessionCoverage(page, now, unit) : null;
      if (hasReliableSessions(page) && coverage && coverage.recordedSessions > 0
        && !coverage.intermittent) complete++;
    }
  }
  return { selected: selected.size, fresh, complete };
}

function limitedSessionText(store, page) {
  if (!page) return '';
  const coverage = sessionCoverage(page, Date.now(),
    store.catalogFacility(page.facility?.id)?.unit);
  return coverage.intermittent
    ? `⚠️ Son yanıtta önceden görülen ${coverage.recordedSessions} gelecek seanstan yalnız ${coverage.observedSessions} tanesi var. Görünmeyen saatler dolu, henüz açılmamış veya geçici olarak listelenmiyor olabilir; güncel uygunlukları doğrulanmıyor.`
    : '';
}

function istanbulDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale(), {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  }).format(date);
}

function coverageLabel(store, facilityId) {
  if(store.state.readerPlan){
    const plan=store.state.readerPlan;
    if(!plan.facilityIds.includes(String(facilityId)))return msg('Bu takip planında etkin değil',"Not active in this monitoring plan");
    const fresh=plan.dates.filter(date=>{
      const page=store.engine.pages[`${facilityId}|${date}`];
      const age=Date.now()-Date.parse(page?.lastSuccessAt||'');return age>=0&&age<=240000;
    }).length;
    return `${fresh}/${plan.dates.length} günün kontrolü güncel${fresh===plan.dates.length?' · uygun seans bekleniyor':''}`;
  }
  const page = observedPages(store, facilityId)[0];
  if (!page) return msg('Takvim henüz okunmadı',"The calendar has not been read yet");
  if (!Number.isFinite(Date.parse(page.lastSuccessAt))) return `Son kayıtlı okuma: ${page.date}; güncellik bilinmiyor`;
  const at = new Intl.DateTimeFormat(locale(), {
    timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(new Date(page.lastSuccessAt));
  const health = store.engine.health;
  const latestPage = String(health.lastFacility?.id) === String(facilityId)
    && health.lastSeenAt === page.lastSuccessAt;
  if (latestPage && ['empty_unconfirmed', 'empty_confirmed'].includes(health.lastState)) {
    return `Takvim yanıtı boş; müsaitlik doğrulanamadı. Son okuma: ${page.date} · ${at}`;
  }
  const current = currentVerifiedPage(store) === page;
  return `${current ? 'Son doğrulanan takvim' : 'Son kayıtlı okuma'}: ${page.date} · ${at}${current ? '' : ' · güncel takip doğrulanmıyor'}${current && limitedSessionText(store, page) ? `\n${limitedSessionText(store, page)}` : ''}`;
}

function managedSummary(store,chatId){
  const plan=store.state.readerPlan;
  const chosen=new Set(store.subscriptionsFor(chatId).map(item=>item.facilityId));
  const names=plan.facilityIds.filter(id=>chosen.has(id)).map(id=>store.catalogFacility(id)?.label||id);
  const reader=store.status().reader;
  const phases={preparing:msg('Takvimler hazırlanıyor',"Preparing calendars"),signing_in:msg('ODTÜ oturumu otomatik yenileniyor',"Renewing the METU session"),
    reconnecting:msg('Takvim bağlantısı yeniden kuruluyor',"Reconnecting to the calendar"),waiting_verification:msg('Girişteki doğrulama için kullanıcı işlemi gerekiyor',"The sign-in verification needs your attention"),
    credentials_missing:msg('Otomatik oturum için giriş bilgileri bekleniyor',"Waiting for automatic sign-in credentials"),credentials_locked:msg('Mac parola kasası kilitli',"The Mac password vault is locked"),
    login_failed:msg('Giriş bilgileri kontrol edilmeli',"Please check the sign-in credentials"),network_wait:msg('Bağlantı yeniden deneniyor',"Retrying the connection")};
  const status=phases[reader?.phase]||`${reader?.fresh||0}/${reader?.total||0} gün takvimi güncel`;
  return `${status}\n\n${names.join('\n')||'Bu planda seçili salonun yok.'}\nİzlenen tarihler: ${plan.dates.map(date=>date.split('-').reverse().join('.')).join(', ')}\n\nUygun seans iki ayrı kontrolde doğrulanınca haber verilir. Boş liste, boş yer anlamına gelmez. Mac uyanık ve Chrome açık kalmalı; kaybolan takip sekmeleri otomatik açılır.`;
}

function home(store, chatId) {
  const menu=keyboard([[button(msg('🏢 Birim ve tesis seç','🏢 Choose a facility'),'u','primary')],[button(msg('🎯 Seçimlerim','🎯 My selections'),'p')],[button('⚙️ Settings','settings'),button(msg('📮 Destek','📮 Support'),'c')]]);
  if(store.state.readerPlan||store.accessMode==='public'){
    const scope=readerSupportsAll(store)?msg('Resmî listedeki tüm tesislerden seçim yapabilirsin.','You can choose from all facilities in the official list.'):readerSupportsTennis(store)?msg('Fitness salonları ve tenis kortlarından seçim yapabilirsin.','You can choose fitness centres and tennis courts.'):msg('Şu an Baraka ve Teknokent Fitness takip ediliyor.','Baraka and Teknokent Fitness are currently being monitored.');
    const note=readerSupportsAll(store)?'':`\n\n${scope}`;
    return {chatId,text:msg(`🏟️ ODTÜ Rezervasyon Takip\n\nSeçtiğin seansta yer açılınca haber veririm.${note}`,`🏟️ METU Reservation Tracker\n\nI tell you when a place opens in your chosen session.${note}`),replyMarkup:menu};
  }
  if(language()==='en'){
    const c=selectedFacilityCoverage(store,chatId);
    return {chatId,text:`🏟️ METU Reservation Tracker\n\n${c.selected} facilities selected. ${c.fresh} recently checked; ${c.complete} have all previously seen sessions in the latest response.\n\nChoose a facility, day and session. Selections without current readings cannot produce alerts. This local reader needs the Mac, Chrome and the selected official calendar to remain available. A notification is not a booking guarantee.\n\nAn independent student project, not an official METU bot.`,replyMarkup:menu};
  }
  const selected = new Set(store.subscriptionsFor(chatId).map(item => item.facilityId));
  const active = currentVerifiedPage(store);
  const limited = limitedSessionText(store, active);
  const selectedCoverage = selectedFacilityCoverage(store, chatId);
  const liveStatus = selected.size > 1
    ? `${selectedCoverage.fresh === selected.size && selectedCoverage.complete === selected.size ? '🟢' : selectedCoverage.fresh ? '🟠' : '⚪'} Seçtiğin ${selectedCoverage.fresh}/${selected.size} tesisin takvimi son 3 dakikada doğrulandı; ${selectedCoverage.complete}/${selected.size} tesisin önceden görülen seansları son yanıtta tam. Güncel okuması olmayan tesisler bildirim üretmez.${active && selected.has(String(active.facility.id)) && limited ? `\n${limited}` : ''}`
    : active && selected.has(String(active.facility.id))
    ? `${limited ? '🟠' : '🟢'} Son 3 dakikada seçtiğin tesisin takvimi doğrulandı: ${active.facility.label} · ${active.date}.${limited ? `\n${limited}` : ''}`
    : active && selected.size
      ? `⚪ Seçtiğin tesisler için güncel okuma yok. Son 3 dakikada yalnız ${active.facility.label} · ${active.date} takvimi doğrulandı.${limited ? `\n${limited}` : ''}`
      : active
        ? `${limited ? '🟠' : '🟢'} Son 3 dakikada ${active.facility.label} · ${active.date} takvimi doğrulandı. Bildirim için tesis ve saat seç.${limited ? `\n${limited}` : ''}`
        : '⚪ Son 3 dakikada doğrulanmış takvim yok; güncel bildirim kapsamı doğrulanmıyor.';
  return {
    chatId,
    text: `🏟️ ODTÜ Rezervasyon Takip\n${selected.size} tesis seçili.\n${liveStatus}\n\nBirim ve tesis seçip ilgilendiğin saatleri işaretle. Şimdilik yalnız açık ODTÜ rezervasyon sayfasında seçili tesis ve gün okunuyor. Takvimi okunmayan seçimler bildirim üretmez. Bildirim rezervasyon garantisi değildir.\n\nBağımsız öğrenci projesidir; ODTÜ'nün resmî botu değildir.`,
    replyMarkup: menu
  };
}

function unitsMenu(store, chatId) {
  const groups = facilitiesByUnit(store);
  const rows = [...groups.entries()].map(([unit, facilities]) => [button(`${/havuz/i.test(unit)?'🏊':'🏟️'} ${short(facilityLabel(unit), 35)}`, `u:${unitKey(unit)}`)]);
  if (![...groups.keys()].some(unit=>/havuz/i.test(unit))) rows.push([button(msg('🏊 Havuz Müdürlüğü (Soon)','🏊 Pool Directorate (Soon)'),'soon:pool')]);
  if (!groups.size) rows.push([button(msg('📮 Destek ve iletişim',"📮 Support & contact"), 'c')]);
  rows.push([mainMenuButton()]);
  return {
    chatId,
    text: groups.size
      ? msg('🏢 Hangi birime gitmek istiyorsun?',"🏢 Which directorate would you like?")
      : msg('🏢 Tesis listesi henüz bu bota eklenmedi. Biraz sonra tekrar dene; sürerse Destek ve iletişim bölümünden haber ver.',"🏢 The facility list is not available yet. Try again shortly; if the issue continues, open Support from the main menu."),
    replyMarkup: keyboard(rows)
  };
}

function facilityMenu(store, chatId, unit) {
  const facilities = facilitiesByUnit(store).get(unit) ?? [];
  const selected = new Set(store.subscriptionsFor(chatId).map(item => item.facilityId));
  const rows = facilities.map(item => [
    button(`${facilityEmoji(item.label)} ${shortFacilityName(item.label)}${selected.has(item.id)?' · 🔔':''}`, `t:${item.id}`)
  ]);
  rows.push([button(msg('⬅️ Birimler',"⬅️ Directorates"), 'u'), button(msg('🎯 Seçimlerim',"🎯 My selections"), 'p')]);
  rows.push([mainMenuButton()]);
  return {
    chatId,
    text: `🏟️ ${facilityLabel(unit)}\n\n${msg('Bir tesis seç.','Choose a facility.')}`,
    replyMarkup: keyboard(rows)
  };
}

function selectionTime(item){
  return item.startAfter&&item.endBefore==='23:59'&&!item.exactTime?msg(`${item.startAfter} sonrası`,`After ${item.startAfter}`)
    :item.startAfter&&item.endBefore?`${item.startAfter}–${item.endBefore}`
    :item.startAfter?msg(`${item.startAfter} sonrası`,`After ${item.startAfter}`):item.endBefore?msg(`${item.endBefore} öncesi`,`Before ${item.endBefore}`):msg('Tüm seanslar',"All sessions");
}
function facilityTracking(store,id,dates=[],now=Date.now()){
  if(store.engine.health.lastState==='paused')return {icon:'⏸',text:msg('Takip duraklatıldı','Monitoring is paused'),live:false,planned:false};
  const plan=store.state.readerPlan;
  if(!plan?.facilityIds.includes(id))return {icon:'⏸',text:canSelectFacility(store,id)?msg('İlk takvim kontrolü bekleniyor',"Waiting for the first calendar check"):msg('Henüz takip edilmiyor',"Not being monitored yet"),live:false,planned:false};
  const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
  const future=dates.filter(date=>date>=today);
  if(dates.length&&!future.length)return {icon:'📅',text:msg('Seçtiğin tarihler geçti',"Your selected dates have passed"),live:false,planned:false};
  const requested=dates.length?[...new Set(future)]:plan.dates;
  const included=requested.filter(date=>plan.dates.includes(date));
  if(!included.length)return {icon:'⏸',text:msg('Seçtiğin günler henüz takip edilmiyor',"Your selected days are not being monitored yet"),live:false,planned:false};
  const phase=store.state.readerFacilityStates?.[id]?.phase||store.state.readerState?.phase;
  const blocked=['signing_in','waiting_verification','credentials_missing','credentials_locked','credentials_unavailable','login_failed','network_wait','site_access_denied','site_rate_limited','reconnecting'].includes(phase);
  const fresh=included.every(date=>{const age=now-Date.parse(store.engine.pages[`${id}|${date}`]?.lastSuccessAt||'');return age>=0&&age<=scheduleFreshMs(store,id);});
  // Users see a calm state: short reconnects and slow rounds are normal and
  // recover on their own. Only a long gap is mentioned, without alarm.
  const recent=included.every(date=>{const age=now-Date.parse(store.engine.pages[`${id}|${date}`]?.lastSuccessAt||'');return age>=0&&age<=Math.max(scheduleFreshMs(store,id),USER_CALM_MS);});
  if((!blocked&&fresh)||recent)return {icon:included.length===requested.length?'🟢':'🟠',text:included.length===requested.length?msg('Takip ediliyor',"Being monitored"):msg('Bazı seçili günler henüz takip edilmiyor',"Some selected days are not being monitored yet"),live:included.length===requested.length,planned:true};
  const last=Math.max(...included.map(date=>Date.parse(store.engine.pages[`${id}|${date}`]?.lastSuccessAt||'')||0));
  if(now-last<=60*60_000)return {icon:'⏳',text:msg('Kısa bir bekleme; takip sürecek',"Short pause; monitoring will resume"),live:false,planned:true};
  return {icon:'⏸',text:msg('Takip duraklatıldı; seçimlerin duruyor',"Monitoring paused; selections kept"),live:false,planned:true};
}
function facilityLive(store,id,now=Date.now()){return facilityTracking(store,id,[],now).live;}
// A time-window choice ("15:30 sonrası", whole day) is shown as the actual
// session times it covers, so each one can be kept or removed on its own.
const filterOf = item => Object.fromEntries(['date','startAfter','endBefore','notifyAvailable','exactTime']
  .filter(key => item[key] !== undefined).map(key => [key, item[key]]));
function rangeSessions(store, item) {
  if (item.exactTime || !item.date) return null;
  const sessions = sessionOptions(store, item.facilityId, item.date)
    .filter(o => (!item.startAfter || o.start >= item.startAfter) && (!item.endBefore || o.end <= item.endBefore));
  return sessions.length ? sessions : null;
}
// Removing one session from a time window keeps the others as separate
// session choices for that day.
function splitRange(store, chatId, key, start, end) {
  const item = store.subscriptionsFor(chatId).find(value => LocalStore.selectionKey(value) === key);
  const sessions = item ? rangeSessions(store, item) : null;
  if (!item || !sessions?.some(s => s.start === start && s.end === end)) return null;
  const day = store.filtersFor(chatId, item.facilityId).filter(f => f.date === item.date && f !== item).map(filterOf);
  for (const s of sessions) if (!(s.start === start && s.end === end)
    && !day.some(f => f.exactTime && f.startAfter === s.start && f.endBefore === s.end))
    day.push({ date: item.date, startAfter: s.start, endBefore: s.end, notifyAvailable: true, exactTime: true });
  store.replaceDayFilters(chatId, item.facilityId, item.date, day);
  return { facilityId: item.facilityId, date: item.date, startAfter: start, endBefore: end, exactTime: true };
}

// Everything on one screen: facility, then one line per day
// with all chosen times. Past days are left out; they can no longer alert.
// Technical health belongs to the private operator channel, not this screen.
function preferencesMenu(store,chatId,removed=null){
  const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const selections=store.subscriptionsFor(chatId).filter(s=>!s.date||s.date>=today).sort((a,b)=>a.facilityId.localeCompare(b.facilityId)
    ||(a.date||'').localeCompare(b.date||'')||(a.startAfter||'').localeCompare(b.startAfter||''));
  const lines=[msg('🔔 Seçimlerim',"🔔 My selections")];
  const label=item=>`${shortFacilityName(store.catalogFacility(item.facilityId)?.label||item.facilityId)} · ${item.date?shortDateLabel(item.date):msg('Her gün',"Every day")} · ${selectionTime(item)}`;
  if(removed)lines.push(msg(`✅ Silindi: ${label(removed)}`,`✅ Removed: ${label(removed)}`));
  const byFacility=new Map();
  for(const item of selections)(byFacility.get(item.facilityId)||byFacility.set(item.facilityId,[]).get(item.facilityId)).push(item);
  if(byFacility.size)lines.push(msg('Bu saatlerde yer açılınca haber veririm.','I will tell you when a place opens.'));
  for(const [id,subs] of byFacility){
    const f=store.catalogFacility(id);
    lines.push('',`${facilityEmoji(f?.label)} ${shortFacilityName(f?.label||id)}`);
    const byDay=new Map();
    for(const item of subs){const times=rangeSessions(store,item)?.map(s=>`${s.start}–${s.end}`)||[selectionTime(item)];(byDay.get(item.date||'')||byDay.set(item.date||'',[]).get(item.date||'')).push(...times);}
    // Phone-width lines: wrap a long list of times under its day.
    for(const [date,times] of byDay){
      let line=`• ${date?shortDateLabel(date):msg('Her gün',"Every day")}:`;
      for(const time of new Set(times)){
        if(`${line} ${time}`.length>45){lines.push(line);line='  ';}
        line+=`${line.trim()&&!line.endsWith(':')?',':''} ${time}`;
      }
      lines.push(line);
    }
  }
  if(!byFacility.size)lines.push('',msg('Henüz seçim yapmadın.','You have no selections yet.'),msg('“➕ Tesis ekle” ile gün ve seans seç.','Use “➕ Add a facility” to pick a session.'));
  else lines.push('',msg('🗑 Silmek için seçime dokun.','🗑 Tap a selection to remove it.'));
  let text=lines.join('\n');
  if(text.length>3900)text=`${text.slice(0,3880)}\n…`;
  // One delete button per saved selection, under its facility's edit button.
  const rows=[];let deletable=0;
  for(const [id,subs] of [...byFacility].slice(0,20)){
    rows.push([button(`✏️ ${shortFacilityName(store.catalogFacility(id)?.label||id)}`,`t:${id}`)]);
    // The facility is the ✏️ row above, so the button fits on a phone: day · time.
    for(const item of subs){
      const day=item.date?shortDateLabel(item.date):msg('Her gün',"Every day"),sessions=rangeSessions(store,item);
      if(sessions)for(const s of sessions){if(deletable++<60)rows.push([button(`🗑 ${day} · ${s.start}–${s.end}`,`pr:${LocalStore.selectionKey(item)}:${s.start.replace(':','')}${s.end.replace(':','')}`,'danger')]);}
      else if(deletable++<60)rows.push([button(`🗑 ${day} · ${selectionTime(item)}`,`px:${LocalStore.selectionKey(item)}`,'danger')]);
    }
  }
  rows.push([button(msg('➕ Tesis ekle',"➕ Add a facility"),'u','primary')]);
  rows.push(...siteKeyboard().inline_keyboard,[mainMenuButton()]);
  return {chatId,text,replyMarkup:keyboard(rows)};
}
function completionMenu(store,chatId,id,date){
  const filters=store.filtersFor(chatId,id).filter(f=>f.date===date);
  const f=store.catalogFacility(id);
  const lines=[filters.length?msg('✅ Seçimlerin kaydedildi.',"✅ Your selections are saved."):msg('Bu gün için henüz seçim yapmadın.',"You have not selected any sessions for this day."),
    `${facilityEmoji(f?.label)} ${shortFacilityName(f?.label||id)}`,shortDateLabel(date),
    ...filters.map(f=>selectionTime(f))];
  return {chatId,text:lines.join('\n'),replyMarkup:keyboard([[button(msg('🔔 Seçimlerim',"🔔 My selections"),'p')],[button(msg('➕ Başka seçim yap',"➕ Make another selection"),'u'),mainMenuButton()]])};
}

export function handleBotCommand(store,message){
 return withChatLanguage(store,message?.chat?.id,()=>handleBotCommandInLanguage(store,message));
}

function handleBotCommandInLanguage(store, message) {
  const chatId = message?.chat?.id;
  if (message?.chat?.type !== 'private' || !Number.isSafeInteger(chatId)) return null;
  const text = String(message.text || '').trim();
  const [command, argument] = text.split(/\s+/, 2);
  const commandName = command?.split('@')[0]?.toLowerCase();
  if (!store.isChatAllowed(chatId)) {
    if (['/start', '/join'].includes(commandName)) {
      const admission = store.admitChat(chatId, argument);
      if (admission === 'approved') return home(store, chatId);
      if (store.canSendBetaHint(chatId)) {
        return { chatId, text: admission === 'full'
          ? (store.accessMode==='public'?msg('Şu anda kullanıcı kapasitesi dolu. Daha sonra tekrar deneyebilirsin.',"The bot is at capacity. Please try again later."):msg('Davetli kullanıcı sınırına ulaşıldı. Şu anda yeni sohbet eklenemiyor; daha sonra yeniden deneyebilirsin.',"The invited-user limit has been reached. Please try again later."))
          : msg('Bu bot şu anda yalnız davetli küçük bir test grubuna açık. Katılmak için sahibinden gelen davet bağlantısını kullan.',"This bot is currently open to a small invited test group. Use the invitation link from the owner.") };
      }
    }
    return null;
  }
  if([siteShortcutText('tr'),siteShortcutText('en')].includes(text))return siteLinkReply(chatId,store.languageFor(chatId));
  switch (commandName) {
    case '/delete':
    case '/sil':
      store.forgetChat(chatId);
      return {chatId,clearChatCommands:true,replyMarkup:{remove_keyboard:true},text:msg('Seçimlerin ve bildirim kayıtların silindi. Yeniden başlamak için /start yaz.',"Your selections and notification records have been deleted. Send /start to begin again.")};
    case '/start':
    case '/help': return home(store, chatId);
    case '/menu': return home(store, chatId);
    case '/site':
    case '/rez': return siteLinkReply(chatId,store.languageFor(chatId));
    case '/settings':
    case '/ayarlar':
    case '/language':
    case '/dil': return settingsMenu(store,chatId);
    case '/support':
    case '/destek': return supportMenu(chatId);
    case '/test': return store.canSendTest(chatId) ? testReply(chatId) : testCooldownReply(chatId);
    case '/facilities':
    case '/tesisler': return unitsMenu(store, chatId);
    case '/watch':
    case '/izle': {
      if (!/^\d{1,4}$/.test(argument || '')) return { chatId, text: msg('Kullanım: /izle 17',"Usage: /watch 17"), replyMarkup: keyboard([[mainMenuButton()]]) };
      const facility = store.availableFacilities().find(item => item.id === argument);
      if (!facility) return { chatId, text: msg('Bu tesis henüz doğrulanmış listede görünmedi. /tesisler ile mevcut listeye bak.',"This facility is not in the verified list yet. Use /facilities to see the current list."), replyMarkup: keyboard([[mainMenuButton()]]) };
      return dayMenu(store, chatId, argument);
    }
    case '/unwatch':
    case '/birak':
      if (!/^\d{1,4}$/.test(argument || '')) return { chatId, text: msg('Kullanım: /birak 17',"Usage: /unwatch 17"), replyMarkup: keyboard([[mainMenuButton()]]) };
      store.unsubscribe(chatId, argument);
      return preferencesMenu(store, chatId);
    case '/selections':
    case '/izlediklerim': return preferencesMenu(store, chatId);
    case '/status':
    case '/durum': return preferencesMenu(store, chatId);
    default: return text ? {
      chatId,
      text: text.startsWith('/')
        ? msg('Bu komutu tanımıyorum. Ana menü için /menu, destek bilgisi için /destek yaz.',"Unknown command. Use /menu for the main menu or /support for contact details.")
        : msg('Bu bot serbest mesajları destek talebine dönüştürmez. Seçim yapmak için ana menüyü, iletişim bilgisi için Destek ve iletişim bölümünü aç.',"Messages typed here are not forwarded to support. Use the main menu to make selections or open Support for contact details."),
      replyMarkup: keyboard([[button('⚙️ Settings','settings'),mainMenuButton()]])
    } : null;
  }
}

export function handleBotCallback(store,query){
 return withChatLanguage(store,query?.message?.chat?.id,()=>handleBotCallbackInLanguage(store,query));
}

function handleBotCallbackInLanguage(store, query) {
  const chatId = query?.message?.chat?.id;
  if (query?.message?.chat?.type !== 'private' || !Number.isSafeInteger(chatId)
      || query.from?.id !== chatId || !Number.isSafeInteger(query.message?.message_id)) return null;
  if (!store.isChatAllowed(chatId)) return null;
  const data = String(query.data || '');
  let result;
  if (data === 'h') result = home(store, chatId);
  // Retired quick-selection buttons in older messages return to the simple menu.
  else if(data.startsWith('m:'))result=home(store,chatId);
  else if(data==='settings')result=settingsMenu(store,chatId);
  // Old inline buttons cannot bring back the retired public week notice.
  else if(/^wn:[01]$/.test(data)){result=settingsMenu(store,chatId);}
  else if(/^lang:(tr|en)$/.test(data)){
    const preferredLanguage=data.slice(5);
    store.setLanguage(chatId,preferredLanguage);
    result={...withLanguage(preferredLanguage,()=>settingsMenu(store,chatId)),languageChanged:preferredLanguage};
  }
  else if (data === 'u') result = unitsMenu(store, chatId);
  else if(data==='soon:pool'){
    const unit=[...facilitiesByUnit(store).keys()].find(unit=>/havuz/i.test(unit));
    result=unit?facilityMenu(store,chatId,unit):{...unitsMenu(store,chatId),answerText:msg('🏊 Tadilat tamamlanınca burada olacak.','🏊 Available here after the renovations.')};
  }
  else if (/^p(?::\d{1,4})?$/.test(data)) result = preferencesMenu(store, chatId);
  else if (/^px:[a-f0-9]{12}$/.test(data)) result = preferencesMenu(store, chatId, store.removeSelection(chatId, data.slice(3)));
  else if (/^pr:[a-f0-9]{12}:\d{8}$/.test(data)) {
    const [, key, code] = data.split(':');
    result = preferencesMenu(store, chatId, splitRange(store, chatId, key, `${code.slice(0,2)}:${code.slice(2,4)}`, `${code.slice(4,6)}:${code.slice(6,8)}`));
  }
  else if (/^done:\d{1,4}:\d{8}$/.test(data)){const [,id,day]=data.split(':');const date=`${day.slice(0,4)}-${day.slice(4,6)}-${day.slice(6,8)}`;result=store.catalogFacility(id)&&pickerDates().includes(date)?completionMenu(store,chatId,id,date):preferencesMenu(store,chatId);}
  // Retired status buttons never reopen technical diagnostics in the public bot.
  else if (data === 's') result = preferencesMenu(store, chatId);
  else if (data === 'c') result = supportMenu(chatId);
  else if (/^(?:d|da|dx|q|lg):/.test(data)) result = handlePickerCallback(store,chatId,data) || unitsMenu(store,chatId);
  else if (/^back:\d{1,4}$/.test(data)) {
    const facility=store.catalogFacility(data.slice(5));
    result=facility?facilityMenu(store,chatId,facility.unit):unitsMenu(store,chatId);
  }
  else if (data === 'test') {
    result = store.canSendTest(chatId) ? testReply(chatId) : testCooldownReply(chatId);
  }
  else if (/^u:[a-f0-9]{10}$/.test(data)) {
    const unit = [...facilitiesByUnit(store).keys()].find(value => unitKey(value) === data.slice(2));
    result = unit ? facilityMenu(store, chatId, unit) : unitsMenu(store, chatId);
  } else if (/^f:\d{1,4}:[01]$/.test(data)) {
    const [,id,desired]=data.split(':');
    const facility=store.catalogFacility(id);
    if(!facility)result=unitsMenu(store,chatId);
    else if(desired==='0'){store.unsubscribe(chatId,id);result=facilityMenu(store,chatId,facility.unit);}
    else result=dayMenu(store,chatId,id);
  } else if (/^t:\d{1,4}$/.test(data)) {
    result=dayMenu(store,chatId,data.slice(2))||unitsMenu(store,chatId);
  } else if (/^(?:a|w):(\d{1,4})(?::.*)?$/.test(data)) {
    // Already-sent menus remain clickable. They must not silently restore the
    // old every-day time windows or erase the new dated selections.
    result=dayMenu(store,chatId,data.split(':')[1])||unitsMenu(store,chatId);
  } else result = home(store, chatId);
  // Editing a long list into a much shorter menu leaves Telegram's view where
  // the long message was, so the new menu is sent at the bottom instead.
  const oldRows = Array.isArray(query.message?.reply_markup?.inline_keyboard) ? query.message.reply_markup.inline_keyboard.length : 0;
  const newRows = result?.replyMarkup?.inline_keyboard?.length || 0;
  const replace = oldRows >= 8 && oldRows - newRows >= 4;
  return { ...result, callbackId: query.id, editMessageId: query.message.message_id,
    ...(replace ? { replaceMessage: true, replacedText: msg('⬇️ Menü aşağıda.', '⬇️ The menu is below.') } : {}) };
}

// Alerts go out in rounds: a round's recipients are marked "sending" with one
// state write (a crash can then never resend them), sent several at a time
// at Telegram's pace with at most one message per chat, and their results are
// written once. 1000 watchers of one session take about 40 seconds.
export async function flushOutbox(store, api, { max = 200, perSecond = 25, concurrency = 8 } = {}) {
  let handled = 0, blocked = false, nextStart = Date.now();
  const gone = new Set();
  const pace = async () => {
    const wait = nextStart - Date.now();
    nextStart = Math.max(Date.now(), nextStart) + 1000 / perSecond;
    if (wait > 0) await delay(wait);
  };
  while (!blocked && handled < max) {
    const chats = new Set(), round = [];
    for (const item of store.dueDeliveries()) {
      if (round.length >= Math.min(perSecond, max - handled)) break;
      const chat = String(item.chatId);
      if (chats.has(chat)) continue;
      chats.add(chat);
      const facility = store.catalogFacility(item.event?.facility?.id);
      if (!store.isChatAllowed(item.chatId) || !facility || facility.enabled===false) {
        store.markDelivery(item.id, { ok: false, permanent: true,
          reason: !facility||facility.enabled===false ? 'uncataloged_facility' : 'chat_not_approved' }, false);
        handled++;
        continue;
      }
      if (store.beginDelivery(item.id, false)) round.push({ item, facility });
    }
    // The loop looks four times a second; an idle look must not rewrite the
    // whole state file (it did, ~4 times a second, 2 Nov 2026).
    if (!round.length) { if (handled) store.save(); break; }
    // Persist in-flight state before any API call.
    store.save();
    let index = 0;
    const worker = async () => {
      while (index < round.length) {
        const { item, facility } = round[index++];
        await pace();
        if (blocked) { store.revertDelivery(item.id); continue; }
        try {
          const maxAge = Number.isFinite(item.maxAgeMs) ? item.maxAgeMs : null;
          const remaining = maxAge ? Math.max(1, maxAge - (Date.now() - Date.parse(item.event.observedAt))) : 20_000;
          const sentMessage=await api.sendMessage(item.chatId, formatAvailability({ ...item.event,
            facility: { id: facility.id, label: facility.label } },store.languageFor(item.chatId)),withLanguage(store.languageFor(item.chatId),siteKeyboard),Math.min(maxAge?5_000:20_000,remaining));
          store.markDelivery(item.id, { ok: true,messageId:sentMessage?.message_id }, false);
          store.noteTelegramAvailabilityDelivery();
        } catch (error) {
          const status = Number(error.status);
          const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
          const uncertain = !permanent && status !== 429;
          store.markDelivery(item.id, { ok: false, permanent, uncertain,
            retryAfterMs: error.retryAfterMs, reason: `Telegram HTTP ${error.status || 'network'}` }, false);
          if (error.chatGone) gone.add(String(item.chatId));
          if (error.status === 429) {
            store.deferQueuedUntil(Date.now() + Math.max(5_000, error.retryAfterMs || 30_000));
            blocked = true;
          }
        }
        handled++;
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, round.length)) }, worker));
    store.save();
    // A chat that blocked the bot is forgotten: its selections and its place
    // under the public chat limit are freed, and no later alert is tried.
    for (const chat of gone) store.forgetChat(chat);
    gone.clear();
  }
  return handled;
}

async function runOutboxLoop(store, api, signal) {
  // Keep vacancy delivery independent from the bot menu. One slow Telegram
  // send must not hold the next getUpdates call or a user's button press.
  while (!signal.aborted) {
    let handled = 0;
    try {
      handled = await flushOutbox(store, api);
    } catch (error) {
      store.noteTelegramError(error.status);
      console.error(`${new Date().toISOString()} Telegram bildirim kuyruğu geçici hata: HTTP ${error.status || 'network'}`);
    }
    // A full round may leave more recipients; otherwise look again shortly.
    if (!signal.aborted) await delay(handled ? 50 : 250, undefined, { signal }).catch(() => {});
  }
}

// Keep polling and callback acknowledgements independent from outgoing menu
// requests. Serialize each chat to prevent old edits overwriting new screens;
// coalesce only pending edits of the same message, never selection mutations.
export function createMenuDispatcher(store, api) {
  const workers = new Map();
  const commandWorkers=new Map();
  function queueCommands(reply){
    if(!reply.languageChanged&&!reply.clearChatCommands)return;
    const key=String(reply.chatId),job={chatId:reply.chatId,language:reply.languageChanged,clear:reply.clearChatCommands};
    let worker=commandWorkers.get(key);
    if(worker){worker.pending=job;return;}
    worker={pending:job,task:null};commandWorkers.set(key,worker);
    worker.task=(async()=>{
      try{
        while(worker.pending){
          const next=worker.pending;worker.pending=null;
          try{
            if(next.clear&&typeof api.clearChatCommands==='function')await api.clearChatCommands(next.chatId);
            else{
              if(next.language&&store.languageFor?.(next.chatId)===next.language&&typeof api.setChatCommands==='function')await api.setChatCommands(next.chatId,next.language);
            }
          }catch{ /* Inline menus remain usable if native command setup fails. */ }
        }
      }finally{commandWorkers.delete(key);}
    })();
  }
  async function send(reply, queuedAt) {
    if (!store.canSendMenuReply(reply.chatId)) return;
    try {
      if (reply.editMessageId && reply.replaceMessage && reply.kind !== 'test' && typeof api.deleteMessage === 'function') {
        await api.sendMessage(reply.chatId, reply.text, reply.replyMarkup);
        // A bot may delete its own message for 48 hours; older ones shrink.
        try { await api.deleteMessage(reply.chatId, reply.editMessageId); }
        catch { await api.editMessageText(reply.chatId, reply.editMessageId, reply.replacedText).catch(() => {}); }
      } else if (reply.editMessageId && reply.kind !== 'test') {
        await api.editMessageText(reply.chatId, reply.editMessageId, reply.text, reply.replyMarkup);
      } else await api.sendMessage(reply.chatId, reply.text, reply.replyMarkup);
      store.noteTelegramReply();
      store.telegramHealth.lastMenuLatencyMs = Date.now() - queuedAt;
      if (reply.kind === 'test') store.noteTelegramTestDelivery();
      // Native command setup has its own ordered worker, so even a slow
      // request cannot hold this chat's next inline-menu tap.
      queueCommands(reply);
    } catch (error) {
      if (error.notModified) return;
      store.noteTelegramError(error.status);
      if (error.status === 429) store.deferMenuReply(reply.chatId, error.retryAfterMs);
    }
  }
  // One latest screen per chat. Approved users never evict each other;
  // the admission cap already bounds this map. Guest hints have their own
  // small budget and cannot displace a registered user's reply.
  const waiting = new Map(), guestWaiting = new Map();
  function enqueue(reply, queuedAt = Date.now()) {
    const key = String(reply.chatId);
    let worker = workers.get(key);
    const item = { reply, queuedAt };
    if (worker) {
      const index = reply.editMessageId && reply.kind !== 'test'
        ? worker.queue.findIndex(x => x.reply.editMessageId === reply.editMessageId && x.reply.kind !== 'test') : -1;
      if (index >= 0) {
        item.reply.languageChanged||=worker.queue[index].reply.languageChanged;
        worker.queue[index] = item;
      }
      else {
        if (worker.queue.length >= 8) worker.queue.shift();
        worker.queue.push(item);
      }
      return;
    }
    // Admission is bounded in both invite and public modes. Beyond 64 chats in
    // flight a reply waits its turn (newest screen per chat) instead of being dropped.
    if (workers.size >= 64) {
      const approved=reply.clearChatCommands||store.isChatAllowed?.(reply.chatId);
      const target=approved?waiting:guestWaiting;
      const previous=waiting.get(key)||guestWaiting.get(key);
      if(previous){item.reply.languageChanged||=previous.reply.languageChanged;item.reply.clearChatCommands||=previous.reply.clearChatCommands;}
      if(!approved&&!previous&&guestWaiting.size>=128)return;
      waiting.delete(key);guestWaiting.delete(key);target.set(key,item);
      return;
    }
    worker = { queue: [item], task: null };
    workers.set(key, worker);
    worker.task = (async () => {
      try {
        while (worker.queue.length) {
          const next = worker.queue.shift();
          await send(next.reply, next.queuedAt);
        }
      } finally {
        workers.delete(key);
        const target=waiting.size?waiting:guestWaiting;const entry=target.entries().next().value;
        if(entry){target.delete(entry[0]);const next=entry[1];enqueue(next.reply,next.queuedAt);}
      }
    })();
  }
  return { enqueue, drain: async()=>{while(workers.size){await Promise.all([...workers.values()].map(w=>w.task));}await Promise.all([...commandWorkers.values()].map(w=>w.task));} };
}

// Compatibility drain for old persisted jobs. Public week/update broadcasts
// are retired: even a caller holding a legacy job cannot send one.
export async function flushBroadcast(store) {
  if (store.state.broadcast) { store.state.broadcast = null; store.save(); }
  return 0;
}

export async function runTelegramLoop(store, api, signal) {
  api=withFixedSiteShortcut(store,api);
  let outboxLoop;
  const menuDispatcher = createMenuDispatcher(store, api);
  const slotUpdateLoop=runSlotUpdateLoop(store,api,signal);
  let consecutivePollFailures = 0;
  let unapprovedOffsetPending = false;
  let lastUnapprovedOffsetSaveAt = 0;
  try {
    while (!signal.aborted) {
      try {
        const updates = await api.getUpdates(store.state.telegramOffset);
        store.noteTelegramPoll();
        consecutivePollFailures = 0;
        for (const update of updates) {
          // Dismiss Telegram's button spinner before synchronous state writes
          // or menu formatting. The acknowledgement is independent from the
          // edited menu, so a slow acknowledgement cannot delay later taps.
          const feedbackTap=/^(?:q|da|dx|d|m|soon):/.test(update.callback_query?.data||'');
          if (!feedbackTap && update.callback_query?.id && typeof api.answerCallbackQuery === 'function') {
            try {
              void Promise.resolve(api.answerCallbackQuery(update.callback_query.id)).catch(() => {});
            } catch { /* A menu reply can still be delivered. */ }
          }
          const reply = update.callback_query
            ? handleBotCallback(store, update.callback_query)
            : handleBotCommand(store, update.message);
          if(feedbackTap&&update.callback_query?.id&&typeof api.answerCallbackQuery==='function'){
            try{void Promise.resolve(api.answerCallbackQuery(update.callback_query.id,reply?.answerText)).catch(()=>{});}catch{}
          }
          const chatId = update.callback_query?.message?.chat?.id ?? update.message?.chat?.id;
          if (store.isChatAllowed(chatId)) {
            // Keep the approved cursor durable per update. Batching these
            // actions would widen the crash replay window for selection taps.
            if (store.setTelegramOffset(update.update_id + 1)) {
              unapprovedOffsetPending = false;
              lastUnapprovedOffsetSaveAt = Date.now();
            }
          } else if (store.setTelegramOffset(update.update_id + 1, false)) {
            // Unapproved updates have no durable user action to replay. Save
            // their cursor at a bounded interval instead of once per message.
            unapprovedOffsetPending = true;
          }
          if (reply) menuDispatcher.enqueue(reply);
        }
        if (unapprovedOffsetPending && Date.now() - lastUnapprovedOffsetSaveAt >= UNAPPROVED_OFFSET_FLUSH_MS) {
          store.save();
          unapprovedOffsetPending = false;
          lastUnapprovedOffsetSaveAt = Date.now();
        }
        // Process any pending choices before the delivery worker starts, so
        // queued alerts removed by a user's first button tap are not sent.
        if (!outboxLoop && !signal.aborted) outboxLoop = runOutboxLoop(store, api, signal);
      } catch (error) {
        if (signal.aborted) break;
        store.noteTelegramError(error.status);
        consecutivePollFailures++;
        console.error(`${new Date().toISOString()} Telegram bağlantısı geçici hata: HTTP ${error.status || 'network'}; ardışık=${consecutivePollFailures}`);
        // Polling can fail independently of outgoing messages (for example a
        // getUpdates conflict). Keep attempting fresh queued alerts anyway.
        if (!outboxLoop && !signal.aborted) outboxLoop = runOutboxLoop(store, api, signal);
        await delay(pollRetryDelayMs(consecutivePollFailures, error.retryAfterMs),
          undefined, { signal }).catch(() => {});
      }
    }
  } finally {
    // A graceful stop should not replay the latest unapproved update.
    if (unapprovedOffsetPending) store.save();
    await slotUpdateLoop;
    await menuDispatcher.drain();
    if (outboxLoop) await outboxLoop;
    if(typeof api.stopSiteLinks==='function')await api.stopSiteLinks();
  }
}
