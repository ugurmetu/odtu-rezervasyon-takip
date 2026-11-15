# Codex kontrolünden özel yönetici bildirimi

30 Ekim 2026: Kullanıcı, bu sohbeti göremeyebileceği için yeni sorunların ODTÜ Rezervasyon Yönetim botundan da kendisine gönderilmesine açıkça izin verdi. Bu izin kısa sağlık kontrolü (31 Ekim'den itibaren 10 dakikada bir) ve 04.00 kapsamlı denetim için geçerlidir. Sağlıklı/değişmeyen durumda mesaj yoktur. Önceden bildirilen sorunun toparlanması bir kez iletilebilir.

`node ops/vps/notify-operator.mjs --check` yalnız kanal kimliğini doğrular, mesaj göndermez. 30 Ekim'de gerçek ayrı bot ve özel sahip sohbeti bu yolla doğrulandı. Yeni gönderici ve mevcut alıcı sınırı için 13 ağsız test geçti; kullanıcıya test mesajı gönderilmedi.

Gerçek yeni sorun/toparlanma için `node ops/vps/notify-operator.mjs` komutuna standart girdiden JSON ver:

```json
{"key":"reader_unavailable","state":"problem","message":"Takvim güncellenmiyor; kontrol sırasında 96 kaydın yalnız 40'ı günceldi. Bu mesaj otomatik sağlık kontrolünden geldi."}
```

Bu yalnız format örneğidir; gerçek arıza yokken gönderme. `state` yalnız `problem` veya `recovered` olabilir. Metni kısa, Türkçe, sır/kimlik/bağlantı ayrıntısı içermeyen somut durum ve etkiyle yaz. API kabulünü telefonda okunma sayma. Kullanıcıdan sunucu Chrome/parola/CAPTCHA işlemi isteme.

İki kontrol aynı sorun için aynı `key` kullanır: `service_unavailable`, `reader_unavailable`, `telegram_polling`, `delivery_failures`, `memory_guard`, `operator_channel`, `ssh_access`, `nightly_regression`, `source_integrity`, `disk_resource`, `permissions_backups`. Aynı sorunu saat damgası/PID/sürüm ekleyerek yeni anahtara dönüştürme. Gerçek toparlanmada aynı anahtarla `recovered` çağır. Arıza kaydı yoksa toparlanma mesajı üretilmez. Tek SSH erişim hatasını site arızası diye bildirme; önceki karşılaştırma ve kalıcılığa göre karar ver.

Gönderici anahtar/alıcı/URL argümanı almaz. Mevcut özel `.local/telegram-token` (yalnız kimlik karşılaştırması), `.local/telegram-legacy-token` (ayrı yönetici botu), `.local/owner-chat-id` dosyalarını okur; açık izinli dosyayı reddeder. Mevcut `configureOperatorChannel` ile farklı bot ve sabit özel sahip doğrulanır; `isOperatorChannel` dışında gönderici kabul edilmez. Kullanıcı botuna fallback veya polling yoktur. VPS/SSH erişilemiyorsa da Mac'teki özel doğrulanmış dosyalarla çalışabilir. Bu dosyalar okunamıyor/yanlışsa yalnız Codex sohbetinden haber ver; tahminle yeni hesap/alıcı seçme.

`.local/operator-monitor-notices.json` iki denetim için ortak tekrar önleme kaydıdır; mesaj içeriği/kimlik/sır içermez, 0600 izinlidir. Aynı açık sorun bir kere, toparlanma bir kere gönderilir. Yeniden ortaya çıkarsa yeni olay sayılır. Eşzamanlı gönderim kilitlidir. Ağ sonucu belirsizse otomatik yeniden gönderilmez; kesin reddedilen istek en erken bir saat sonra yeniden denenebilir. `accepted` API kabulüdür; `duplicate_suppressed` / `no_open_problem` yeni mesaj gerekmediğidir. `busy` / `uncertain` / `rejected` / doğrulama hatasında ana bota dönme, hata metnine sır ekleme ve Telegram teslimini başarılı gösterme. Kilit önceki çökmüş süreçten kaldıysa süreci kontrol etmeden körlemesine silme.

Bu yardımcı yalnız yerel Codex bildirim yoludur; VPS üretim kaynakları, bot/Chrome/uzantı, mevcut sunucu tarafı yönetici uyarıları ve kontrol aralıkları değiştirilmedi. Kullanıcı sağlıklı durumda sessizlik istediği için bağlantı testi olarak gerçek mesaj gönderilmez.

## 31 Ekim 2026 — Arızayı eklenti sohbetine devret

Kullanıcı, bu izlemelerde bulunan yeni anlamlı arızaların çözüm için doğrudan eklenti sohbetine gönderilmesine açıkça izin verdi. Doğrulanmış hedef `local` host üzerinde `01a0d042-e8cc-7771-b9b4-fced04d8b4a9`; araçtaki güncel başlığı `odtü eklenti` (kullanıcının ekranında `eklenti`). `send_message_to_thread` ile olay anahtarı, İstanbul zamanı, kullanıcı etkisi, kısa sağlık kanıtı ve ilgili proje yolu gönderilir; aşağıdaki açık onarım yetkisiyle sorunu inceleyip çözmesi istenir. Sır, SSH ayrıntısı, token, özel kullanıcı mesajı veya alıcı kimliği eklenmez. Mevcut Telegram bildirimleri korunur.

İki otomasyon ortak `.local/monitor-thread-handoffs.json` kaydını kullanır (0600). Aynı açık olay bir kez devredilir; devralan sohbet çalışırken tekrarlı çözüm isteği gönderilmez. Gerçek toparlanmada kaydı recovered yap; aynı anahtarın daha sonra yeniden bozulması yeni olaydır. Göndermeden önce kaydı ve hedef sohbetin son durumunu oku; belirsiz gönderimi başarılı sayma veya körlemesine tekrarlama. Yönlendirme aracı yoksa bu bakım sohbetinde belirt. Sağlıklı/değişmeyen durumda yönlendirme yoktur.

31 Ekim 20.12 civarındaki `reader_unavailable` olayını kullanıcı zaten bu hedef sohbete kendisi gönderdi; ekran görüntüsüyle doğrulandı. Bu mevcut olayı yeniden gönderme. Sonraki yeni olaylar yukarıdaki yoldan otomatik devredilir.

## 31 Ekim 2026 — İki sohbet için tam arıza onarım yetkisi

Kullanıcı bu bakım sohbetine ve yukarıdaki eklenti sohbetine, ODTÜ Rezervasyon sistemindeki arızaları ek onay beklemeden düzeltmek için açık tam yetki verdi. Arıza doğrulandığında gerekli teşhis, kaynak/yapılandırma düzeltmesi, test, dağıtım, geri alma, servis/Chrome/uzantı/oturum ve doğrulama işlemleri yetkilidir. Önceki salt okunur sınırı yalnız rutin kontrol için sürer; onarım engeli olarak kullanılmaz. Ayrıntılı kalıcı kural proje `AGENTS.md` dosyasındadır.

Önce aktif onarımı yapan sohbeti belirle; iki sohbet aynı üretime paralel müdahale etmez. Mevcut kaynak/devir kayıtlarını oku, verileri ve sırları koru, ilgili kontrolleri tamamla. Gerçek yeni tesis okumaları ve kapsam doğrulanmadan, bellek sorunu varsa ayrıca gerçek bellek düşüşü görülmeden toparlanma bildirme. Ana kullanıcı botundan teknik/test mesajı, kullanıcı adına rezervasyon ve gerçek yük testi yetkisi bu karara dahil değildir. Kısa kontrol 10 dakikada bir; günlük kapsamlı denetim İstanbul 04.00'te kalır.

## 31 Ekim 2026 — Mac masaüstü bildirim filtresi

Kullanıcı bu izlemeler için sağ üst masaüstü bildirimi istemiyor; diğer normal sohbet bildirimleri açık kalır. İki otomasyonda `notification_policy=failed_runs_only` kayıtlıdır. Buna rağmen eski `/Users/ugurmetu/.codex/notify-macos.sh` dış bildirim kancası her yanıtı doğrudan macOS bildirimi yapıyordu. Betik düzeltildi: tüm `DONT_NOTIFY` heartbeat yanıtları ve bu iki rezervasyon otomasyonunun heartbeat yanıtları, macOS bildirim çağrısından önce elenir. Normal sohbetler ve diğer otomasyonların anlamlı `NOTIFY` yanıtları korunur. Telegram yönetici uyarıları ve eklenti sohbetine devir değişmez. 9 ayrıştırma senaryosu ve gerçek betiğin sessiz yanıtla bildirim çağrısına ulaşmadan çıkması doğrulandı; test bildirimi gönderilmedi. Codex yapılandırmasındaki bilgisayar-kullanımı sarmalayıcısı değiştirilmedi.
