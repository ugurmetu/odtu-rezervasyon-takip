# GitHub kaynak güncelleme akışı

Kullanıcı 15 Kasım 2026'da her güncellemenin commit edilip GitHub'a gönderilmesini istedi. Depo: https://github.com/ugurmetu/odtu-rezervasyon-takip ; dal: `main`. Bu talimat yalnız bu projeye aittir.

1. Proje AGENTS.md, gerçek sürüm ve güncel Claude/Codex değişikliklerini oku. Uzak dalın son commit'ini kontrol et; başka değişiklikleri eski kopyayla ezme.
2. Değişikliğe uygun testleri çalıştır. Başarısız veya dağıtılmamış sürümü başarılı/canlı diye anlatma. Yeni dosya varsa kaynak dışa aktarım listesini güncelle.
3. `node ops/export-public-source.mjs --output /mutlak/yeni/klasor` ile yeni paylaşım çıktısı üret. Çalışan klasörü, özel ayarları veya bütün diski doğrudan yükleme. `.local/`, gerçek `extension/local-config.json`, kullanıcı kayıtları, parolalar, tokenlar ve özel devir kayıtları dışarıda kalır.
4. Çıktıdaki kaynakları, dizinlerini koruyarak depoya gönder. Commit açıklaması yapılan değişikliği ve gerçek sürümü belirtir. Kaynağı dosya dosya incelemek mümkün olmalı; yalnız ZIP yüklemek yeterli değildir. Bir web yüklemesi birden çok commit gerektirirse kapsamlarını açıklayıcı yaz.
5. Uzak `main` commit'ini ve dosya ağacını geri oku; manifest sürümü ve paylaşım çıktısının dosyaları/karmaları eşleşmeli. Yerel commit veya yalnız depo açılması tamamlanma değildir. Uzak kimlik/erişim sorunu varsa mevcut yetkili GitHub bağlantısını ya da doğrulanmış ana tarayıcı oturumunu kullan; sırları günlüklere yazma ve force-push yapma.
6. Kısa yerel yayın makbuzunu `.local/` altında sakla; diğer bakım sohbetine ve Claude/Codex proje devrine hangi kaynak sürümünün gönderildiğini bildir. Bu, VPS dağıtımını veya bot kullanıcısına mesaj göndermeyi kendiliğinden tetiklemez.

Çalışan özel proje kökü Git deposu değildir. Git deposu gerekiyorsa yalnız incelenmiş dışa aktarımın ayrı kopyasında oluştur; kanonik proje dosyalarını veya özel çalışma verilerini taşıma. Gönderim doğrulanmadan “GitHub güncel” deme.
