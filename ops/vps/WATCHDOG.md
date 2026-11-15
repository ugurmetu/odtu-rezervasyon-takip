# Sunucu bekçisi (Claude, 31 Ekim 2026)

Kullanıcı ve Codex'in onayıyla: VPS'te botun ve Chrome'un dışında, dakikada bir çalışan sınırlı otomatik toparlama. Mac/Codex kapalıyken de çalışır. Karmaşık teşhis ve kod onarımı Codex/Claude sohbetlerinde kalır.

## Parçalar
- `src/watchdog.mjs`: karar (`decide`, saf fonksiyon) + çalıştırıcı + komut satırı. Root olarak `odtu-rez-watchdog.timer` ile dakikada bir `run`.
- `src/intervention.mjs`: ortak müdahale kilidi, bekleme (hold) ve müdahale kaydı. Dosyalar özel dizinde: `intervention.lock`, `watchdog-hold.json`, `interventions.ndjson` (0600, uygulama kullanıcısına ait); bekçi durumu `watchdog.json`.
- `src/memory-guard.mjs`: aynı kilidi kullanır. Başkasının kilidi ya da bekleme varken `waiting_lock`; sekme yenilerken 5 dk kilit alır ve kayda `rotate_tab` yazar.
- `ops/vps/odtu-rez-watchdog.service` + `.timer`: `/etc/systemd/system` altına kurulur (`OnUnitActiveSec=60s`, `OnBootSec=2min`).

## Karar sırası
1. Bekleme (hold), okuyucu yapılandırmasında `maintenance`, elle durdurulmuş servis (inactive/success) → hiçbir şey (`hold`). Durdurulmuş sistemi açmaz.
2. Son 3 dk içinde tesis okuması varsa (girişte 10 dk) → `ok`. Bekçi önceden müdahale ettiyse, müdahaleden sonra en az 5 farklı tesis yeniden okunmadan toparlandı sayılmaz (`verify` → `recovered`).
3. Okuma durmuşsa: doğrulama, giriş/kimlik, siteden ret/429, duraklatılmış okuyucu → `owner` (dokunmaz; sunucunun mevcut yönetici uyarısı ve Codex kontrolü bildirir).
4. Başkasının kilidi varsa → `locked`.
5. Siteyi yalnız sorun varken yoklar (dakikada en çok 1 istek): yalnız 2xx/3xx yanıtı açık sayılır; 404/410 dahil diğer hata yanıtları, kapalı/5xx/zaman aşımı → `site_down` (yeniden başlatma yok); 403/429 → `owner`.
6. Site açık: herhangi bir müdahaleden sonraki 5 dk → `settling`. Otomatik aktörlerin (bekçi + bellek koruması) yeniden başlatmaları saatte 3 / günde 6'yı geçtiyse → `limit` (yönetici botuna bir kez). Elle kilitler bu bütçeyi tüketmez.
7. Yoksa önce `restart_browser` (Chrome, `--restore-last-session`), düzelmezse `restart_all` (bot + Chrome). Bot sağlık sorgusuna yanıt vermiyorsa ya da bot servisi çökmüşse doğrudan `restart_all`. Çökmüş servis site kapalıyken de yeniden başlatılır.

Bildirim yalnız ayrı yönetici botundan (ana bot reddedilir): bekçinin müdahalesiyle doğrulanmış toparlanma ve sınırın dolması. Site kesintisi ve sahip işlemi gerektiren durumlar için mevcut uyarılar kullanılır; bekçi tekrar göndermez.

## Codex/Claude için komutlar (sunucuda)
```
sudo /opt/odtu-rez/runtime/node/bin/node /opt/odtu-rez/watchdog/watchdog.mjs status
sudo /opt/odtu-rez/runtime/node/bin/node /opt/odtu-rez/watchdog/watchdog.mjs check
sudo /opt/odtu-rez/runtime/node/bin/node /opt/odtu-rez/watchdog/watchdog.mjs lock codex 30 "onarım nedeni"
sudo /opt/odtu-rez/runtime/node/bin/node /opt/odtu-rez/watchdog/watchdog.mjs unlock codex
sudo /opt/odtu-rez/runtime/node/bin/node /opt/odtu-rez/watchdog/watchdog.mjs hold 120 "bakım nedeni"
sudo /opt/odtu-rez/runtime/node/bin/node /opt/odtu-rez/watchdog/watchdog.mjs release-hold
```
Elle onarım/dağıtım öncesi `lock` (ya da uzun bakımda `hold`), iş bitince `unlock`/`release-hold`. Kilit süresi dolunca kendiliğinden düşer. `status` son kararı, açık olayı, kilidi, beklemeyi ve son 15 müdahaleyi verir; Codex kontrolleri bunu okuyabilir.

