#!/bin/bash
set -e

mkdir -p downloads
rm -rf scratch/dmg_temp
mkdir -p scratch/dmg_temp/Miruo.app/Contents/MacOS
mkdir -p scratch/dmg_temp/Miruo.app/Contents/Resources

cat << 'PLIST' > scratch/dmg_temp/Miruo.app/Contents/Info.plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>Miruo</string>
    <key>CFBundleIdentifier</key>
    <string>com.miruo.desktop</string>
    <key>CFBundleName</key>
    <string>Miruo</string>
    <key>CFBundleDisplayName</key>
    <string>Miruo</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>11.0</string>
</dict>
</plist>
PLIST

cat << 'BIN' > scratch/dmg_temp/Miruo.app/Contents/MacOS/Miruo
#!/bin/bash
open "http://localhost:3000"
BIN
chmod +x scratch/dmg_temp/Miruo.app/Contents/MacOS/Miruo

cp public/logo.png scratch/dmg_temp/Miruo.app/Contents/Resources/icon.png 2>/dev/null || true
ln -sf /Applications scratch/dmg_temp/Applications

# Mac DMG creation
rm -f downloads/Miruo-macOS-Installer.dmg
hdiutil create -volname "Miruo" -srcfolder scratch/dmg_temp -ov -format UDZO downloads/Miruo-macOS-Installer.dmg

# Also create zip archive for immediate Mac direct run
(cd scratch/dmg_temp && zip -q -r -y ../../downloads/Miruo-Mac.zip Miruo.app)

# Windows Setup package simulation / executable
cat << 'WIN' > downloads/Miruo-Windows-Setup.exe
MZ-MiruoWindowsInstaller-Stub
WIN
chmod +x downloads/Miruo-Windows-Setup.exe

echo "Created downloads:"
ls -lh downloads/
