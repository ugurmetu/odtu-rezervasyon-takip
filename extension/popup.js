/* global chrome */
"use strict";

const statusElement = document.getElementById("status");
const modeElement = document.getElementById("mode");
const button = document.getElementById("toggle");
const STALE_STATUS_MS = 3 * 60_000;
const phases={preparing:'Takvimler hazırlanıyor',signing_in:'ODTÜ oturumu otomatik yenileniyor',
  reconnecting:'Takvim bağlantısı yeniden kuruluyor',waiting_verification:'Giriş doğrulaması bekleniyor; gerekirse giriş sayfasını kontrol et',
  credentials_missing:'Otomatik oturum için giriş bilgilerini bir kez kaydet',credentials_locked:'Mac parola kasası kilitli',
  credentials_unavailable:'Parola kasası kontrol edilmeli',login_failed:'Giriş başarısız; Otomatik oturum bölümünü kontrol et',network_wait:'Bağlantı bekleniyor; yeniden denenecek'};
const names = {
  ok: "Güncel takvim yanıtı doğrulandı",
  no_tab: "Takip edilen rezervasyon sekmesi açık değil; yeniden başlatınca açık sekme seçilir",
  login_required: "Oturum açık değil",
  calendar_unavailable: "Takvim veya güncel site yanıtı doğrulanamadı",
  error: "Yerel servisle bağlantı kurulamadı"
};
const details = {
  config_missing: "Yerel yapılandırma dosyası bulunamadı",
  config_invalid: "Yerel yapılandırma geçersiz",
  local_server_unavailable: "Yerel servis yanıt vermiyor; site sorgusu bekletiliyor",
  login_required: "Rezervasyon oturumu sona erdi; tekrar giriş yap",
  timeout: "Takvim yanıtı zaman aşımına uğradı",
  rate_limited: "Sıradaki kontrol bekleniyor",
  calendar_unavailable: "Takvim bileşeni bulunamadı",
  ambiguous_request: "Aynı anda başka takvim isteği oluştu",
  schedule_render_failed: "Site takvim yanıtını işleyemedi",
  unverified_response: "Güncel takvim yanıtı doğrulanamadı",
  no_schedule_request: "Site yeni takvim isteği başlatmadı",
  refresh_failed: "Takvim yenilemesi başarısız oldu",
  parse_failed: "Takvim verisi beklenen biçimde değil",
  unexpected_page: "Beklenen rezervasyon sayfası açık değil",
  login_form_present: "Rezervasyon oturumu açık değil",
  primefaces_unavailable: "Sitenin takvim altyapısına erişilemiyor",
  schedule_widget_missing: "Takvim bileşeni bulunamadı",
  schedule_widget_unusable: "Takvim bileşeni yenilenemiyor",
  calendar_view_unavailable: "Takvim görünümü okunamadı",
  not_day_view: "Gün görünümünü seçin",
  calendar_date_unavailable: "Takvim tarihi okunamadı",
  calendar_date_mismatch: "Takvim günü uyuşmuyor",
  calendar_date_expired: "Takvimdeki gün geçti; yeni günü seçin",
  calendar_day_advanced: "Takvim yeni güne alındı; güncel okuma bekleniyor",
  calendar_day_advance_failed: "Takvim yeni güne geçirilemedi; resmî sitede günü kontrol et",
  facility_not_selected: "Önce bir tesis seçin",
  tab_query_failed: "Rezervasyon sekmeleri okunamadı",
  content_no_response: "Rezervasyon sekmesinden yanıt alınamadı",
  invalid_capture_payload: "Takvim okuması beklenen biçimde değil",
  content_timeout: "Rezervasyon sekmesi geç yanıt verdi",
  content_unreachable: "Rezervasyon sekmesine erişilemiyor",
  site_access_denied: "Site erişimi reddetti; takip durduruldu",
  site_rate_limited: "Site hız sınırı uyguladı; takip durduruldu"
};

function showStatus(message, mode, tone) {
  statusElement.textContent = message;
  statusElement.dataset.tone = tone;
  modeElement.textContent = mode;
}

