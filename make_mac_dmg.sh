#!/bin/bash
set -e

STAGING_DIR="scratch/dmg_staging"
APP_DIR="$STAGING_DIR/Miruo.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

rm -rf "$STAGING_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

# 1. Info.plist
cat << 'PLIST' > "$CONTENTS_DIR/Info.plist"
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
    <string>1.2.0</string>
    <key>CFBundleVersion</key>
    <string>120</string>
    <key>LSMinimumSystemVersion</key>
    <string>11.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
PLIST

# 2. Executable launcher
cat << 'LAUNCHER' > "$MACOS_DIR/Miruo"
#!/bin/bash
# Miruo macOS Desktop Launcher
open "http://localhost:3000"
LAUNCHER
chmod +x "$MACOS_DIR/Miruo"

# 3. Copy Logo Icon
cp logo.png "$RESOURCES_DIR/icon.png"

# 4. Applications symlink for drag and drop install
ln -sf /Applications "$STAGING_DIR/Applications"

# 5. Create DMG
mkdir -p downloads
rm -f downloads/Miruo-macOS-Installer.dmg
hdiutil create -volname "Miruo for Mac" -srcfolder "$STAGING_DIR" -ov -format UDZO downloads/Miruo-macOS-Installer.dmg

echo "✅ Miruo-macOS-Installer.dmg created successfully!"
ls -lh downloads/Miruo-macOS-Installer.dmg
