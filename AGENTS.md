# Rezervasyon botu çalışma kuralları

## 15 Kasım 2026 — Her güncelleme GitHub'a commit edilip gönderilir

- Kullanıcının kalıcı talimatı: bu rezervasyon eklentisi/botu için yapılan her doğrulanmış kaynak güncellemesi `ugurmetu/odtu-rezervasyon-takip` deposunun `main` dalına açıklayıcı commit ile gönderilir. Yalnız yerelde commit atmak tamamlanma değildir; uzak commit ve sürüm/dosyalar geri okunur. Normal kod güncellemesi için tekrar yayın onayı istenmez.
- Önce güncel Claude/Codex kaynaklarını, gerçek manifesti ve uzak dalı kontrol et. Başkasının commit'ini ezme; force-push yapma. Canlı VPS dağıtımı ve GitHub kaynağı ayrı sonuçlardır; biri diğerinin gerçekleştiğini kanıtlamaz.
- Çalışan proje klasörünü doğrudan Git'e ekleme. Önce `ops/export-public-source.mjs` ile izin listesinden paylaşım çıktısı üret; `.local`, gerçek `extension/local-config.json`, kullanıcı kayıtları, anahtarlar, parolalar ve özel devir/izleme kayıtları depoya gitmez. Yeni dosya varsa önce izin listesini ve dışa aktarım kontrolünü güncelle.
- Depo: https://github.com/ugurmetu/odtu-rezervasyon-takip . Ders kontenjanı eklentisinin ayrı deposuyla karıştırma. Adımlar: `ops/GITHUB-YAYIN.md`. Uzak yükleme başarısızsa yerel değişiklikleri koru ve gönderilemediğini açıkça belirt; gönderilmiş gibi kaydetme.

## 6 Kasım 2026 — Arıza toparlaması için tekrar onay istenmez

- Kullanıcı sunucu ve okuyucu arızalarında otomatik toparlama istedi. 31 Ekim onarım yetkisini uygula. Yetkili teşhis, olağan oturum yenilemesi ve servis toparlaması için yeniden onay isteme. İnsan doğrulaması çıkarsa bilgisayar aracının o andaki CAPTCHA onayı kuralı geçerlidir.
- İki dakika süren insan doğrulaması gereksinimini ayrı yönetici botuna olay başına bir kez bildir. Başka teknik uyarılar bu bildirimi geciktirmez. Tam kapsam geri geldiğinde olayın kapandığını yeni tesis okumalarıyla doğrula.

## 1 Kasım 2026 — Hafta açılışı sessizdir; kullanıcıya teknik/güncelleme bildirimi yok

- Kullanıcının son talimatıyla Pazar 21.00–22.00 yeni hafta duyurusu ve Settings içindeki hafta bildirimi anahtarı kaldırılır. Önceden açık seçilmiş olması istisna değildir; eski `wn:0/1` düğmeleri yalnız normal Settings'e döner ve duyuruyu yeniden açamaz.
- Yeni hafta gerçek, taze takvimlerden öğrenilmeye devam eder; Pazar 19.30 hafta geçişi ve 20.55–22.15 adil tesis taraması korunur. Sırf saat geldi diye yeni hafta açılmış sayılmaz. Yayın algılama hiçbir son kullanıcı `sendMessage` kuyruğu üretmez.
- Eski kalıcı hafta/güncelleme kuyruğu açılışta temizlenir; eski gönderim yardımcısı çağrılsa bile mesaj göndermez. Yeniden başlatma, dağıtım, dil değişimi ve arıza/toparlanma için ana kullanıcı botuna ek mesaj yoktur; sahibin kullanıcı sohbeti de istisna değildir.
- Teknik olaylar yalnız mevcut ayrı, doğrulanmış yönetici kanalına gidebilir; kanal çalışmıyorsa kullanıcı botuna dönüş yoktur. Normal seçilmiş müsaitlik (Yer açıldı/Doldu) bildirimleri ve doğrudan kullanıcı komut/düğme yanıtları korunur. Kullanıcılara canlı test/güncelleme mesajı gönderilmez.
- Bu son karar, aşağıdaki tarihsel 30 Ekim metnindeki “açıkça açtığı hafta duyurusu devam eder” istisnasını geçersiz kılar. Güncel uygulama ve dağıtım README'nin en üstündedir.

Üst merkez AGENTS.md kuralları geçerlidir. Güncel kod/sürüm için önce README.md ve gerçek manifest okunur; Claude/Codex değişiklikleri eski kopyayla ezilmez.

## 31 Ekim 2026 — İzleme arızalarında onarım yetkisi

- Kullanıcının açık talimatı: “hata olduğun da tam yetki var düzeltmek için ... diğer sohbetin ve senin ... otomasyona yaz”. Bu bakım sohbeti ve mevcut `odtü eklenti` sohbeti, ODTÜ Rezervasyon sisteminde doğrulanmış arızayı gidermek için ek onay beklemeden teşhis, kod/yapılandırma düzeltmesi, test, dağıtım, geri alma, gerekli servis/Chrome/uzantı/oturum ve doğrulama işlemlerini yapabilir. Önceki otomasyonların salt okunur üretim müdahalesi yasağı arıza onarımı için kaldırılmıştır; rutin kontroller salt okunur kalır.
- Kısa kontrol 10 dakikada birdir; 04.00 İstanbul kapsamlı denetimi ayrı kalır. Yeni arızalar `ops/vps/MONITOR-NOTIFICATIONS.md` kuralıyla eklenti sohbetine devredilir. Mevcut olayı kullanıcı zaten ilettiyse tekrar arıza mesajı gönderilmez; yetki değişikliği ayrıca iletilebilir.
- İki sohbet aynı canlı sistemde eşzamanlı müdahale etmez: önce hedef sohbetin son durumunu ve güncel devir kaydını oku; aktif onarımı yapan sohbet işlemi sürdürür. Diğeri izler ve kanıtı aktarır. Daha yeni Claude/Codex kaynağını eski kopyayla ezme; tercihleri, kullanıcı verilerini ve sırları koru.
- Onarım sonrası gerçek yeni tesis okumaları, kapsam ve ilgili servis/Telegram sağlığı doğrulanmadan toparlandı deme; bellek onarımında yeni okuma ve gerçek bellek düşüşü de görülmeli. Teknik bildirimler ayrı yönetici kanalında kalır; ana kullanıcı botundan teknik/test mesajı, kullanıcı adına rezervasyon veya gerçek yük testi yapılmaz.

