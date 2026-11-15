# Rezervasyon servisi için sunucu seçimi

28 Ekim 2026, İstanbul. Yeni bütçe 300–400 TL/ay; yalnız rezervasyon okuyucusu ve mevcut Telegram servisi. Satın alma veya hesap oluşturma yapılmadı.

## Aylık teklif

OVHcloud resmî yapılandırıcıda VPS-1 2027, **No commitment**, tek sunucu, **Kanada/Beauharnois** seçeneği **$5,35 vergi hariç/ay**: 2 vCore, 4 GB RAM, 40 GB NVMe, standart günlük yedek. Ek seçenekler seçilmedi. Liste sayfasındaki $4,54 yıllık peşin ödeme indirimidir; aylık fiyat diye sunulmaz. Yapılandırıcıda bu küçük paketin Avrupa konumları mevcut değildi; Erith daha pahalı VPS-2 öneriyor.

Kaynak: https://www.ovhcloud.com/en/vps/ ve bu sayfadaki VPS-1 Configure. Yapılandırıcıda No commitment seçimi ve toplam/ay alanı görsel metinden okundu; ödeme/hesap adımına geçilmedi.

ECB’nin 27 Ekim 2026 referansında EUR/TRY 55,5130, EUR/USD 1,1150; çapraz USD/TRY yaklaşık 49,7874. $5,35 yaklaşık **266,36 TL vergi hariç**. Örnek %20 vergi eklenirse **319,64 TL**; bu verginin son faturada uygulanacağı ve kart kuru kesin doğrulanmadı. Satın almadan önce Türkiye hesap adresi, nihai vergi, yenileme tutarı ve ödeme periyodu görülmeli. Kaynak: https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml .

Hetzner CX23 (4 GB/2 vCPU) + IPv4 €5,99 vergi hariç/ay, aynı EUR kuruyla yaklaşık 333 TL; örnek %20 vergiyle 399 TL ve kart farkı. Ancak resmî cost-optimized sayfasında CX23/CX33 stokta görünmedi; mevcut satın alınabilir teklif diye sunulmuyor. Kaynaklar: https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/ , https://docs.hetzner.com/cloud/servers/overview/ , https://www.hetzner.com/cloud/cost-optimized/ .

## Teknik karar ve açık kabul

Öneri: önce tek sekmeli 0.8.0 Mac kabulü, ardından taahhütsüz 4 GB Linux sunucuda küçük deneme. 4 GB uygun başlangıç tahminidir; gerçek Linux RAM/CPU ölçümü yok. Bir okul hesabı/tek normal tarayıcı oturumu, mevcut Node servisi ve aynı Telegram botu; kullanıcıların cihazında uzantı gerekmez. Kanada ağ gecikmesi ve veri merkezi IP’sinde normal giriş/doğrulama davranışı ayrıca sınanmalı. İnsan doğrulaması veya açık site reddi aşılmaz.

Mac kasası Linux’a kopyalanmaz. Linux özel bilgi dosyası desteği ve dağıtıma özel uzantı kimliği doğrulaması testlidir; gerçek sır dosyası kurulmadı. Site okuyucusunun Linux/Chromium başlatıcısı, servis yönetimi, yedek/geri yükleme ve güncelleme akışı gerçek sunucuda kabul edilmedi. Eski merkezi prototip güncel Settings/tercih/bildirim kodunun yerine dağıtılmaz.

Sunucuda sınanacaklar: tek sekme ve tüm 32 tesiste taze tur; gerçek tur gecikmesi; oturum bitişi → normal giriş; bağlantı/servis/tarayıcı yeniden başlatması; gizli bilgilerin çıktıya düşmemesi; Telegram menü ve gerçek yeni boş yerin teslimi; bellek/disk/günlük sınırı; en az 24 saat süreklilik. Bunlar tamamlanmadan 7/24 sorunsuzluk veya tüm tesisler için 30 saniye bildirim vaadi yok.

