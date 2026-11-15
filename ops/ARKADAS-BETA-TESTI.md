# Arkadaşla kapalı beta denemesi

Bu metin yalnız davet edilen birkaç kişiyle yerel deneme içindir. Mac, Chrome'daki
giriş yapılmış rezervasyon sekmesi ve yerel servis çalışırken bot cevap verir.
Bot rezervasyon yapmaz; arkadaşın ODTÜ kullanıcı adı, parolası veya oturum kodu
istenmez.

## Arkadaşa gönderilecek kısa açıklama

> ODTÜ Rezervasyon Takip botunun kapalı denemesine katılmak istersen
> [@ugur_rez_pilot_2026_bot](https://t.me/ugur_rez_pilot_2026_bot) sohbetini açıp
> Başlat'a bas. Davet kodunu sana ayrıca özelden ileteceğim. Birim → tesis →
> saat seçimini yap; `Seçimlerim` ile kaydını kontrol et. `Test mesajı` yalnız
> Telegram bağlantısını sınar, boş yer bulduğumuz anlamına gelmez. `Kapsam`
> ekranında son üç dakikada doğrulanan tesis ve günü görürsün. Şimdilik yalnız
> benim Mac'imdeki açık rezervasyon sekmesinde seçili tesis ve gün okunuyor;
> diğer seçimler kayıtlı kalsa da güncel bildirim üretmeyebilir. Bir yer
> göründüğünde kendi hesabından resmî sitede kontrol edip rezervasyonu kendin
> yaparsın. Bot ODTÜ'nün resmî hizmeti değildir.

Davet kodunu bu dosyaya, bir grup sohbetine veya ekran görüntüsüne koyma.
Gerçek bot tokenını ve yerel servis anahtarını hiçbir katılımcıyla paylaşma.

## Deneme ve kabul kaydı

1. Operatör `node ops/beta-status.mjs` ile takvim, Telegram ve güç durumunu
   kontrol eder. `Kapsam` ekranındaki tesis/gün, arkadaşın seçtiği hedefle
   örtüşmelidir. Kısmi seans uyarısı varsa deneme tam kapsam kanıtı değildir.
2. Arkadaş kendi telefonunda bota davet koduyla girer. Ana menü, tesis ve birden
   fazla saat seçimi, `Seçimlerim`, `Kapsam`, `Destek ve iletişim` ve ana menüye
   dönüşü sırayla dener. Test mesajı ayrı olarak gelir.
3. Operatör durum çıktısında onaylı özel sohbet sayısının arttığını ve bildirim
   kuyruğunun sağlıklı olduğunu kontrol eder. Sohbet kimliğini veya davet kodunu
   rapora yazmaz.
4. Arkadaş yalnız hedef tesis/günün doğal boş yer değişimi olursa telefonuna
   gelen **gerçek** bildirimin tesisini, saatini ve yaklaşık varış zamanını
   doğrular. Böyle bir olay yaşanmazsa bu adım `gözlenmedi` kalır; test mesajı
   veya sentetik olay onun yerine geçmez.
5. Mac'in uyuması, Chrome sekmesinin kapanması, oturumun bitmesi veya 403/429
   engeli izlemeyi keser. Bu durumda `7/24` ya da bütün tesisler izleniyor
   vaadi verilmez; kapalı deneme sonuçlanmadan genel davet yapılmaz.

Arkadaşın geri bildiriminde yalnız cihaz/tarayıcı türü, düğme gecikmesi,
seçimlerin saklanması ve bildirim görünümü sorulsun. Hesap bilgileri, bot
anahtarı veya kişisel rezervasyon ekranı istenmesin.
