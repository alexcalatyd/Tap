#!/bin/zsh
# Compila Tap.app en build/. Con --install la copia además a /Applications.
set -euo pipefail
cd "${0:A:h}"

APP="build/Tap.app"

echo "→ Interfaz"
(cd ui && npm run build --silent)

echo "→ App nativa"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -swift-version 5 -target arm64-apple-macos13.0 \
  -framework AppKit -framework WebKit \
  native/main.swift -o "$APP/Contents/MacOS/Tap"
cp native/Info.plist "$APP/Contents/Info.plist"
cp -R ui/dist "$APP/Contents/Resources/ui"
# Español e inglés: macOS usa el del sistema en los paneles; la interfaz deja elegir.
mkdir -p "$APP/Contents/Resources/es.lproj" "$APP/Contents/Resources/en.lproj"
touch "$APP/Contents/Resources/"{es,en}.lproj/Localizable.strings

echo "→ Icono"
if [[ ! -f build/AppIcon.icns || native/icon.swift -nt build/AppIcon.icns ]]; then
  swift native/icon.swift build/icon-1024.png
  rm -rf build/AppIcon.iconset && mkdir build/AppIcon.iconset
  for s in 16 32 128 256 512; do
    sips -z $s $s build/icon-1024.png --out build/AppIcon.iconset/icon_${s}x${s}.png >/dev/null
    sips -z $((s * 2)) $((s * 2)) build/icon-1024.png --out build/AppIcon.iconset/icon_${s}x${s}@2x.png >/dev/null
  done
  iconutil -c icns build/AppIcon.iconset -o build/AppIcon.icns
fi
cp build/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

codesign --force --sign - "$APP" >/dev/null 2>&1
echo "✓ $APP"

if [[ "${1:-}" == "--install" ]]; then
  rm -rf "/Applications/Tap.app" "/Applications/Siphon.app" "/Applications/Caudal.app" "/Applications/yt-dlp+.app"  # las tres últimas, nombres antiguos
  cp -R "$APP" "/Applications/Tap.app"
  echo "✓ Instalada en /Applications"
fi
