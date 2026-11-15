# VPS bellek koruması — 0.10.4

0.10.1 eski FullCalendar nesnelerinin form yenilemesinde tutulduğu somut bir yolu temizler. Bu düzeltme, bütün olası bellek artışlarının veya gece boyu kararlılığın kanıtı değildir. Linux koruması bunun üstüne eklenir; Mac okuyucusu şu anda durdurulmuştur.

- Node servisi her 60 saniye yalnız Chrome'un kendi Linux cgroup belleğini okur. Ek ODTÜ veya Telegram sorgusu yoktur. Toplam kullanım en az 1200 MiB ve anon+shmem en az 900 MiB olduğunda iki ardışık yüksek örnek gerekir; dosya önbelleği tek başına tetiklemez.
- Okuyucu gerçekten güncel/ready, tek sekmeli, otomatik yönetimde ve koruma yeteneğini bildirmişse atomik yerel yapılandırmaya tek yenileme isteği yazılır. Sırlar, yeni tarih planı ve kullanıcı seçimleri korunur.
- Uzantı seri okumanın arasındaki güvenli sınırda, normal site işlem bütçesini kullanarak yeni yönetilen sekmeyi oluşturur; kimliğini kaydeder ve ardından eski kendi sekmesini kapatır. Aynı Chrome profili/oturumu kullanılır; zorla çıkış yapılmaz. Kişisel sekmelere dokunmaz. Açılışı tamamlanmamış ama kimliği kayıtlı sekme ayrıca bulunur; yinelenen sekme açılmaz.
- Manuel durdurma, bakım, giriş/doğrulama, açık site reddi veya hız sınırı yenilemeyle zorlanmaz. İstek 5 dakikada eskir, denemeler arasında en az 15 dakika ve 6 saatte en fazla 3 deneme vardır. Yerel kabul kaydı yeni başarılı takvim okuması ve azalan bellek olmadan toparlandı sayılmaz. Başarısızlık/timeout sınırları saatlik izlemeye çıkar.
- Önceki `MemoryHigh=1500M`, `MemoryMax=2200M` ve systemd yeniden başlatma son güvenlik katmanı olarak kalır. Sert sınır/OOM toparlanmasının 24 saat kabulü yapılmadı. Bütün tarayıcının yeniden başlaması gerektiğinde `--restore-last-session` kullanılır; bu, süresi dolmuş ODTÜ oturumunun veya CAPTCHA'nın kendiliğinden geçeceğinin garantisi değildir.
- `REZ_BROWSER_MEMORY_GUARD=1` yalnız VPS ortamında etkindir. `memory-guard.json` ve en fazla iki yaklaşık 1 MiB `memory-history.ndjson` dosyası özel dizindedir; kimlik, sohbet, parola veya token geçmişe yazılmaz. Codex/app kapalıyken de örnekleme ve koruma çalışır. Saatlik Codex kontrolü yalnız bu kanıtı okur; kendisi yerel Mac/app koşullarına bağlıdır.

## Sürüm yükleme ve ortak çalışma

0.10.2 dosyaları yüklense de canlı yetenek `memoryGuard:false` kaldı. 0.10.3'ün ayrı `worker-0.10.3.js` girişiyle gerçek `memoryGuard:true` görüldü. 0.10.4 ayrıca işçi yeniden başladıktan sonra eski isteğin 5 dakika süresini aşarak yürütülmesini engeller. Sonraki sürümde `worker-<manifest version>.js` girişini üretip manifestte işaretle; son satırı `importScripts("background.js");` olmalıdır. Yayın betiği uyuşmazlığı reddeder. Yalnız dosya sürümünü okumak etkin kod kanıtı değildir.

130 ilgili test geçti: kalıcı eşik/cooldown/sınır, manuel durdurma, doğrulama/site reddinde durma, seri okuma sınırı, yeni sekmeyi önce saklama, yüklenen sekmeyi yeniden bulma, işçi yeniden başlamasında tekilleştirme, başarısız oluşturma ve kimliği doğrulanmış/boyutu sınırlı yerel kabul dahil. Kontrollü canlı deneyin ayrıntısı `DEPLOYMENT-2026-10-29.md` içindedir. Deneyde yüksek bellek sinyali simüle edilir; gerçek sunucu belleği bilerek şişirilmez.

0.11.0 doğrulama prototipi ayrı ve etkin değildir. Bu bellek değişiklikleri üstüne alınmadan dağıtılmamalı. Claude'un kaydı okuduğu geri okuma olmadan varsayılmaz.
