<div align="center">

# GNOME Island

**A notch-style island for the GNOME desktop.**

System vitals, music with synced lyrics, calls, notifications, a focus timer, reminders, a
calendar that tells you when to join a meeting, a clipboard shelf, app usage,
and Cava visualizer bars, living in a notch at the top of your screen.

[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](LICENSE)
![GNOME Shell 46–51](https://img.shields.io/badge/GNOME%20Shell-46%E2%80%9351-4a86cf.svg)
![Rust 1.92+](https://img.shields.io/badge/Rust-1.92%2B-orange.svg)

</div>

GNOME Island turns the centre of the top bar into a notch.
At rest it shows the time and what is going on (a song, a timer, a
recording, or two of them at once). Rest the pointer on it and it opens with spring physics into a
small panel with tabs for each page; passing over it on the way elsewhere
leaves it closed. Alerts for volume, charging, Caps Lock and notifications
appear in the same place instead of in the middle of the screen.

## Features

- **System monitoring** — CPU usage, frequency, per-core stats, memory, swap, load average, network speed, storage, temperatures, fans, voltages, battery, and GPU (NVIDIA/AMD) with color-coded thresholds
- **Music with synced lyrics** — LRCLIB, NetEase Cloud Music, and Musixmatch (with your own API key)
- **Cava visualizer** — audio bars behind the player and lyrics
- **GNOME adaptive theme** — the island follows your GNOME light/dark preference automatically
- **Richer closed island** — song title and artist scroll in the closed island; timer shows beside music
- **Settings previews** — the island opens briefly to show what a setting changes
- **Keep GNOME's clock** — option to leave GNOME's own clock in the top bar
- **Vertical clipboard with columns** — 1, 2, or 3 columns in vertical clipboard layout
- **GNOME text scaling** — respects GNOME's text-scaling-factor across the UI
- **NixOS flake & Home Manager** — install declaratively on NixOS

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [Settings](#settings)
- [Resource usage](#resource-usage)
- [Data & network](#data--network)
- [Troubleshooting](#troubleshooting)
- [Uninstalling](#uninstalling)
- [How it works](#how-it-works)
- [Contributing](#contributing)
- [License](#license)

## Requirements

- **GNOME Shell 46 to 51** (Ubuntu 24.04 to 26.10, Fedora 40 to 45,
  Debian 13, …), on a 64-bit Intel or AMD PC (x86_64). Check with
  `gnome-shell --version`.
- `curl`, which most systems have (if not: `sudo apt install curl`). Install
  GNOME Island as yourself, not with `sudo`.

## Installation

### Quick install (curl)

1. Run this in a terminal:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/stefan-hacks/gnome-island/main/get.sh | bash
   ```

2. **Log out and back in**: GNOME Shell on Wayland only loads a new
   extension at login (on GNOME 46 to 48 with X11, press Alt+F2, type `r`
   and press Enter instead).

That's all. The script downloads the latest release, checks it, and installs
it for your user only: no root, no compiler and no cloning needed. Run the
same command again to update; your settings stay as you set them.

> [!NOTE]
> The installer never changes other extensions. When one would fight with
> the island (Blur my Shell's top bar blur, or an extension that takes the
> same place in the top bar), it says so and how to turn that off. GNOME Island's
> look is the same on every desktop: a slim top bar with no colour of its
> own, and the island as a black notch.

### NixOS (flake)

Add the flake to your system or Home Manager inputs:

```nix
# flake.nix
{
  inputs.gnome-island.url = "github:stefan-hacks/gnome-island";

  outputs = { self, nixpkgs, home-manager, gnome-island, ... }:
    {
      # NixOS system-wide
      nixosConfigurations.myhost = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        modules = [
          { environment.systemPackages = [ gnome-island.packages.x86_64-linux.gnome-island ]; }
        ];
      };

      # Or Home Manager
      homeConfigurations.username = home-manager.lib.homeManagerConfiguration {
        pkgs = nixpkgs.legacyPackages.x86_64-linux;
        modules = [
          gnome-island.homeManagerModules.default
          {
            programs.gnome-island.enable = true;
            programs.gnome-island.enableUserService = true;
            programs.gnome-island.settings = {
              "org/gnome/shell/extensions/isle" = {
                island-theme = "gnome";
                top-bar-color = true;
              };
            };
          }
        ];
      };
    };
}
```

With the Home Manager module, log out and back in after switching.

To update, run `nix flake update gnome-island` and rebuild.

### Testing in a NixOS VM

You can try GNOME Island in a NixOS VM without touching your running system:

```nix
# vm-test.nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    gnome-island.url = "github:stefan-hacks/gnome-island";
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, gnome-island, home-manager, ... }: {
    nixosConfigurations.test-vm = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        home-manager.nixosModules.home-manager
        {
          services.xserver.enable = true;
          services.xserver.displayManager.gdm.enable = true;
          services.xserver.desktopManager.gnome.enable = true;
          services.displayManager.autoLogin.enable = true;
          services.displayManager.autoLogin.user = "test";

          virtualisation.memorySize = 4096;
          virtualisation.diskSize = 8192;

          users.users.test = {
            isNormalUser = true;
            extraGroups = [ "wheel" "networkmanager" ];
            initialPassword = "test";
          };

          home-manager.users.test = {
            imports = [ gnome-island.homeManagerModules.default ];
            programs.gnome-island.enable = true;
            programs.gnome-island.enableUserService = true;
            programs.gnome-island.settings = {
              "org/gnome/shell/extensions/isle" = {
                island-theme = "gnome";
                top-bar-color = true;
              };
            };
          };

          environment.systemPackages = [ gnome-island.packages.x86_64-linux.gnome-island ];
        }
      ];
    };
  };
}
```

Build and run:

```sh
nixos-rebuild build-vm --flake .#test-vm
./result/bin/run-test-vm
```

Inside the VM, log in as `test` / `test`. The extension is already enabled and the daemon is running. Switch between GNOME light and dark styles in Settings → Appearance → Style to see the adaptive `gnome` theme change in real time.

### From source

For development or other architectures. You need Rust 1.92
or newer (1.88 without the shelf helper) ([rustup](https://rustup.rs); Ubuntu 24.04's own `cargo` is too
old), and for the shelf's drag and drop the GTK 4 development files:

```sh
sudo apt install git build-essential pkg-config libgtk-4-dev
# Fedora: git gcc-c++ pkgconf gtk4-devel
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
git clone https://github.com/stefan-hacks/gnome-island.git
cd gnome-island
./install.sh
```

## Usage

| Do this | To |
|---|---|
| Rest the pointer on the notch | Open the island (or click it, if Settings say so) |
| Click a tab, or scroll or swipe over the tabs | Switch pages (scrolling a page's own content never does) |
| Move the pointer away, or press Esc | Close it |
| Click the notch | Open it now; on an alert, open what it is about |
| Middle-click the notch | Play or pause |
| Rest the pointer on an alert | Keep it until the pointer leaves |
| Swipe up or down on an alert (touchpad) | Put it away, or open it |
| Right-click the notch | Put an alert away; else bring the call, or the music player, to the front |
| Super+V | Open the Calendar page (or the clipboard history, search ready, Enter pastes: Settings → Island → Shortcuts) |
| Ctrl+Tab, Ctrl+1–9 | In the island opened from the keyboard: the next page, or the first to ninth tab |
| Your own shortcut for a page | Open the island on that page from anywhere (Settings → Island → Shortcuts) |
| Drag a file towards the notch | Open the files tray to drop it |

The island reopens on the page you picked last (for five minutes), or on
what is live: a call, unseen notifications, music, a running timer. With two
music players running, the music page shows the other one's icon to switch
to it.

While a window is fullscreen (a video, a game), the island stays out of the
way: alerts, notifications and reminders wait and show once it is gone, and
a burst of notifications comes as one ("6 new notifications"), each still
unread in the list. A reminder stays until you are back at the computer.
While you share or record the screen, alerts leave out what notifications
say, and the clipboard history stays hidden. If GNOME Island's background service
stops, a warning shows in the closed island; click it to start it again.

## Settings

Click the gear right of the clock in the open island (or GNOME Island's gear in the
**Extensions** app):

- **Island:** GNOME Island's own black island, **GNOME** (follows your light/dark preference), or Glass, clear glass that shows what
  is behind it (windows and wallpaper) blurred, with a slider from clear to dark smoked glass; the top bar on a slider from glass (default) to black, and black anyway while a window reaches it (off by default);
  the island's shape, a notch joined to the top or a pill floating free;
  a little space below the island inside the bar (on by default); auto-hide (always, with a top bar that hides, or beside maximized windows; off by default); a 24- or 12-hour clock (or as GNOME's), and the date beside it; a standard or large open island; privacy dots; which pages the open island has (Music,
  Notifications, Timer, Reminders, Shelf, Calendar, Apps, Devices, System, Usage) and whether it
  has the Usage page at all; a shortcut of your own for each page (none at first); world clocks, and their cities;
  the closed island inside the bar or hanging below it; with more than one
  display, on the main one, the one you are using, or all of them; opening when the
  pointer rests on it (and for how long) or only on a click; how long auto-hide waits.
- **Music player:** lyrics from LRCLIB, NetEase Cloud Music, and Musixmatch (with your own API key), each with a switch and order you choose; Cava visualizer bars behind the player and lyrics, with height, opacity, zoom, position, sensitivity, number of bars, smoothness, and audio source settings.
- **System:** CPU usage, frequency, per-core stats, memory, swap, load average, network speed, storage, temperatures, fans, voltages, battery, and GPU (NVIDIA/AMD) with color-coded thresholds.
- **Alerts:** apps' notifications in the island (or GNOME's own banners
  instead); over full-screen apps too (off by default); volume and brightness; charging, network, Bluetooth, a Bluetooth
  device's low battery (off by default) and Caps Lock, each on its own; new songs, sounds; lyrics online;
  a reminder before calendar events, and how many minutes before.
  Alerts other than a low battery are not shown while Do Not Disturb is on.
- **Calls:** show calls in the island, and the live preview of the call.
- **Clipboard:** turn the history on or off, clear it, choose apps whose copies
  are never kept (password managers are on the list from the start), layout (horizontal or vertical), columns (1–3), width and height. What Super+V
  opens (the calendar or the clipboard history) is set with the other shortcuts, in
  Island → Shortcuts.
- **Timer:** session and break lengths, Do Not Disturb while focusing.
- **About:** the version and whether it is up to date (with how to update,
  and the switch for asking GitHub once a day), help, a bug report to copy
  (`isled --report`), and resetting every setting.

## Resource usage

GNOME Island is built to run all day unnoticed. Measured on Ubuntu 24.04 with
GNOME 46 (version 1.0.0):

| Part | Memory | CPU when idle |
|---|---|---|
| `isled` (background service) | about 10 MB resident, of which under 1 MB its own | 0% (no polling: it wakes for real events and deadlines only) |
| Extension, inside GNOME Shell | about 10 MB more for the shell, flat over hours of use | 0% when nothing moves |
| `isle-shelf` (drag and drop) | about 43 MB (GTK 4, drawn on the CPU, no GPU driver loaded); only while the files tray is open, and 20 seconds after | 0% |

Animations run on the display's frame clock only while a spring moves and
stop when it settles: closed and idle, GNOME Island draws no frames at all, and over 40
openings, page changes, lyrics and alerts 99.8% of frames came in time for 60 Hz. The clock wakes once a minute, lyrics exactly when the
next line starts, and pages only tick while they are open; only while the
music page shows does GNOME Island ask the player where it is, once a second. The call preview
reuses the window's picture already on the graphics card, so it costs about
nothing, and only exists while the Call page is open; GNOME Island never opens the
camera or the microphone itself.

## Data & network

GNOME Island has no server and no telemetry; your clipboard history, reminders,
events, timer, and app usage stay in
`~/.local/share/gnome-island`. It goes
online only for synced lyrics ([LRCLIB](https://lrclib.net), then NetEase and,
with your own key, Musixmatch, in the order Settings → Music player gives) and
cover art, once per song (lyrics, and each provider, can be turned off in
Settings); a look for a newer GNOME Island on GitHub at most once a
day (also in Settings). A meeting's link is read
from the event on this computer, and only opened when you click Join.
Sharing the Shelf with your phone runs a small web server on your local
network only while you share: a secret address in the QR code, your Allow on
the island for each phone (matching the code it shows), the Shelf's files and nothing else, and it stops
after 10 idle minutes, on Stop, or when the screen locks
([how it is kept safe](SECURITY.md#sharing-the-shelf-with-a-phone)).
Copies from password managers
are never kept. The call preview is drawn by GNOME
Shell from what is on screen and never recorded.
[SECURITY.md](SECURITY.md#what-leaves-your-computer) lists exactly what is
sent where.

## Troubleshooting

**The island does not appear after installing.** Log out and back in (on
Wayland this is required once). Then check that it is enabled:
`gnome-extensions info gnome-island@stefan-hacks.github.com`.

**Music or lyrics do not show.** Check that the background service runs:
`systemctl --user status isled`, and read its log with
`journalctl --user -u isled -f`. Songs none of the lyrics providers in Settings →
Music player knows show "No lyrics for this song"; a busy service retries on
its own.

**Files cannot be dragged in or out.** The release package includes the
drag-and-drop helper; when building from source, install `libgtk-4-dev`
(Fedora: `gtk4-devel`) and run `./install.sh` again.

**A phone can't open the Shelf.** It must be on the same Wi-Fi as the computer
(not a guest network that keeps devices apart). A firewall that blocks
incoming connections keeps it out too: with ufw, the island offers the
command (**Copy fix**), `sudo ufw allow from <your network> to any port 47830:47839 proto tcp`;
with firewalld on a zone that blocks them (Fedora Workstation's own does not),
`sudo firewall-cmd --permanent --add-port=47830-47839/tcp && sudo firewall-cmd --reload`.
GNOME Island never changes the firewall itself, and listens only while you share.

**Another extension covers the island.** Extensions that restyle or move the
top bar (Dash to Panel, Hide Top Bar, other islands) can get in the way;
turn them off in the Extensions app.

**Something else.** Run `~/.local/bin/isled --report` (or Settings → About → Copy a bug
report): it gathers the versions, what works and recent logs, without your
data. Please [open an issue](../../issues) and paste it there.

With a NixOS package, GNOME Island's commands are on your `PATH`:
run them by name alone (`isled --doctor`, `isled --report`).

## Uninstalling

```sh
~/.local/bin/gnome-island-uninstall
```

(or `./uninstall.sh` from the release package or the source folder). This
removes the extension, the programs, the service, the font, and GNOME Island's caches; it also lifts a battery charge
limit GNOME Island set. Your tasks, calendar events, clipboard history, shelf and
timer settings stay in `~/.local/share/gnome-island` until you delete them.

Remove GNOME Island this way, not with the Extensions app's Remove button, which
deletes only the extension and leaves `isled` behind.

## How it works

```
┌────────────────── isled (Rust) ──────────────────┐
│ MPRIS · lyrics · timer · tasks · calendar · shelf│
│ UPower · NetworkManager · BlueZ · meetings       │
│            exposed on D-Bus (zbus)               │
└────────────────────────┬─────────────────────────┘
           ┌─────────────┴──────────────┐
  GNOME Shell extension (JS)      isle-shelf (Rust, GTK 4)
  draws the island and its        drag-and-drop window laid
  animations                      over the files tray
```

GNOME Shell extensions are written in JavaScript, and on Wayland only the
shell can draw into the top bar. So the extension only draws, and everything
else lives in Rust behind a D-Bus API.

| Path | Contents |
|---|---|
| `crates/isle-core` | Platform-independent logic: LRC parsing, track-title clean-up, Pomodoro, tasks, calendar, shelf, clipboard history. Unit tested. |
| `crates/isle-daemon` | `isled`, the D-Bus service; `src/meeting.rs` meeting links, `src/updates.rs` the look for new versions, and `src/caller.rs` who may call what. |
| `crates/isle-shelf` | `isle-shelf`, the files tray's drag-and-drop window. |
| `gnome-extension` | The GNOME Shell extension. |
| `tests/extension` | Tests of the extension's GNOME-free parts (`node --test`, and `gjs -m` for those that use GLib). |
| `data` | systemd and D-Bus activation files, and the Inter typeface. |
| `scripts` | `isle-charge-limit` and `package.sh`, which makes a release. |
| `docs/product-spec.md` | How the island looks and behaves: sizes, motion, pages, alerts. |
| `docs/dbus-api.md` | The D-Bus interfaces of `isled` and `isle-shelf`. |

## Contributing

Bug reports, ideas and pull requests are welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md) for how to build, test and send changes,
and [CHANGELOG.md](CHANGELOG.md) for what changed. Everyone taking part
follows the [Code of Conduct](CODE_OF_CONDUCT.md); please report security
problems privately as described in [SECURITY.md](SECURITY.md).

## License

Copyright © 2026 stefan-hacks

GNOME Island is free software: you can redistribute it and/or modify it under the
terms of the [GNU General Public License](LICENSE) as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version. It is distributed in the hope that it will be useful, but
WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
FITNESS FOR A PARTICULAR PURPOSE. See the [GNU General Public License](LICENSE)
for more details.

The bundled [Inter](https://rsms.me/inter/) typeface (`data/fonts`) is under
the [SIL Open Font License 1.1](data/fonts/Inter-LICENSE.txt). Lyrics come
from [LRCLIB](https://lrclib.net).
The calendar icon takes its shape
from [Lucide](https://lucide.dev)'s "calendar-days", under the ISC License
([notice](gnome-extension/NOTICE-lucide.txt)).