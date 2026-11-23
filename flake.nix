{
  description = "Isle — a notch-style island for the GNOME Shell top bar";

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
          isle = pkgs.callPackage ./packaging/nix/package.nix {
            inherit version;
            src = self;
          };
          default = config.packages.isle;
        };

        checks = {
          isle = config.packages.isle;
        };
      };

      flake = {
        homeManagerModules = rec {
          isle = import ./packaging/nix/home-manager.nix self;
          default = isle;
        };

        overlays = rec {
          isle = final: prev: {
            isle = self.packages.${prev.system}.isle;
          };
          default = isle;
        };
      };
    };
}
