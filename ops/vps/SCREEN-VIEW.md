# Sunucu tarayıcı ekranı — yalnız görüntüleme

29 Ekim 2026: Kullanıcı, arada sunucudaki tarayıcıyı izlemek için ekran bağlantısını istedi. Önceki geçici ekran hizmetleri kapalıydı. Mevcut bot, Xvfb ve Chrome yeniden başlatılmadan yalnız görüntüleme erişimi açıldı.

- `odtu-rez-screen-view.service`: rez kullanıcısında x11vnc, mevcut :99 ekranı, localhost, sunucu tarafında `-viewonly`.
- `odtu-rez-screen-web.service`: rez kullanıcısında noVNC/websockify, yalnız 127.0.0.1:6080 → 127.0.0.1:5900.
- Mac'te SSH tüneli yalnız 127.0.0.1:6080 dinler; bağlantı bilgileri özel `.local/vps-connection.json` dosyasından okunur. Dış erişim portu açılmadı; yeni bot, okuyucu veya otomasyon başlatılmadı.
- Kullanıcı bağlantısı: http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale&view_only=1
- Bağlantı yalnız tünelin açık olduğu bu Mac'te çalışır; telefon veya başka bilgisayar için erişim kurulmadı. Mac/SSH tüneli veya VPS yeniden başlarsa bağlantı yeniden kurulmalıdır. Hizmetler transient, açılışta kalıcı etkinleştirilmiş değildir.
- HTTP 200/noVNC ve WebSocket üzerinden RFB protokol yanıtı doğrulandı. Kullanıcının ekranı gördüğü henüz teyit edilmedi. Ekrana tıklama/klavye girdisi veya ODTÜ/Telegram'a ek sorgu/mesaj yapılmadı.

Kullanıcı bu ekranı izlemek istediği için görüntüleme hizmetleri/tünel açık bırakıldı. Diğer işleri bitirirken bu erişimi yanlışlıkla kapatma. Gerekmediğinde yalnız bu iki ekran hizmeti ve ilgili SSH tüneli kapatılır; bot/tarayıcı/display hizmetlerine dokunulmaz. Eski doğrulama onayları yeni denemelere taşınmaz.

## 31 Ekim 2026 — Tıklanabilir mod yalnız gerektiğinde (kullanıcı kararı)
Kullanıcı kararı: ekran bağlantısı varsayılan olarak yalnız izleme kalır. Tıklanabilir mod yalnız insan doğrulaması gerektiğinde ya da kullanıcı istediğinde geçici açılır, iş bitince yeniden yalnız izlemeye döner. Geçiş `node .local/screen-mode.mjs view|interactive|status`; yalnız `odtu-rez-screen-view` geçici servisini `-viewonly` ile ya da onsuz yeniden başlatır. Bot, Xvfb, Chrome ve noVNC web servisine dokunmaz. Tıklanabilir modda istemci bağlantısı `view_only=1` olmadan açılır. Yalnız izleme modunda yeniden başlatma 31 Ekim'de denendi (HTTP 200); tıklanabilir mod henüz hiç açılmadı. Okuyucuyla aynı sekme kullanıldığı için tesis değiştirme, sekme kapatma ya da çıkış okumayı bozar.


## 5 Kasım 2026 — Ekran servisi kendini yeniden açar
09.33'te Chrome ve sanal ekran yeniden başlatılınca x11vnc kapandı (durum 3) ve bağlantı görüntüsüz kaldı. `screen-mode.mjs` artık geçici servisi `Restart=always`, `RestartSec=5` ile açar; ekran yeniden başlarsa görüntü servisi de birkaç saniyede geri gelir. Yalnız izleme modu korunur; bot/Chrome'a dokunulmadı.