## 29 Ekim 2026 — Müdahalesiz doğrulama kabul şartı

Kullanıcının açık şartı: sistem, girişteki insan doğrulaması dahil tekrar eden girişleri kendi başına tamamlamadan VPS satın alma/dağıtım ve genel kullanıma geçiş yapılmayacak. Şart sağlanmazsa projeyi askıya almayı değerlendireceğini söyledi; bu ifade çalışan servisi şimdi durdurma talimatı değildir.

Ana Uğur Chrome profilinde gerçek https://rez.metu.edu.tr/ giriş sayfası tek geçici sekmede incelendi. Bu ziyarette doğrulama widget’ı, Cloudflare iframe’i veya cf-turnstile-response alanı görünmedi. Hesaptan çıkış, parola gönderimi veya CAPTCHA tıklaması yapılmadı. Bu gözlem yalnız bu ziyaret/profil için geçerlidir; veri merkezi IP’sinde zorunlu bir doğrulamayı otomatik tamamlayan çözüm kanıtı değildir. Otomatik checkbox tıklama özelliği bu çalışmada uygulanmadı. Mevcut 0.9.2’nin doğrulama bekleme davranışı değiştirilmedi.

## 29 Ekim 2026 — Ayrı doğrulama denemesi kuruldu; canlı tıklama kabulü açık

Önceki ziyaret notundan sonra `work/rez-dogrulama-deneme` altında 0.1.0 ayrı yardımcı geliştirildi; masaüstü kopyası `REZ-DOGRULAMA-DENEME`. 25 birim testi geçti. Gerçek Chrome yerel testinde bir DOM tıklaması kutuyu işaretledi, ikinci deneme yeniden tıklamadı; olay `isTrusted:false`. Bu yerel sayfada gerçek Cloudflare yoktur. Ana rezervasyon uzantısının 0.9.2 kodu ve servis ayarları değiştirilmedi.

Kullanıcı kurduğunu bildirdi; Uğur Chrome araç çubuğunda yardımcının AÇIK başlığı gözlendi. Gerçek ODTÜ giriş sayfası bir kez yeniden yüklendikten sonra doğrulama yanıtı mevcut, görünür checkbox ve Cloudflare iframe sayısı sıfırdı. Yanıt değeri okunup kayda alınmadı; yalnız var/yok bilgisi kontrol edildi. Yardımcının gerçek kutuyu tıklaması, Cloudflare kabulü ve otomatik giriş devamı kanıtlanmadı. Bu sonuç VPS kabul şartını karşılamaz. Ayrıntılı sınırlı kanıt: `/Users/ugurmetu/Documents/Codex/ODTU-HAYAT-KARIYER-MERKEZI/work/rez-dogrulama-deneme/test-proof.json`. Hesaptan çıkış, parola gönderimi, CAPTCHA tıklaması veya rezervasyon yapılmadı.

## 29 Ekim 2026, 01.00 İstanbul — Gerçek çıkış / otomatik giriş denemesi

Kullanıcı canlı CAPTCHA denemesi için işlem anında onay verdi. Mevcut tek ODTÜ takip sekmesindeki normal Çıkış bağlantısı kullanıldı; giriş ekranı görüldü. Ajan kullanıcı adı veya parola girmeden ana 0.9.2 uzantısı yeniden giriş yaptı; site başlığında kullanıcı oturumu ve 29 Ekim 01.00.17 zamanı gözlendi. 01.00.39 yerel sağlık okumasında okuyucu ready, saat bağlantısı açık, son başarılı takvim verisi 01.00.38, Telegram son yoklaması 01.00.35, bekleyen ve başarısız bildirim sıfırdı. O anda 128 tesis/gün hedefinden 72’si tazeydi; bütün kapsamın tamamlandığı veya 30 saniye gecikme kanıtı değildir.

