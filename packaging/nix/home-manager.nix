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
    xdg.dataFile."gnome-shell/extensions/isle@zickrian.github.io".source =
      "${cfg.package}/share/gnome-shell/extensions/isle@zickrian.github.io";

    # Enable the extension via dconf.
    dconf.settings = {
      "org/gnome/shell".enabled-extensions = lib.mkAfter [ "isle@zickrian.github.io" ];
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