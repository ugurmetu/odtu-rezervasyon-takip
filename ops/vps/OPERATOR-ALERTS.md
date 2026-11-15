# Kullanıcı ve yönetici bildirimleri

29 Ekim kullanıcı isteğiyle teknik uyarılar ortak botun sohbetinden çıkarıldı. Önceki kod yalnız sahibine gönderiyordu; başka kullanıcıların aldığı iddia edilmez.

Kullanıcı botu normal seans bildirimleri, tercihler, yeni hafta duyurusu ve menüler içindir. Sahibine de teknik uyarı göndermez. Ayrı bot kimliği getMe ile ana bottan farklı; getChat ile tek sahip alıcısının özel sohbet olduğu doğrulanır. src/operator-alerts.mjs alıcıyı sabitler ve ham API/anahtarı dışarı vermez. src/coverage.mjs düz kullanıcı-botu göndericisini reddeder. Yöneticinin kullanıcı botuna abone olması şart değildir.

REZ_OPERATOR_BOT_TOKEN_FILE özel yönetici anahtarının yoludur. Aynı bot/anahtar, grup/yanlış alıcı veya doğrulama hatasında kanal kurulmaz; ortak bota geri dönüş yoktur. Kayıtlar ve Codex izleme yolu kullanılır. Sırlar ve kimlik yalnız özel dizinde kalır.

Eski pilot bot ODTÜ Rezervasyon Yönetim adıyla yeniden kullanıldı; yeni hesap/anahtar oluşturulmadı. Sahip /start ile yönetici açıklamasını; diğer eski-link kullanıcıları yeni kullanıcı botunu görür. Toplu mesaj gönderilmedi. Mevcut bir saatlik başarılı uyarı bütçesi ve aynı arızanın tekilleştirmesi korundu. Kısa polling/teslim aksaklıkları hâlâ yalnız loglarda. Yönetici gönderim hatası kullanıcı botunun sağlık hatası olarak kaydedilmez. Kullanıcıdan merkezi sunucunun doğrulaması, kasası veya Chrome'u için işlem yapması istenmez; güncel veri yoksa sade durum gösterilir.

66 ilgili test geçti: üç teknik sağlık yolunda ve döngüde ana botun reddi, yanlış alıcı/aynı bot/grup/ağ hatasında fallback olmaması, abonelikten bağımsız özel sahip kanalı, TR/EN, menü, eski-link yönlendirmesi, normal müsaitlik mesajları ve API/bellek regresyonları dahil. Gerçek yönetici kanalına bir açıkça etiketli bağlantı testi gönderildi; sonucun doğru ayrı bot ve özel sahip sohbeti olduğu doğrulandı. Telefonda okunma kanıtı değildir. Özel makbuz sunucunun operator-channel-test.json dosyasındadır.

Dağıtım yalnız backend: Node kaynakları yeni release'e alındı. Aynı kalan extension dizini önceki 0.10.4 release'inden paylaşılır; Chrome yeniden başlatılmadı. Bu eski extension dizini canlı bağımlılıktır, temizlikte silinmez. Tam uzantı dağıtımında ayrıca ele alınır. Güncel release/bağımlılık özel .local/vps-current-release.json kaydındadır. Tercihler, ofsetler ve kuyruk korunur.


## 30 Ekim 2026 — Codex kontrollerinden yönetici Telegram bildirimi izni

Kullanıcı bu bakım sohbetini göremeyebileceği için yeni sorunların ODTÜ Rezervasyon Yönetim botundan da kendisine gönderilmesini açıkça istedi. 30 dakikalık sağlık ve her gün 04.00 kapsamlı denetim promptları bu yetkiyle güncellendi; aralıklar, ACTIVE ve aynı sohbet hedefi geri okundu. Sağlıklı/değişmeyen durumda sessizlik, aynı arızanın tekilleştirilmesi ve gerçek toparlanmada tek bildirim korunur.

Yerel ops/vps/notify-operator.mjs mevcut ayrı bot ve sabit özel sahip kanalıyla gönderir; ana kullanıcı botuna fallback veya poller yoktur. Gerçek kimlik/özel alıcı --check ile mesaj göndermeden doğrulandı; 13 ağsız alıcı/tekrar/eşzamanlılık/belirsiz teslim testi geçti. Ortak özel tekrar kaydı .local/operator-monitor-notices.json; ayrıntı ops/vps/MONITOR-NOTIFICATIONS.md. Şu an arıza olmadığı için gerçek test mesajı gönderilmedi. VPS/Chrome/uzantı/üretim kaynakları yeniden dağıtılmadı veya başlatılmadı. Mevcut sunucu tarafı yönetici bildirimleri sürer.