Bu girişte görünür doğrulama checkbox’ı gözlenmedi. Dolayısıyla normal otomatik giriş ve yeni okumalara dönüş geçti; gerçek kutuyu otomatik tıklama/Cloudflare kabulü ve VPS IP’sinde müdahalesiz çalışma hâlâ açık kabul maddeleridir. Tekrar tekrar çıkış yapıp doğrulama zorlanmadı, ana uzantı/servis kodu değiştirilmedi. Başlangıçtaki eski takip sekmesi Chrome’da 9,0 GB yüksek bellek etiketi gösterdi ve tarayıcı bağlantısı zaman aşımına uğradı; yeniden girişten sonra bu etiket gözlenmedi. Bu bir tarayıcı UI gözlemidir, işletim sistemi bellek ölçümü değildir. Bellek sürekliliği de ayrıca kabul gerektirir. Ayrıntılı sınırlı kanıt work/rez-dogrulama-deneme/test-proof.json ve aynı klasördeki .local/logout-recovery-test-2026-10-29.json.

01.01.39 İstanbul takip okumasında ready sürdü, son başarılı takvim 01.01.38 ve Telegram yoklaması 01.01.35 oldu; taze kapsam 96/128’e yükseldi. Chrome envanterinde yalnız aynı tek rezervasyon sekmesi kaldı.

## 29 Ekim 2026 — Kullanıcı kararı: ana entegrasyon ve OVH denemesi

Kullanıcı, gerçek görünür checkbox kabulü henüz kanıtlanmamışken sınırlı denemeyi ana uzantıya almayı ve OVHcloud üzerinde küçük sunucu denemesine ilerlemeyi açıkça istedi. Önceki "kanıtlanmadan satın alma/dağıtım yok" tercihi bu yeni kararla yerini izlenen pilot geçişine bıraktı; bu, doğrulamanın veya 7/24 sürekliliğin sağlandığı anlamına gelmez. Yarım saat/saat başı Codex kontrolünü sunucu kurulduktan sonra ayrıca kurmayı istedi; erişilecek sunucu henüz olmadığından otomasyon oluşturulmadı.

Ana 0.10.0, yalnız çalışan yönetilen ODTÜ sekmesinde autoLogin/autoManage açık ve bakım/durdurma/başarısız giriş engeli kapalıyken görünür tek kutuya DOM click() dener. Belge başına bütçe Chrome storage.session içinde arka plan işlemi yeniden başlasa da korunur. Yeni host yalnız challenges.cloudflare.com; debugger/cookies/tüm siteler yok. Başarılı widget yanıtı ile giriş ayrı tutulur, yanıt olmadan parola gönderilmez. 186 ilgili test geçti; masaüstü kaynak kopyası hazır. Bu kayıt anında Chrome yenilemesi/gerçek 0.10.0 bildirimi bekleniyor. Ayrı deneme yardımcısının araç çubuğu KAPALI olarak geri okundu.

Kullanıcının 29 Ekim 01.10 ekranında OVH VPS-1 2027: 2 vCore, 4 GB RAM, 40 GB NVMe, 500 Mbps, No commitment, Kanada/Beauharnois, Ubuntu 26.04 ve toplam $5,35/ay. URL'deki pricing=upfront12 eski parametresi, ekranda okunan No commitment seçiminin yerine fiyat kanıtı sayılmaz. OVH resmî VPS sayfası aynı kaynakları ve $4,54 başlangıç fiyatını gösteriyor; başlangıç fiyatı yıllık taahhüt indirimiyle ilgilidir. 28 Ekim 2026 ECB XML: EUR/TRY ÷ EUR/USD ile USD/TRY 49,8380; $5,35 = 266,63 TL vergi hariç. Yalnız örnek %20 vergiyle 319,96 TL; ödeme ekranındaki gerçek vergi, kart kuru, yenileme ve bölgesel hesap uygunluğu henüz doğrulanmadı. Kullanıcının 300–400 TL bütçesi için aylık, taahhütsüz deneme tercih edilir. Sunucu satın alınmadı, hesap veya ödeme yapılmadı.

