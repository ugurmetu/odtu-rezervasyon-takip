# ODTÜ Rezervasyon Takip — açık katılım

28 Ekim 2026

Paylaşılacak bağlantı: https://t.me/odtu_rezervasyon_bot

Kullanıcı Telegram’da **Başlat → Birim ve tesis seç → Tesis → Gün → Seans → Bitti** yolunu izler. Birden fazla seçim yapabilir; Seçimlerim’den yönetir. Eklenti kurmaz, ODTÜ kullanıcı adı/parolası vermez. Rezervasyonu kendisi resmî sitede yapar. Etkin sohbet/seçim/bildirim kayıtlarını `/sil` ile kaldırabilir.

Settings ana menüdedir ve her iki dilde de adı **Settings** kalır. Türkçe veya English seçimi kişiye özeldir; menüler ve sonraki bildirimler seçilen dilde gelir. Destek ve test mesajı da bu bölümdedir. `/settings` doğrudan açar; eski Türkçe komutlar ve İngilizce karşılıkları birlikte çalışır. Dil seçmek kayıtlı seansları değiştirmez.

## Güncel tek sekmeli çalışma

28 Ekim öğleden sonra 32 ek takip sekmesi kapatıldı. Kullanıcı kartı yeniledi, çalışan 0.8.0/singleTab doğrulandı ve tek rezervasyon sekmesinde tarama yeniden açıldı. 32 tesisin tamamı iki tur okundu, 160 tesis/gün güncel; ölçülen tekrar 129–142 saniye. 0.8.0 periyodik tam sayfa yenilemesinde bekleyince 0.8.1’e geçildi; aynı oturumdan yeni listeyi sayfayı değiştirmeden okuyor. 16.38.10 İstanbul arka plan katalog yenilemesi sonrası takvimler güncel kaldı. Telegram yoklaması çalışıyor. Bu kısa gözlem 30 saniye veya bağımsız 7/24 sunucu kabulü değildir. Aşağıdaki 0.7.0 açıklaması tarihsel kapsamdır; güncel uygulama extension/README.md içindedir.

## Fiilî kapsam

- Çalışan 0.7.0 okuyucu, resmî katalogdaki 32 etkin tesisi ortak plana alır. İstanbul haftasının geçmiş olmayan günleri izlenir; pazar 21.00’dan sonra gelecek pazartesi–pazar. Yeni tesis ve varsa birimler beş dakikalık resmî katalog keşfiyle menüye eklenir. Her günün seansları gerçek yanıttan gelir; ilk okuma bekleniyorsa açıkça belirtilir. İlk geniş hazırlık turu canlı kabul aşamasındadır; 32 tesisin tamamının 30 saniyede güncel olduğu henüz doğrulanmadı.
- Davet gerekmiyor. Özel `/start` sohbeti kaydeder; başka güncellemeler kendiliğinden kişiyi kaydetmez. Görünen ad **ODTÜ Rezervasyon Takip**. Eski `@ugur_rez_pilot_2026_bot` mesaj/menü etkileşimlerine yeni bağlantıyı gösterir; ikinci okuyucu veya ikinci rezervasyon takibi çalıştırmaz.
- Yeni botta bir kez Başlat gerekir. Önceki seçimler korunur; eski botun mesaj kimlikleri/yoklama ofseti yeni botta kullanılmaz. Eski kartlar yeni bot tarafından düzenlenemez. Yeni mesajların durum değişikliği takibi normal şekilde devam eder.
- Merkezi bildirim servisi hâlâ bu Mac üzerinde. Mac, Chrome ve okuyucu çalışmadığında güncel bildirim üretilemez. Sunucuya taşınmış veya 7/24 çalışması doğrulanmış değildir. Kullanıcı sayısı başına ODTÜ sorgusu açılmaz; aynı tesisin ortak okuması paylaşılır.

## İşletim

`.local/access-mode` dosyasının `public` içeriği veya `REZ_ACCESS_MODE=public` açık katılımı açıkça seçer. Varsayılan `invite`; eksik davet yapılandırması sessizce herkese açmaz. İlk kapasite üst sınırı 1000 sohbet (`REZ_PUBLIC_MAX_CHATS`, en fazla 10000); bu sayıda yük/kesintisizlik garantisi değildir. Kullanıcıya özgü menü sınırları ve Telegram bekleme kuralları korunur.

Servis yalnız 127.0.0.1’e bağlıdır. Telegram’dan katılım, yerel anahtara, ODTÜ oturumuna veya yönetim/kimlik bilgisi uçlarına erişim sağlamaz. Kullanıcı adı, ad/soyad ve telefon alınmaz; gönderim için sohbet numarası ve tercihler gerekir. `/sil` etkin durum kaydını kaldırır; operatörün gizli tarihli yedeklerini geçmişe dönük yeniden yazmaz. Özel yedekler ve anahtar dosyaları paylaşılmaz.

Eski bot anahtarı `.local/telegram-legacy-token`, yönlendirme ofseti `.local/legacy-redirect.json` içindedir. Eski bot yalnız istek geldiğinde yönlendirme cevabı verir. Yeni botun anahtarı `.local/telegram-token`; iki anahtar da 0600, `.local/` dışa aktarma dışında. Profil güncellemesi `node ops/update-bot-profile.mjs` ile yapılır ve beklenen kullanıcı adı doğrulanır.
