# İlk VPS erişimi ve kontrollü geçiş

29 Ekim 2026. OVH teslim e-postasında Ubuntu 24.04 doğrulandı; otomatik yedek etkin. Sunucuya başarılı SSH erişimi henüz yok. Mevcut iki Mac anahtarı normal `ubuntu` hesabında reddedildi; parola denenmedi. Kaynak/ana uzantı 0.10.1, Mac servisi etkin. Bu klasör sunucuda kurulum yapıldığı anlamına gelmez.

İlk erişim için kullanıcı OVH'nin teslim e-postasından ilk parolasını kendi oluşturur. Masaüstündeki `OVH-ILK-BAGLANTI.command` kullanıcı tarafından çalıştırılır: parola Terminal'de görünmeden sorulur, yalnız mevcut genel SSH anahtarı kendi VPS'indeki ubuntu hesabına eklenir. Özel anahtar/parola sohbete veya proje belgelerine yazılmaz. Sunucu adresi ve erişim dosyaları ortak özetlere taşınmaz.

Erişimden sonra önce işletim sistemi, RAM/disk, mevcut servisler, kullanıcılar ve kurulu yazılım salt okunur incelenir. Başka ajan kurulumu varsa üzerine körlemesine yazılmaz. Yeni servis ve tarayıcı ayrı, yetkisiz kullanıcıyla çalışacak; yerel API yalnız loopback'e bağlı kalacak. Tarayıcı sandbox'ı kapatılmayacak, uzak yönetim portu internete açılmayacak.

`node ops/vps/build-release.mjs` sürüm ve SHA-256 listeli, sır içermeyen kaynak paketi üretir. Üretim `.local/`, gerçek `local-config.json`, Mac kasası, token, kimlik bilgisi, sohbet ve durum dosyaları pakete girmez. Durum/sırlar ancak şifreli SSH bağlantısı kurulduktan sonra ayrı, kapalı izinli aktarımda ele alınır. Mac kasası Linux'a kopyalanmaz; desteklenen Linux özel bilgi dosyası kullanılır.

Sunucu önce Telegram poll etmeden, siteye ek tarama başlatmadan hazırlanır. Canlı geçişte tek bot yoklaması ve tek site okuyucusu korunur; kesim anında Mac durdurulur, son durum yedeği alınır ve sunucu başlatılır. Geri dönüş kopyası tutulur. Geçiş kabulü: 32 tesis/tek sekme, gerçek tur süresi, RAM eğrisi, normal oturum yenileme, Telegram teslimi, yeniden başlatma ve 24 saat süreklilik. Görünür insan doğrulaması veya site reddi ayrıca ele alınır; mevcut deneysel doğrulama kesin kabul sayılmaz.

## İlk girişte zorunlu parola değişimi

Kullanıcının gerçek Terminal çıktısı, OVH geçici parolasının ilk girişte değiştirilmesi gerektiğini gösterdi. İlk yardımcı stdin üzerinden genel anahtar gönderdiği için uzak TTY yoktu ve parola değişimi başlayamadı; SSH anahtarı henüz eklenmedi. Masaüstü yardımcısı `ssh -tt` ve Terminal stdin ile düzeltildi; yalnız doğrulanmış genel anahtar uzak komuta yerleştirilir, parola kaydedilmez. Yerel zsh ve üretilen uzak sh sözdizimi kontrolleri geçti. Kullanıcı geçici → yeni → yeni tekrar adımlarını kendisi yapar; zorunlu değişim bağlantıyı kapatırsa dosyayı yeni parolayla tekrar açar. Başarı yazısı yalnız BatchMode anahtar bağlantısı gerçekten geçerse gösterilir. Codex parola girmedi/değiştirmedi ve sunucuda kurulum yapmadı.

29 Ekim — VPS devri gerçekleşti; Mac durduruldu, ilk sunucu girişi insan doğrulamasında. Henüz yeni Linux tesis okuması yok. Kaynak/kanıt ve açık kabul: ops/vps/DEPLOYMENT-2026-10-29.md.
