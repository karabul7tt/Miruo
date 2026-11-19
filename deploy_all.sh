#!/usr/bin/env bash
set -e

# ==============================================================================
# Miruo Unified Deployment & Release Pipeline
# (macOS DMG, Windows ZIP, iOS TestFlight Archive & IPA, Website & Android Assets)
# ==============================================================================

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

echo "🚀 [1/6] Dosyalar tüm platformlara senkronize ediliyor..."
cp -f site.js website/site.js
cp -f index.html website/index.html
for target in desktop-app/public ios/Miruo/public android/app/src/main/assets/public website/app; do
  mkdir -p "$target"
  cp -f app/app.js "$target/app.js"
  cp -f app/index.html "$target/index.html"
  cp -f app/style.css "$target/style.css"
done
echo "✅ Dosyalar eşitlendi."

echo "🍏 [2/6] macOS Masaüstü Uygulaması derleniyor ve Apple Noter Onayı alınıyor..."
(
  cd desktop-app
  npm run dist:mac
)

echo "🍏 Miruo.app Apple Noter Sunucusuna gönderiliyor..."
xcrun notarytool submit desktop-app/dist/Miruo-1.0.0-arm64-mac.zip \
  --apple-id "dythin.app@gmail.com" \
  --password "bjnl-emth-buct-zzxb" \
  --team-id "VR7K23PNPM" \
  --wait

echo "🍏 Apple Onay Bileti doğrudan Miruo.app paketine zımbalanıyor (Staple)..."
xcrun stapler staple desktop-app/dist/mac-arm64/Miruo.app

echo "🍏 Mühürlü Miruo.app ile DMG yeniden paketleniyor ve imzalanıyor..."
(
  cd desktop-app
  npx electron-builder --mac dmg --prepackaged dist/mac-arm64/Miruo.app
)
codesign --force --sign "Developer ID Application: MEHMET KARABULUT (VR7K23PNPM)" desktop-app/dist/Miruo-1.0.0-arm64.dmg
cp -f desktop-app/dist/Miruo-1.0.0-arm64.dmg downloads/Miruo.dmg

echo "🍏 DMG Apple Noter Sunucusuna gönderiliyor..."
xcrun notarytool submit downloads/Miruo.dmg \
  --apple-id "dythin.app@gmail.com" \
  --password "bjnl-emth-buct-zzxb" \
  --team-id "VR7K23PNPM" \
  --wait

echo "🍏 Apple Onay Bileti DMG'ye zımbalanıyor (Staple)..."
xcrun stapler staple downloads/Miruo.dmg
cp -f downloads/Miruo.dmg website/downloads/Miruo.dmg
echo "✅ macOS (Apple Silicon) Miruo.app + DMG resmi Apple noter onayıyla hazırlandı."

echo "🍏 [2b/6] macOS (Intel x64) Uygulaması derleniyor ve Apple Noter Onayı alınıyor..."
(
  cd desktop-app
  npx electron-builder --mac zip --x64
)
xcrun notarytool submit desktop-app/dist/Miruo-1.0.0-mac.zip \
  --apple-id "dythin.app@gmail.com" \
  --password "bjnl-emth-buct-zzxb" \
  --team-id "VR7K23PNPM" \
  --wait
xcrun stapler staple desktop-app/dist/mac/Miruo.app
rm -f downloads/Miruo-Intel.zip website/downloads/Miruo-Intel.zip
(
  cd desktop-app/dist/mac
  ../../node_modules/7zip-bin/mac/arm64/7za a -tzip -mx=9 -snl "$ROOT_DIR/downloads/Miruo-Intel.zip" Miruo.app > /dev/null
)
cp -f downloads/Miruo-Intel.zip website/downloads/Miruo-Intel.zip
echo "✅ macOS (Intel x64) Miruo-Intel.zip resmi Apple noter onayıyla hazırlandı."

