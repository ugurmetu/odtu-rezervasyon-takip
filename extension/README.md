# ODTÜ Rezervasyon Takip uzantısı — 0.10.0

29 Ekim 2026: ayrı doğrulama denemesi ana uzantıya alındı. Yalnız çalışan okuyucunun yönetilen sekmesinde, otomatik giriş açıkken, ODTÜ girişinin içindeki Cloudflare çerçevesinde görünür ve adı tanınan tek insan doğrulama kutusuna DOM tıklaması denenir. Durdur, bakım, giriş engeli ve otomatik girişin kapalı olması bu denemeyi de durdurur. Ana sayfa belgesi başına bir deneme bütçesi arka plan işlemi yeniden açılsa da korunur. Gözlemciler durdurulunca veya denemeden sonra kapatılır. Yeni host izni yalnız `https://challenges.cloudflare.com/*` içindir; tüm siteler, debugger veya cookies izni eklenmez.

Programatik tıklama gerçek insan girdisi sayılmaz (`isTrusted:false`) ve Cloudflare kabulü garanti değildir. Yanıt oluşması ile gerçek giriş ayrı izlenir; yanıt gelmeden parola gönderilmez. Gizli yanıt/çerez/parola kaydedilmez; sonuç yalnız yerelde zaman ve sabit durum kodudur. 29 Ekim canlı çıkış denemesinde ana 0.9.2 yeniden giriş yapıp okumaya döndü, fakat görünür kutu gözlenmedi. 0.10.0 dosyası, etkin Chrome sürümü veya VPS kabulü anlamına gelmez. Yeni sürüm yüklenirken ayrı `Rez Doğrulama Denemesi` kapatılmalıdır; çift yardımcı kullanılmaz.

Bu Manifest V3 uzantısı ile Mac’teki yerel servis tek ortak okuyucudur. Telegram kullanıcılarının aynı tesise ait tercihleri aynı güncel gözlemden beslenir; her kullanıcı için ayrı ODTÜ sorgusu açılmaz. Ders kontenjanı uzantısından bağımsızdır. Rezervasyon oluşturmaz veya iptal etmez.

## Kapsam ve katalog

Servis, gerçek çalışan uzantının `maxFacilities: 200`, `catalogDiscovery: true`, `singleTab: true` yeteneklerini bildirmesinden sonra resmî katalogdaki etkin tesisleri ortak plana alır. Dosya sürümü, Chrome’da çalışan sürümün kanıtı değildir. Eski okuyucular kendi kapasiteleriyle sınırlı kalır.

Uzantı resmî tesis listesini beş dakikada bir aynı oturumun normal HTML yanıtından yeniden okur. HTML betikleri çalıştırılmaz, takvim sayfası yeniden yüklenmez ve görünüm değiştirilmez. Olağan metadata isteği başarısızlığı kataloğu erteleyip takvim okumalarına yol verir. 403/429/abuse veya girişe dönüş ayrıca işlenir. Sayfa birim seçimi sunarsa normal seçim alanıyla bu birimleri dolaşır. Yeni tesisler/birimler yerel kataloğa, ardından Telegram menüsüne geçer. Boş, girişe yönlenen veya doğrulanamayan liste kataloğu silmez. Yeni havuz tesisinin gerçekten görünmesi canlıda henüz gözlenmedi; bu geçiş sentetik testlerle doğrulandı. Site yapısı değişirse uyumluluk düzeltmesi gerekebilir.

İstanbul takviminde bugünden pazara kadar olan günler izlenir. Pazar 21.00 sonrasında gelecek pazartesi–pazar seçilir. Seans saatleri doğrulanmış güncel yanıttan öğrenilir; bilinmeyen boş yer sayısı veya saat üretilmez. Kişinin seçtiği belirli saat başka bir saate sessizce taşınmaz.

## Okuma ve hız sınırları

Bütün tesisler tek yönetilen arka plan sekmesini sırayla kullanır. 0.9.0'dan beri her tesis tek bir sayfa çağrısında okunur (`main.js` içindeki `rezMainPage`, `mode:'read'`): birim/tesis seçimi, hafta görünümü ve tarih ayarı yapılır, ardından takvim yakalanır. Tesis değişimi isteğinin başarılı JSF yanıtı ayrıca doğrulanır; hata, yönlendirme veya oturum kapanması varsa takvim okunmaz. Böylece sunucunun eski tesiste kalıp sayfanın yeni tesisi göstermesi yüzünden yanlış tesise veri yazılamaz. Seçimin tetiklediği takvim yanıtı doğrulanmışsa ikinci istek atılmaz; yoksa tek normal yenileme yapılır. Biten okuma, saat tikini beklemeden sıradakini başlatır. Sekme kapanırsa yalnız bir tane açılır. Katalog keşfi ve giriş toparlama da bu sekmeyi paylaşır.

Uygulamanın kendi bütçesi (site sınırı değildir): site işlemleri arasında en az bir saniye, kayan dakikada en fazla 64 işlem. Telegram'da takip edilen tesisler önce ve 25 saniyede bir, diğerleri en sık 30 saniyede bir okunur. Sayfanın yaptığı her gerçek işlem zamanıyla birlikte ortak bütçeye yazılır; çok işlemli bir okuma için dakikalık sınırda yer ayrılır. Okuma istatistikleri (işlem/istek sayısı, seçimin doğrulanması, süre) servisin `/health` yanıtında `readerStats` altında görünür.

