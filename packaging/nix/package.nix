{ lib
, stdenvNoCC
, rustPlatform
, pkg-config
, gtk4
, libadwaita
, glib
, pango
, gdk-pixbuf
, cmake
, clang
, libclang
, vulkan-headers
, vulkan-loader
, glslang
, makeWrapper
, gnome-shell
, glibc
, bash
, inter
, symlinkJoin
, src
, version
}:

let
  metadata = lib.importJSON (src + "/gnome-extension/metadata.json");
  pname = "gnome-island";
in

rustPlatform.buildRustPackage {
  inherit pname version src;

  nativeBuildInputs = [
    pkg-config
    cmake
    clang
    libclang
    makeWrapper
    glib # for glib-compile-schemas
  ];

  buildInputs = [
    gtk4
    libadwaita
    glib
    pango
    gdk-pixbuf
    vulkan-headers
    vulkan-loader
    glslang
  ];

  cargoLock = {
    lockFile = src + "/Cargo.lock";
  };

  # Tests include integration tests that hang in sandboxed builds.
  doCheck = false;

  # Build only the daemon and shelf by default; whisper needs Vulkan which is optional.
  buildPhase = ''
    runHook preBuild
    cargo build --release -p isle-daemon -p isle-shelf
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    # Install extension files to a writable temp dir first, compile schemas,
    # then move to $out. This avoids permission issues from cp -r preserving
    # read-only Nix store permissions.
    local tmpExt=$(mktemp -d)
    cp -r ${src}/gnome-extension/. "$tmpExt/"
    chmod -R +w "$tmpExt"

    # Compile the gsettings schema so the extension can read its keys immediately.
    if [ -d "$tmpExt/schemas" ]; then
      glib-compile-schemas "$tmpExt/schemas"
    fi

    local extDir="$out/share/gnome-shell/extensions/${metadata.uuid}"
    mkdir -p "$extDir"
    cp -r "$tmpExt/." "$extDir/"
    rm -rf "$tmpExt"

    # Install fonts
    mkdir -p "$out/share/fonts/isle"
    cp ${src}/data/fonts/InterVariable.ttf "$out/share/fonts/isle/"

    # Install binaries
    mkdir -p "$out/bin"
    cp target/release/isled "$out/bin/"
    cp target/release/isle-shelf "$out/bin/"

    # Scripts
    cp ${src}/scripts/setup-voice.sh "$out/bin/isle-setup-voice"
    cp ${src}/scripts/isle-charge-limit "$out/bin/"

    # Services
    mkdir -p "$out/share/dbus-1/services"
    for svc in io.github.stefanhacks.gnomeisland.Daemon.service io.github.stefanhacks.gnomeisland.ShelfWindow.service; do
      sed \
        -e "s|@BINDIR@|$out/bin|" \
        -e "s|file://%h/.local/share/doc/isle|file://$out/share/doc/isle|" \
        ${src}/data/$svc > "$out/share/dbus-1/services/$svc"
    done

    mkdir -p "$out/lib/systemd/user"
    sed \
      -e "s|@BINDIR@|$out/bin|" \
      -e "s|file://%h/.local/share/doc/isle|file://$out/share/doc/isle|" \
      ${src}/data/isled.service > "$out/lib/systemd/user/isled.service"

    # Docs
    mkdir -p "$out/share/doc/isle"
    cp ${src}/README.md ${src}/CHANGELOG.md ${src}/LICENSE "$out/share/doc/isle/"

    runHook postInstall
  '';

  # The extension JS sources the font via file:// URI built at runtime.
  # We need the font discoverable by fontconfig for the "Inter Variable" family.
  postFixup = ''
    mkdir -p "$out/etc/fonts/conf.d"
    cat > "$out/etc/fonts/conf.d/50-isle-inter.conf" <<'EOF'
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>${placeholder "out"}/share/fonts/isle</dir>
  <match target="pattern">
    <test name="family" compare="eq"><string>Inter Variable</string></test>
    <edit name="family" mode="assign"><string>Inter</string></edit>
  </match>
</fontconfig>
EOF
  '';

  meta = with lib; {
    description = "A notch-style island for the GNOME Shell top bar";
    homepage = "https://github.com/stefan-hacks/gnome-island";
    license = licenses.gpl3Plus;
    platforms = platforms.linux;
    maintainers = [ ];
  };
}