### Sunucuya geçişin uygulanacak sırası

1. Nihai aylık toplam bütçe içinde görülür; yıllık peşin taahhüt veya ücretli panel eklenmez. Avrupa aynı küçük pakette ve aynı fiyatta mevcutsa gecikme için değerlendirilebilir; stok bu çalışmada kesinleştirilmedi. Linux LTS imajı seçilir.
2. Ayrı, yalnız rezervasyona ait Linux kullanıcı/profil kurulur. Mac'in Chrome profili veya Keychain dosyası kopyalanmaz. Mevcut Linux özel kimlik dosyası desteği kullanılır; sırlar sohbete, GitHub'a veya günlük çıktısına yazılmaz. Yerel API yalnız 127.0.0.1:8765'te kalır; erişim anahtarı ve dağıtıma özgü uzantı kimliği korunur. Yönetim erişimi SSH üzerinden olur.
3. Normal headed Chromium/uzantı ve Node 24 servisi tek okuyucuyla kurulur; koruma aşma/stealth/proxy rotasyonu eklenmez. Süreç yöneticisi beklenmedik süreç çıkışlarını toparlar. Giriş doğrulanmazsa başarılı sayılmaz; sahibine eylem gereği bildirilir. Bu Linux başlatma ve servis kurulumu gerçek sunucuda henüz yapılmadı.
4. Bellek/CPU/disk ve gerçek tur süreleri ölçülür. Mac sekmesinde gözlenen 9,0 GB etiketinden ötürü 4 GB'ın kesin yeteceği söylenemez. Belleğin sürekli artması çözülmeden sadece daha büyük paketle kalıcı olarak maskelenmez. Gerekirse bütçe içinde küçük pilot bırakılır veya durdurulur.
5. Canlı geçişte aynı bot için yalnız bir Telegram getUpdates süreci kalır; Mac ve VPS aynı tokenla paralel poll etmez. Durum/tercih yedeği güvenli taşınır; bekleyen bildirimler körlemesine yeniden gönderilmez. Sunucu okuması ve bot menüsü kabul edilince Mac okuyucusu kapatılır; geri dönüş kopyası tutulur.
6. İlk 24 saatlik Linux pilotunda yeniden giriş, gerekirse gerçek doğrulama, tek sekme, yeni hafta, 32 tesis kapsamı, gerçek yeni yer/dolma bildirimi ve kaynak kullanımı ayrı kabul edilir. Bütün tesis/telefon için mutlak 30 saniye veya 7/24 sorunsuzluk sözü yok.
7. Sunucu erişimi hazır olunca kullanıcıyla seçilecek 30/60 dakikalık Codex otomasyonu salt okunur sağlık, süreç, tazelik, Telegram yoklaması ve kaynak özetini denetler. Değişmeyen durumda sessiz kalır; anlamlı bozulma veya kullanıcı eylemi gerektiğinde haber verir. Bu kontrol, sistemin kendi süreç yönetiminin yerine geçmez ve ek ODTÜ sorgusu üretmez.

Kaynaklar: https://www.ovhcloud.com/en/vps/ ; https://www.ovhcloud.com/en/vps/configurator/?planCode=vps-2027-model1 ; https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml .

OVH resmî herkese açık US sipariş kataloğu bu tur HTTP ile doğrulandı: vps-2027-model1 / default / interval=1 month / Monthly fees / formattedPrice=$5.35 USD / tax=0 katalog satırı. Bu katalog tax=0 değeri kullanıcının Türkiye ödeme vergisinin sıfır olduğuna kanıt değildir. Kaynak: https://api.us.ovhcloud.com/1.0/order/catalog/public/vps?ovhSubsidiary=US . 29 Ekim 01.21 yerel sağlık okumasında canlı sürüm hâlâ 0.9.2, ready ve 128/128 taze; 0.10.0 etkinleştirme bekleniyor.

## 29 Ekim 2026, 01.24 İstanbul — 0.10.0 canlı etkinleşti

