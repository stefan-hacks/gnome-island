{
  description = "GNOME Island — a notch-style island for the GNOME Shell top bar";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
  };

  outputs = inputs @ {
    self,
    nixpkgs,
    flake-parts,
    ...
  }:
    flake-parts.lib.mkFlake {inherit inputs;} {
      systems = ["x86_64-linux" "aarch64-linux"];

      perSystem = {
        config,
        self',
        inputs',
        pkgs,
        system,
        ...
      }: let
        version = self.shortRev or self.dirtyShortRev or "dev";
      in {
        packages = {
          gnome-island = pkgs.callPackage ./packaging/nix/package.nix {
            inherit version;
            src = self;
          };
          default = config.packages.gnome-island;
        };

        checks = {
          gnome-island = config.packages.gnome-island;
        };
      };

      flake = {
        homeManagerModules = rec {
          gnome-island = import ./packaging/nix/home-manager.nix;
          default = gnome-island;
        };

        overlays = rec {
          gnome-island = final: prev: {
            gnome-island = self.packages.${prev.system}.gnome-island;
          };
          default = gnome-island;
        };
      };
    };
}