Aynı sekme art arda 8 hatada ve en az 45 saniye boyunca okunamazsa (Chrome hata sayfası, bozuk görünüm, askıda kalan çağrı) aynı sekme bütçe içinde bir kez yenilenir; tekrarında bekleme 2 dakikadan 15 dakikaya kadar artar. Giriş sayfası, insan doğrulaması ve site engeli bu yenilemeyi tetiklemez. Tam sayfa Cloudflare doğrulaması "insan doğrulaması bekleniyor" olarak bildirilir.

Yerel WebSocket saati yeni okuyucuyu saniyede bir uyandırır. Bu, saniyede bir site sorgusu demek değildir; eşzamanlılık, tesis aralığı ve ortak bütçe ayrıca denetlenir. Mac uykusu, ağ/site/Telegram gecikmesi ve kaynak sınırlaması nedeniyle tüm tesislerde veya telefona teslimde mutlak 30 saniye garantisi yoktur. Gerçek hız kabulü için proje README’sindeki canlı ölçüm esas alınır.

`main.js`, sayfanın kendi PrimeFaces Schedule yenilemesini çağırır. Yalnız aynı çağrıya ait başarılı ve beklenen JSF yanıtı, tesis/görünüm/tarih eşleşmesiyle kabul edilir. Eski ekrandaki kartlar taze yanıt gibi kullanılmaz. `content.js` doğrulanmış seansları ayrıştırır; beklenmeyen veya bozuk yanıt müsaitlik sayılmaz. Her okumanın kimliği tekildir. Durdur, devam eden sonuçları geçersiz kılar ve bekleyen yerel gönderimleri iptal etmeye çalışır; servisin zaten kabul ettiği POST geri alınamaz.

403/429 veya bilinen erişim engeli tüm yeni okumaları ve katalog keşfini durdurur; başka yolla aşılmaz. Giriş ekranı, ağ hatası veya listeden kaybolma kesin dolma sayılmaz.

## Oturum ve yerel bilgiler

`autoLogin` açıksa normal oturum bitişi, mevcut Mac kasası üzerinden yeniden girişle toparlanır. Hazırlık/giriş işlemleri aynı tek sekmede ortak sıradadır; parola paralel gönderilmez. Yanlış parola, kilitli kasa ve eksik bilgi durumlarında giriş bekletilir. İnsan doğrulamasında yukarıdaki sınırlı tek tıklama denemesi vardır; başarısızsa kullanıcı müdahalesi hâlâ gerekebilir. 29 Ekim gerçek çıkış testinde elle bilgi yazılmadan yeniden giriş ve yeni okumalar görüldü; bütün süreklilik durumlarının doğrulandığı anlamına gelmez.

`local-config.json` içindeki anahtar yalnız uzantı ile `127.0.0.1:8765` servisi arasındadır; hesap parolası değildir. Anahtarlar ve özel çalışma dosyaları dışa aktarma paketine alınmaz. İzinler rezervasyon alan adı, yerel servis, Cloudflare doğrulama çerçevesi ve alarms/storage/scripting kapsamındadır.

Kaynak dosyalarını Masaüstündeki `REZ-PILOT-EKLENTI` klasörüne kopyalamak çalışan Chrome kodunu yenilemez. Yalnız bu uzantının kartındaki küçük dairesel yenile düğmesi kullanılır; üstteki genel Güncelle düğmesi başka eski paketlenmemiş uzantılar yüzünden hata verebilir. Chrome’da etkinleşme, servise gelen gerçek sürüm/yetenek bildirimiyle doğrulanır.

Servis ve okuyucu hâlâ bu Mac’te çalışır. Kullanıcıların bilgisayarına uzantı kurması gerekmez; Mac/Chrome kapalı veya uykudayken güncel bildirim üretilemez. Bağımsız 7/24 sunucu kabulü ayrıca gerekir.

## Bakım geçişi

0.8.0 dosyaları hazırlanırken `maintenance:true`, `autoManage:false` ve boş `watchFacilities` korunur. Gerçek çalışan uzantının 0.8.0/singleTab mesajı gelmeden hedefler geri yüklenmez. Kart yenilemesinden sonraki bakım el sıkışması planı silmez. Doğrulanmış sürümden sonra bakım kaldırıldığında yalnız bakım kaynaklı durma otomatik devam eder; kullanıcının Durdur’u veya açık site reddi otomatik kaldırılmaz. Kullanıcı kartı yeniledikten sonra gerçek 0.8.0/singleTab mesajı alındı, plan açıldı. 28 Ekim 16.15–16.19 İstanbul ölçümünde 32 tesisin hepsi iki tur okundu; tekrar aralığı yaklaşık 129–142 saniye. 24 saat süreklilik, gerçek oturum bitişi ve Linux dağıtımı ayrı kabul gerektirir.

0.8.1, 0.8.0’da canlıda görülen periyodik tam sayfa yenileme beklemesini kaldırır. Arka planda 16.38.10 İstanbul katalog yenilemesinden sonra normal takvim okumaları sürdü; 287 ilgili test geçti. 16.38.10 İstanbul katalog yenilemesinden sonra 32 tesisin tamamı tekrar okundu; 160 tesis/gün güncel kaldı. 0.8.1 ölçümünde tesis tekrar aralığı 129,225–145,461 saniye, örneklem ortalaması 137,97 saniye. Sekme öne getirilmedi; tanı hatası yok. Bu kısa gözlem 24 saat/7/24 veya 30 saniye kabulü değildir. Güncel ölçüm proje README’sindedir.