## Durum
- 31 Ekim 21.19 İstanbul: bekçi kendi klasöründe kuruldu (`/opt/odtu-rez/watchdog/watchdog.mjs` + `intervention.mjs`, root:root 0644), sürüm klasörlerinin dışında; kötü bir sürüm onu durduramaz, bot/Chrome yeniden başlatılmadan açıldı. `odtu-rez-watchdog.timer` etkin (açılışta da başlar). Kaynak güncellenince bu iki dosya da kopyalanmalı.
- Ek koruma: bot ya da Chrome son 5 dk içinde herhangi biri tarafından başlatıldıysa (kilitsiz dağıtım dahil) bekçi bekler (`settling`). `check` komutu hiçbir şeye dokunmadan o anki kararı yazar.
- İlk kararlar: `check` ve iki çalıştırma `site_down` (ODTÜ 19.44'ten beri kapalı, okuyucu `network_wait`); yeniden başlatma yapılmadı. Ortak kayıtta Codex'in 20.48 `deploy_reader` (0.10.8, sabit 4 dk yeniden deneme) girişi görüldü; bekçi bunu 5 dk bekleme için sayar.
- 18/18 bekçi/kilit/bellek testi; tam set son çalıştırmada 474/474.
- 31 Ekim 21.44: ODTÜ bir an yanıt verdi (302), sonra yine kapandı; bekçi `site_down` kaldı, müdahale etmedi (doğru). 1 Kasım 02.40'a kadar site Mac ve VPS'ten erişilemez; okuyucu 19.44.09'dan beri `network_wait`, kuyruk/başarısız 0, bekçi müdahalesi 0.
- Canlı kabul açık: ilk gerçek site dönüşü/takılmada bekçinin doğru adımı attığı ve yeni okumalarla toparlandığı henüz görülmedi.


## 1 Kasım 2026 — Gelecek hafta beklemesi

`src/publication-wait.mjs` bağımsız bekçi klasörüne de kopyalanır. Pazar 19.30 sonrası tam gelecek hafta planı, henüz hiç yeni-hafta okuması olmaması ve taze açık tarih uyuşmazlığı birlikteyken `publication_wait`: probe/restart/limit/toparlanma mesajı yok. Saat tek başına yayın veya bekleme kanıtı değildir; servis çöküşü ve bayat/ağ/oturum hatası eski onarım yolunda kalır. Sağlık `waiting_publication` ve gerçek 0/224 gösterir. Takvim aralığı ve okuyucu temposu değiştirilmez. Kanonik kanıt README'nin en üstteki 1 Kasım bölümünde ve özel `.local/weekly-wait-2026-11-01/` içindedir.


## 1 Kasım 2026 — Aynı kesintide limit uyarısı kalıcı olarak tekilleşir

`watchdog.json.limitNotice` geçici episode'dan bağımsızdır; legacy `lastNotice.action=limit` göç edilir. Gönderimden önce atomik rezervasyon yazılır; belirsiz sonuçta tekrar yoktur. Yalnız mevcut planda uyarıdan sonra en az beş farklı tesisin gerçek yeni okuması sonraki gerçek olay için yeniden izin verir. Bekleme/yenileme geçişi veya süreç yeniden açılması korumayı sıfırlamaz. Pozitif yayın beklemesi için aynı plan ve taze gözlemle sınırlı 120 saniye geçiş toleransı vardır; ağ/oturum/servis arızaları bu toleransa girmez. Bağımsız makbuz `.local/watchdog-current-revision.json`; sonraki dağıtım eski bekçi kopyasıyla üzerine yazmamalıdır.

## 12 Kasım 2026 — HTTP404 kaynak uygulama kesintisidir

Mac ve VPS gerçek Payara404 verirken eski probe siteyi açık sayıp gereksiz yeniden başlatma yaptı. Yeni probe yalnız2xx/3xx'i up sayar;403/429 ret yolu korunur,404/410 ve diğer hatalar down olur. Bağımsız bekçi16.12.12 İstanbul'da hash korumalı atomik değişti; servis yeniden başlatılmadı.23 ilgili test geçti. Kalıcı ledger/bütçeler/sınır bildirimi ve gerçek yeni okumayla toparlanma şartı korunur. Makbuz .local/watchdog-current-revision.json; kanonik olay README'nin en üstündedir.
