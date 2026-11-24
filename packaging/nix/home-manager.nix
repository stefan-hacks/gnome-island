# Home Manager module for GNOME Island
#
# Usage in your home-configuration.nix:
#   imports = [ inputs.gnome-island.homeManagerModules.gnome-island ];
#   programs.gnome-island.enable = true;
#
{ config, lib, pkgs, ... }:

let
  cfg = config.programs.gnome-island;
  src = ../../.;  # The gnome-island source root (packaging/nix/../../.)
  metadata = lib.importJSON (src + "/gnome-extension/metadata.json");
  version = metadata.version-name or "dev";
  pkg = pkgs.callPackage ./package.nix { inherit src version; };
in

{
  options.programs.gnome-island = {
    enable = lib.mkEnableOption "GNOME Island Shell extension";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkg;
      description = "The GNOME Island package to install.";
    };

    settings = lib.mkOption {
      type = lib.types.attrsOf lib.types.anything;
      default = { };
      example = lib.literalExpression ''
        {
          "org.gnome.shell.extensions.isle" = {
            island-theme = "gnome";
            top-bar-color = true;
            compact-top-bar = true;
            island-in-top-bar = true;
            clock-format = "24h";
          };
        }
      '';
      description = ''
        GSettings overrides for GNOME Island, keyed by schema id.
        Each value is an attribute set of key-value pairs written via gsettings.
      '';
    };

    enableUserService = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Enable the isled user systemd service.";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];

    # Install the GNOME Shell extension into the user's extensions directory.
    # We copy rather than symlink because GNOME Shell and the Extensions app
    # sometimes need to write into the extension directory (e.g. removing old
    # licence files), and a symlink to the read-only Nix store breaks that.
    home.activation.gnome-island-extension = lib.hm.dag.entryAfter ["writeBoundary"] ''
      extSrc="${cfg.package}/share/gnome-shell/extensions/gnome-island@stefan-hacks.github.com"
      extDst="${config.home.homeDirectory}/.local/share/gnome-shell/extensions/gnome-island@stefan-hacks.github.com"
      if [ -L "$extDst" ] || [ -e "$extDst" ]; then
        rm -rf "$extDst"
      fi
      mkdir -p "$extDst"
      cp -r "$extSrc/"* "$extDst/"
      chmod -R +w "$extDst"
    '';

    # Prevent home-manager from also creating a symlink here.
    # (The activation script above handles the copy.)

    # Enable the extension via dconf.
    dconf.settings = {
      "org/gnome/shell".enabled-extensions = lib.mkAfter [ "gnome-island@stefan-hacks.github.com" ];
    } // lib.optionalAttrs (cfg.settings != { }) cfg.settings;

    # Enable the user service if requested.
    systemd.user.services.isled = lib.mkIf cfg.enableUserService {
      Unit = {
        Description = "GNOME Island daemon";
        PartOf = [ "graphical-session.target" ];
      };
      Service = {
        ExecStart = "${cfg.package}/bin/isled";
        Restart = "on-failure";
      };
      Install.WantedBy = [ "graphical-session.target" ];
    };
  };
}