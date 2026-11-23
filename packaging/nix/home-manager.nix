# Home Manager module for Isle
#
# Usage in your home-configuration.nix:
#   imports = [ inputs.isle.homeManagerModules.isle ];
#   programs.isle.enable = true;
#
{ self }:

{ config, lib, pkgs, ... }:

let
  cfg = config.programs.isle;
  pkg = self.packages.${pkgs.system}.isle or (pkgs.callPackage ./package.nix { });
in

{
  options.programs.isle = {
    enable = lib.mkEnableOption "Isle GNOME Shell extension";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkg;
      description = "The Isle package to install.";
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
            voice-assistant = true;
            voice-provider = "hermes";
          };
        }
      '';
      description = ''
        GSettings overrides for Isle, keyed by schema id.
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
    home.file."$XDG_DATA_HOME/gnome-shell/extensions/isle@zickrian.github.io".source =
      "${cfg.package}/share/gnome-shell/extensions/isle@zickrian.github.io";

    # Enable the extension via dconf.
    dconf.settings = {
      "org/gnome/shell".enabled-extensions = lib.mkAfter [ "isle@zickrian.github.io" ];
    } // lib.optionalAttrs (cfg.settings != { }) cfg.settings;

    # Enable the user service if requested.
    systemd.user.services.isled = lib.mkIf cfg.enableUserService {
      Unit = {
        Description = "Isle daemon";
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