Kullanıcı ana uzantı kartını yenileyip yeni host iznini onayladığını bildirdi. Yerel sağlık uç noktasına gelen gerçek okuyucu yetenek sürümü 0.10.0, okuyucu ready, yerel saat bağlı, 128/128 takvim taze ve son gözlem 01.24.10. Telegram son yoklaması 01.24.06; bekleyen, gönderilmekte, sonucu belirsiz ve başarısız teslim sıfır. Son tek gözlem empty_unconfirmed olduğundan o yanıt müsaitlik teyidi sayılmadı. Ana entegrasyon etkin; gerçek görünür checkbox tıklaması ve Cloudflare kabulü hâlâ gözlenmedi. Yeni çıkış veya CAPTCHA testi tetiklenmedi, sunucu satın alınmadı/kurulmadı. Sınırlı dağıtım kanıtı .local/verification-0100-deployment.json.

## 29 Ekim 01.55–01.59 — OVH sipariş durumu

Kullanıcının onay ekranı ve doğrulama e-postası siparişin doğrulandığını gösteriyor. OVH Virtual private servers listesi bu kontrolde No results found; hizmet henüz teslim edilmiş görünmedi. Sipariş kimliği/ödeme/hesap/bağlantı bilgileri bu paylaşılabilir kayda kopyalanmadı. Sunucu kurulumu/SSH ve zamanlanmış izleme başlamadı. 4 GB pilotundan önce 0.10.1 bellek yamasının canlı ölçümü bekleniyor; somut FullCalendar tutulma yolu giderildi, kesin Linux RAM yeterliliği iddiası yok.


## 29 Ekim 2026 — VPS teslim edildi; ilk SSH erişimi kullanıcı adımında

Ana Gmail hesabındaki OVH “Install of your VPS” ve “Automated backup activated” mesajları salt okunur doğrulandı. İşletim sistemi Ubuntu 24.04; önceki yapılandırıcıdaki 26.04 görüntüsünden farklıdır. Sunucunun SSH hizmeti yanıt veriyor, ancak Mac'teki iki mevcut anahtar ubuntu hesabında reddedildi. Parola denenmedi, sunucuda kurulum yapılmadı; Mac okuyucusu ve bot çalışmayı sürdürüyor.

Kaynak 0.10.1 için sır/durum içermeyen 41 dosyalı, SHA-256 listeli kaynak paketi `.local/vps-releases/` altında hazırlandı; gerçek local-config, .local, node_modules, token/kimlik/durum dosyalarının arşive girmediği doğrulandı. Üretim kaynakları değiştirilmedi. `ops/vps/README.md` geçiş sırasıdır; paketlenmiş olması dağıtım yapıldığı anlamına gelmez.

İlk parola oluşturma kullanıcıya bırakıldı (bilgisayar kullanım kuralı); doğru OVH teslim e-postası ana Chrome hesabında açıldı. Masaüstünde kullanıcı tarafından çalıştırılmak üzere `OVH-ILK-BAGLANTI.command` hazırlandı ve zsh sözdizimi kontrolü geçti. Kullanıcının Terminal'de görünmeden gireceği mevcut VPS parolasıyla yalnız Mac'in genel SSH anahtarını kendi VPS ubuntu hesabına idempotent ekler; özel anahtar/parola ortak kayda yazılmaz. Dosya Codex tarafından çalıştırılmadı. İlk erişim tamamlanınca salt okunur sunucu envanteri, tek süreçli kontrollü geçiş ve gerçek Linux bellek/tur kabulü yapılacak. Aynı bot Mac/VPS'te paralel poll edilmeyecek.

29 Ekim — VPS devri gerçekleşti; Mac durduruldu, ilk sunucu girişi insan doğrulamasında. Henüz yeni Linux tesis okuması yok. Kaynak/kanıt ve açık kabul: ops/vps/DEPLOYMENT-2026-10-29.md.