## 30 Ekim 2026 — Kullanıcı ekranlarında teknik Durum bölümü yok

- Teknik takip sağlığı, sorgu/kapsam oranları, bağlantı ve oturum durumları Seçimlerim'e, Destek'e veya başka bir kullanıcı menüsüne tekrar eklenmez. Seçimlerim tesis, gün, saat ve düzenleme/silme işlemlerini gösterir; Durum düğmesi ve tesis başına teknik sağlık satırı içermez.
- Eski Durum düğmeleri ve /status, /durum komutları teknik ekrana değil normal Seçimlerim'e döner. Teknik kontroller ve arıza/toparlanma bildirimleri ayrı ODTÜ Rezervasyon Yönetim kanalında kalır; ana kullanıcı botu sahibi için de teknik arayüz değildir.
- Destek yalnız iletişim bilgilerini gösterir; “Seçimlerin yalnız bildirim için saklanır; /sil ...” açıklaması TR/EN çıkarılır. Gerçek /sil, /delete işlevleri ve kayıtları silme davranışı korunur.
- Bu sadeleştirme eski müsaitliği yeniymiş gibi göstermeye veya çalışmayan takip için başarı uydurmaya izin vermez. Seans verisinin güncelliği ve doğrulanmasıyla ilgili mevcut doğruluk kontrolleri korunur. Güncelleme duyurusu veya başka kullanıcılara test mesajı gönderilmez.
- Kaynak: 30 Ekim 2026 bu sohbette kullanıcının tekrarladığı açık arayüz tercihi.

## 30 Ekim 2026 — Güncelleme ve arayüz tanıtımı için kullanıcıya mesaj gönderme

- Sürüm dağıtımı, arayüz/düğme değişikliği, klavye kurulumu veya dil geçişi son kullanıcılara kendiliğinden tanıtım, yönerge, test veya güncelleme mesajı üretmez. “Rezervasyon bağlantısı için alttaki düğmeyi kullan / Use the button below...” gibi ek mesajlar yasaktır; sessiz Telegram bildirimi olarak göndermek de bu yasağı aşmaz.
- Sahibin ana kullanıcı-botu sohbeti de bu kuralın dışına çıkmaz. Değişiklik kullanıcıya Codex sohbetinde anlatılır; teknik olaylar yalnız mevcut ayrı yönetici kanalında kalır.
- Kullanıcının istediği normal komut/düğme yanıtları, seçtiği rezervasyon takibi (Yer açıldı/Doldu) ve açıkça açtığı hafta duyurusu devam eder. Kalıcı site klavyesi yalnız zaten gönderilecek uygun normal mesajın markup'ına eklenir; sırf klavyeyi kurmak için yeni mesaj atılmaz.
- Bu sınır testle korunur: başlangıç, yeniden başlatma, eski durum göçü, menü gezinmesi ve dil değişimi fazladan sendMessage çağrısı üretmemeli. Başka kullanıcılara canlı test mesajı gönderme.
- Kaynak: 30 Ekim 2026 bu sohbetteki açık kullanıcı talimatı. Ortak tercih `ORTAK-BEYIN/01-CALISMA-ZIHNIYETI-VE-TERCIHLER.md` içinde de kayıtlıdır; diğer ajanın okuduğu varsayılmaz.

## 29 Ekim 2026 — Kullanıcı ve yönetici bildirimleri ayrıdır

- `@odtu_rezervasyon_bot` kullanıcı botudur. Sunucu, doğrulama kutusu, parola kasası, sorgu/takvim kapsamı veya Telegram bağlantısına ilişkin teknik uyarı bu bottan sahibine bile gönderilmez.
- Teknik gönderim yalnız ayrı, doğrulanmış yönetici botu ve sabit özel sahip sohbeti üzerinden yapılır. Yönetici kanalı yoksa/başarısızsa ortak bota dönüş yoktur; kayıtlar ve Codex izleme yolu kullanılır.
- `src/operator-alerts.mjs` alıcıyı sabitler; `src/coverage.mjs` düz kullanıcı-botu API'sini reddeder. Bu sınırı kaldırma veya teknik bildirimi normal rezervasyon kuyruğuna ekleme.
- Kullanıcıdan merkezi sunucunun CAPTCHA'sını, oturumunu veya Chrome'unu düzeltmesi istenmez. Teknik durum yalnız yönetici tarafında kalır; çalışmayan takip için başarı/boş yer uydurulmaz.
- Eski pilot bot yönetici kanalı olarak kullanılır; sahibi dışındaki eski bağlantı kullanıcıları ana bota yönlendirilir. Yönetici kimliği, anahtarlar ve test mesaj kimlikleri yalnız özel `.local` alanında kalır.
- Sunucuya özgü teknik işlerde kullanıcıya gereksiz yenileme/başlatma adımı çıkarma. Bu değişiklik yalnız Node servisini etkiler; tarayıcı/uzantı gereksiz yeniden başlatılmaz.
