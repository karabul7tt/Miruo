# Miruo iOS Xcode Projesi 📱

Bu klasör, Miruo uygulamasını gerçek bir iOS uygulaması gibi iPhone simülatöründe veya fiziksel iPhone'unuzda çalıştırmak için hazırlandı.

## Özellikler
- **WebRTC & Kamera / Mikrofon İzinleri**: Info.plist ve WKUIDelegate üzerinden otomatik ve güvenli izinler ayarlandı.
- **Satır İçi Video & PiP**: WebKit üzerinde tam ekran ve picture-in-picture desteği açık.
- **Pull to Refresh**: Ekranı aşağı kaydırarak sayfayı yenileyebilirsiniz.
- **Shake to Configure (Cihazı Salla)**: Telefonu salladığınızda veya simülatörde `Cmd+Ctrl+Z` yaptığınızda bilgisayarınızın yerel IP adresini değiştirebileceğiniz ayar ekranı açılır.
- **Dark Mode & Safe Area**: iPhone Dynamic Island / Çentik ve alt çubuk alanlarıyla tam uyumlu.

## Xcode ile Nasıl Açılır ve Test Edilir?

### 1. Xcode'da Açma
Terminalden tek bir komutla projeyi Xcode'da açabilirsiniz:
```bash
open ios/Miruo.xcodeproj
```

### 2. Simülatörde Çalıştırma
1. Xcode açıldığında üst kısımdaki cihaz seçiciden herhangi bir iPhone simülatörünü seçin (örn: **iPhone 17 Pro**).
2. Sol üstteki **Play (▶️)** butonuna basın veya `Cmd + R` tuşlayın.
3. Uygulama otomatik olarak açılacaktır.

### 3. Gerçek iPhone'unuza Yükleme
1. iPhone'unuzu Mac'inize kablo ile bağlayın.
2. Telefonunuzda "Bu Bilgisayara Güven" uyarısı çıkarsa onaylayın.
3. Xcode'da cihaz seçiciden kendi **iPhone'unuzu** seçin.
4. **Signing & Capabilities** sekmesinden kendi Apple Kimliğinizi (Personal Team) seçin.
5. **Play (▶️)** butonuna basın.
6. Uygulama telefonunuza yüklenecektir!
7. Telefonunuz Mac ile **aynı Wi-Fi ağına** bağlı olduğu sürece canlı odalara katılabilir, görüntülü sohbet edebilir ve video izleyebilirsiniz.