echo "🪟 [3/6] Windows Uygulaması paketleniyor..."
cp -f desktop-app/dist/mac-arm64/Miruo.app/Contents/Resources/app.asar desktop-app/dist/win-unpacked/resources/app.asar
(
  cd desktop-app/dist
  zip -q -r -9 Miruo-Windows.zip win-unpacked
)
cp -f desktop-app/dist/Miruo-Windows.zip downloads/Miruo-Windows.zip
cp -f desktop-app/dist/Miruo-Windows.zip website/downloads/Miruo-Windows.zip
echo "✅ Windows ZIP paketi güncellendi."

echo "📱 [4/6] iOS Build Numarası artırılıyor ve TestFlight arşivi oluşturuluyor..."
CURRENT_BUILD=$(/usr/libexec/PlistBuddy -c "Print CFBundleVersion" ios/Miruo/Info.plist)
NEXT_BUILD=$((CURRENT_BUILD + 1))
echo "Mevcut build: $CURRENT_BUILD -> Yeni build: $NEXT_BUILD"

/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $NEXT_BUILD" ios/Miruo/Info.plist
sed -i '' "s/CURRENT_PROJECT_VERSION = $CURRENT_BUILD;/CURRENT_PROJECT_VERSION = $NEXT_BUILD;/g" ios/Miruo.xcodeproj/project.pbxproj

ARCHIVE_PATH="$ROOT_DIR/ios/build/Archives/Miruo_Build${NEXT_BUILD}.xcarchive"
TODAY=$(date "+%Y-%m-%d")
XCODE_ORGANIZER_DIR="$HOME/Library/Developer/Xcode/Archives/$TODAY"

xcodebuild -project ios/Miruo.xcodeproj \
  -scheme Miruo \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE_PATH" \
  archive

mkdir -p "$XCODE_ORGANIZER_DIR"
cp -R "$ARCHIVE_PATH" "$XCODE_ORGANIZER_DIR/"

echo "📲 App Store Connect / TestFlight'a yükleniyor (Build $NEXT_BUILD)..."
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportOptionsPlist "/Users/mehmetkarabul7tt/.gemini/antigravity/brain/990d40d1-50cd-4fee-bac5-5e499a7dd65e/scratch/ExportOptions.plist" \
  -exportPath "/tmp/miruo_tf_export_${NEXT_BUILD}" \
  -allowProvisioningUpdates
echo "✅ iOS Build $NEXT_BUILD App Store Connect / TestFlight'a başarıyla yüklendi."

# IPA oluştur
TEMP_PAYLOAD="/tmp/miruo_ipa_payload_${NEXT_BUILD}"
rm -rf "$TEMP_PAYLOAD"
mkdir -p "$TEMP_PAYLOAD/Payload"
cp -R "$ARCHIVE_PATH/Products/Applications/Miruo.app" "$TEMP_PAYLOAD/Payload/"
(cd "$TEMP_PAYLOAD" && zip -qr -9 Miruo.ipa Payload)
cp -f "$TEMP_PAYLOAD/Miruo.ipa" downloads/Miruo.ipa
cp -f "$TEMP_PAYLOAD/Miruo.ipa" website/downloads/Miruo.ipa
rm -rf "$TEMP_PAYLOAD"
echo "✅ iOS Build $NEXT_BUILD Xcode Organizer'a ve IPA indirme dosyalarına eklendi."

echo "🌐 [5/6] Git değişiklikleri kaydediliyor ve Vercel/GitHub'a gönderiliyor..."
git add android/ app/ desktop-app/public/ desktop-app/build/entitlements.mac.plist downloads/ ios/ website/ site.js index.html vercel.json deploy_all.sh
git commit -m "build(release): deploy macOS DMG, Windows ZIP, iOS Build ${NEXT_BUILD} and web updates" || true

echo "☁️ [6/6] Uzak sunucuya aktarılıyor..."
git pull --rebase origin main
git push origin main

echo "🎉🎉 Tüm platformlar (macOS, Windows, iOS TestFlight, Website & Android) başarıyla güncellendi ve yayınlandı!"