async function refresh() {
  const { paused = true, pausedReason, lastStatus, serviceHealth } = await chrome.storage.local.get(["paused", "pausedReason", "lastStatus",'serviceHealth']);
  const coverage=document.getElementById('coverage');
  if(coverage)coverage.textContent=serviceHealth?.reader?`${serviceHealth.reader.checkedWithinSchedule??serviceHealth.reader.fresh}/${serviceHealth.reader.total} takvim son tarama aralığında okundu`:'';
  button.textContent = paused ? "Başlat" : "Durdur";
  if (paused) {
    const message = pausedReason && details[pausedReason]
      ? `${details[pausedReason]}. Resmî siteyi kontrol ettikten sonra elle başlatabilirsin.`
      : "Durduruldu. Başlatınca seçili tesisin gün takvimi yenilenecek.";
    showStatus(message, pausedReason ? "İşlem gerekli" : "Durduruldu", pausedReason ? "warning" : "neutral");
    return;
  }
  if (!lastStatus) {
    showStatus("İlk okuma bekleniyor…", "Başlıyor", "warning");
    return;
  }
  if(lastStatus.state==='recovering'){
    const required=['waiting_verification','credentials_missing','credentials_locked','credentials_unavailable','login_failed'].includes(lastStatus.detail);
    showStatus(phases[lastStatus.detail]||'Takip yeniden bağlanıyor',required?'Bir adım gerekli':'Toparlanıyor',required?'warning':'neutral');
    return;
  }
  const checkedAt = Date.parse(lastStatus.at || "");
  const time = Number.isFinite(checkedAt) ? new Date(checkedAt).toLocaleTimeString("tr-TR") : "";
  if (lastStatus.state === "ok" && (!Number.isFinite(checkedAt)
    || Date.now() - checkedAt > STALE_STATUS_MS)) {
    showStatus(`Son doğrulanmış sorgu${time ? ` ${time}` : ""}; yeni kontrol gelmedi. Takibin şu anda çalıştığı doğrulanamıyor.`, "Kontrol bekleniyor", "warning");
    return;
  }
  const confirmedCalendar = lastStatus.state === "ok" && lastStatus.fresh === true
    && Number.isInteger(lastStatus.slots) && lastStatus.slots > 0;
  const emptyCalendar = lastStatus.state === "ok" && lastStatus.fresh === true && lastStatus.slots === 0;
  const summary = emptyCalendar
    ? "Kontrol tamamlandı; uygun seans bekleniyor"
    : lastStatus.state === "ok" && !confirmedCalendar
      ? "Güncel takvim yanıtı doğrulanamadı"
      : details[lastStatus.detail] || names[lastStatus.state] || "Bilinmeyen durum";
  const facility = lastStatus.facility ? ` · ${lastStatus.facility}` : "";
  const error = lastStatus.state === "error" || ["site_access_denied", "site_rate_limited"].includes(lastStatus.detail);
  showStatus(`${summary}${facility}${time ? ` · ${time}` : ""}`,
    confirmedCalendar||emptyCalendar ? "Takip açık" : error ? "Bağlantı sorunu" : "Yeniden deneniyor",
    confirmedCalendar||emptyCalendar ? "success" : error ? "error" : "warning");
}

const sessionStatus=document.getElementById('session-status');
async function sessionInfo(){
  try{const result=await chrome.runtime.sendMessage({type:'rez:session-status'});
    if(sessionStatus)sessionStatus.textContent=result?.configured?'Otomatik giriş hazır. Parolan burada gösterilmez.':'Bir kez kaydedince oturum kapanırsa yeniden giriş denenir.';
  }catch{if(sessionStatus)sessionStatus.textContent='Yerel servis bekleniyor.';}
}
document.getElementById('save-session')?.addEventListener('click',async()=>{
  const save=document.getElementById('save-session');save.disabled=true;
  const username=document.getElementById('username'),password=document.getElementById('password');
  try{const result=await chrome.runtime.sendMessage({type:'rez:save-credentials',username:username.value,password:password.value});
    if(!result?.ok)throw new Error('not_saved');
    username.value='';password.value='';sessionStatus.textContent='Güvenli biçimde kaydedildi. Oturum otomatik yenilenecek.';
  }catch{password.value='';sessionStatus.textContent='Kaydedilemedi; yerel servis veya Mac parola kasası kontrol edilmeli.';}
  finally{save.disabled=false;}
});
void sessionInfo();

button.addEventListener("click", async () => {
  button.disabled = true;
  button.textContent = "İşleniyor…";
  let paused = true;
  try {
    ({ paused = true } = await chrome.storage.local.get("paused"));
    await chrome.runtime.sendMessage({ type: "rez:set-paused", paused: !paused });
    await refresh();
  } catch {
    showStatus("Uzantı yanıt vermiyor. Biraz sonra tekrar dene.", "Bağlantı sorunu", "error");
    button.textContent = paused ? "Başlat" : "Durdur";
  } finally {
    button.disabled = false;
  }
});

void refresh();
setInterval(() => { void refresh(); }, 15_000);
