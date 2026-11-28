# Security policy

## Supported versions

Security fixes go into the latest release. Please update to it before
reporting.

| Version | Supported |
|---|---|
| 1.4.x | Yes |
| 1.3.x and older | No |

## Reporting a vulnerability

Please do not report security problems in public issues.

Report them privately instead, through **Security → Report a vulnerability**
on this repository, or by contacting the maintainer,
[@stefan-hacks](https://github.com/stefan-hacks), through the contact details on that
GitHub profile.

Include what you found, how to reproduce it, and what an attacker could do
with it. You will get a reply within 7 days. Once a fix is released, you are
credited in the changelog unless you would rather not be.

## Verifying a release

Each release's tarball, `.deb` and `.rpm` are built by GitHub Actions from
the tagged source and carry a build provenance attestation. With the
[GitHub CLI](https://cli.github.com):

```sh
gh attestation verify gnome-island-<version>-x86_64-linux.tar.gz --repo stefan-hacks/gnome-island
```

`get.sh` also checks each download against the release's `.sha256`, and the
AUR package `isle-bin` checks the same tarball against the SHA-256 in its
`PKGBUILD`.

## What leaves your computer

Isle runs as your user, with no server of its own and no telemetry. It
connects to the network only for these:

| What | Where to | What is sent |
|---|---|---|
| Synced lyrics | [LRCLIB](https://lrclib.net) (`lrclib.net/api`) | The playing song's title, artist, album and length, once per song (then cached) |
| Synced lyrics, when LRCLIB has none | [NetEase Cloud Music](https://music.163.com) (`music.163.com/api`), asked by the extension | The song's title and artist (to search), then the id of the song found, once per song (then cached). Off until switched on in Settings → Music player |
| Synced lyrics, with a key | [Musixmatch](https://developer.musixmatch.com) (`api.musixmatch.com`), asked by the extension | The song's title, artist and length, with your own API key, once per song (then cached). Off until switched on and skipped without a key; the key is kept in Isle's settings on this computer as plain text |
| Weather | [Open-Meteo](https://open-meteo.com) (`geocoding-api.open-meteo.com`, `api.open-meteo.com`), asked by the extension | The city's name set in Settings (to find its place), then that place's coordinates, only while the Weather page is open and its data is over ten minutes old. Nothing is sent until a city is set |
| Cover art | The address the music player gives for the song's cover | A plain download of that picture, once per song (then cached) |
| New versions | `api.github.com` (Isle's latest release) | A plain request, at most once a day; off when New versions is turned off in Settings |
| Shelf files you share with your phone | Your phone, over the local network, only while sharing (see below) | The names, sizes and contents of the Shelf's files, to a phone you allowed; nothing goes through the internet |
| Events you add to an account's calendar | That account's server (Google, or another in Online Accounts), through Evolution Data Server, as any calendar app sends it | The event's title, day and time, once, when you add it to that calendar (picked with the chip in the add field). Just before, isled opens a connection to that server and closes it, sending nothing, to see it is in reach; behind a proxy it skips that |

Lyrics providers are asked in the order of Settings → Music player, each only if the one before had none, and
all stop with Settings → Island → Alerts → Lyrics. Cava, if you turn it on, listens to what this computer plays, in
its own process and only while its bars are on screen; nothing it hears is kept or sent.

## What stays on your computer

- The clipboard history, shelf, reminders, calendar events kept in Isle (with
  Isle picked, with no account, or waiting for their calendar's server to be
  in reach), timer settings, in `~/.local/share/isle`
  (readable by you only).
- Caches of covers and lyrics, in `~/.cache/isle`.
- What your login shell sets: once at start, isled runs your shell as a login shell to read its environment,
  and keeps only `PATH`, proxy and certificate settings. They stay in isled's memory.
- The call preview: GNOME Shell draws it from the call's window as it is on
  screen; nothing is recorded, and it hides while you share your screen.
- Meeting links: read from the event in your desktop calendars (Evolution
  Data Server) on this computer, and opened in your browser only when you
  click Join.

## Clipboard history

The history keeps text, links, images and files you copy, on this computer
only, and can be turned off in Settings. Copies marked as secrets by password
managers (`x-kde-passwordManagerHint`), and every copy from the apps on the
ignore list (KeePassXC, Bitwarden, 1Password, Secrets, Seahorse, Proton Pass
by default; editable in Settings), are never kept. When the password manager
quits, GNOME puts its last copy back without the mark; to leave that out too,
Isle keeps a salted hash of the secret in memory until the next copy, never
the secret itself. Clearing the history deletes its files.

## Sharing the Shelf with a phone

**Phone** on the Shelf's Files tab opens a small web server in `isled` so a
phone on the same network can save the Shelf's files and send files to it, in
its browser. It is plain HTTP on the local network; this is what keeps it
safe:

- **Off unless you start it.** Nothing listens until you press Phone, and the
  server closes when you press Stop, after 10 minutes without a download, an
  upload, a phone picking files to send or an Allow (a page left open and
  checking for changes does not count, nor anything a phone not yet allowed
  does; a transfer under way does), when the screen locks, when the computer sleeps, when Isle is
  turned off, when GNOME Shell leaves the bus, and when its network changes:
  its address gone from its interface, or the connection active on that
  interface another, even with the same address (another device taking the
  default route, a VPN, or NetworkManager restarting change nothing). A phone whose page closed or went
  quiet for 90 seconds (4 after a goodbye) shows as away on the island, still
  in and still counted, with its × to take it off; back with its cookie from
  the same address, it is in without a new Allow, until sharing stops. An
  address makes one new phone per 2 minutes, and phones that ended are kept
  16 at most.
  A new start has a new token: an old address never works again. Only GNOME Shell can start
  or stop it, read its address, or answer or take off a phone.
- **On the local network only.** It listens on one IPv4 address, the one of
  the network your default route goes through (never `0.0.0.0`, never a
  container, VM or VPN interface), on a random port from 47830 to 47839 (with
  all ten taken, sharing doesn't start), and closes without a word any
  connection from outside that network, and from this computer's own
  addresses: a program here could otherwise use an address it read. The
  island warns when the address is public ("This network looks public"), when
  NetworkManager reports Wi-Fi without a password ("Open Wi-Fi"), and when it
  can't tell ("Only share on a network you trust"), and suggests the phone's
  hotspot.
- **A secret in the address.** The QR code's address carries a fresh random
  token of 128 bits (from the kernel's `getrandom`) for each sharing, so an
  address kept in the phone's history is worthless once sharing stops; it is
  compared in constant time. The address is not in `Share1.State`, which any
  program on the session bus can read: GNOME Shell asks for it (`Code`), and
  nobody else gets it. Every request without the token (a wrong one, any
  other path, a `Host` other than the address itself) gets the same plain
  `404 Not found`, and an address that tries 20 wrong tokens is shut out until
  sharing stops (a browser's own `/favicon.ico` doesn't count).
- **You allow each phone, by its code.** The first time a browser connects,
  its page shows a four-digit code, big, and the island asks with the same
  code: "Allow iPhone · Safari — code 4821?", with the phone's address (on
  the Phone tab, a row with Deny and Allow for each phone asking; and as an
  alert). The browser's name comes from its user agent, which anyone can
  claim, so the code is what tells the phone in your hand from another: Allow
  answers the phone of its own row or alert, never whichever asks first. Until
  allowed, a phone sees nothing of the Shelf. The answer is tied to a cookie
  (`HttpOnly`, `SameSite=Strict`), a secret only that phone has (the island
  knows the phone by another id), and to the phone's address. A phone turned
  down, or taken off with × on the Phone tab, is told so and can't ask again
  until sharing stops (taken off, its downloads and uploads stop at their
  next piece, a file half received deleted); at most three phones may be asking or allowed at once,
  and an ask goes unanswered after two minutes. The name shown is one of a few
  fixed words, never the browser's own text.
- **The Shelf, nothing else.** The page lists only the files on the Shelf
  (not folders, and not one whose disk doesn't answer within 2 seconds, such
  as a network mount gone away), each by an id made from the token and its
  address; a file is only ever found by that id among the Shelf's current
  items, never from a path in the request, so `..`, `%2e%2e` and the like lead
  nowhere. Files are opened without waiting (a pipe is no file), sent as
  attachments with their type, `X-Content-Type-Options: nosniff` and a
  `sandbox` content security policy; only JPEG, PNG, GIF and WebP may open in
  place, never SVG or HTML. Pictures' previews are the island's own.
- **Files sent in are kept apart.** They are streamed to disk as they come
  (never held in memory), through the file created for them (new, private,
  never one already there), into the Shelf's own folder,
  `~/.local/share/isle/shelf`, readable by you only; once whole they are
  renamed without ever replacing a file (`RENAME_NOREPLACE`) and put on the
  Shelf in one step that stopping sharing can't cut half way. The name is the
  last part of the one the phone gives, without control, invisible, line- or
  text-direction characters or leading dots, at most 200 bytes, numbered
  ("photo 2.jpg") when taken. A file cut short is deleted, and so is one whose
  phone was taken off meanwhile. Taking it off the Shelf deletes it, as with
  clipboard images. Limits: the Shelf's six files, 4 GB a file, 8 GB a
  session, and 1 GB left free on the disk, counting what uploads under way
  will still bring; the free space is looked at again every 32 MB as a file
  comes, and below half a gigabyte the upload stops.
- **A small server.** One request per connection, heads of at most 8 KiB (one
  `Host`, a `Content-Length` of digits only), bodies only with a
  `Content-Length` (no chunked encoding), 3 seconds for a request's first
  byte and 10 for its head, 30 for each step of a transfer and, after its
  first 30 seconds, at least 16 KiB a second on average, so no trickle holds a
  connection or keeps sharing going; 6 connections at once per address and 32
  in all; 60 requests in a burst then 20 a second per address. A page waiting
  for changes gives its connection back as soon as it goes away. A refused
  upload has its body read and dropped for up to 2 seconds, so the phone sees
  why rather than a broken connection. The page is one file built into
  `isled`, with no outside scripts, styles or fonts, a strict content security
  policy (its own script and style by a fresh nonce, connections to itself
  only) and no referrer. `isled` runs as you; it never needs or asks for more.

If ufw is on and drops what it is not told to let in, phones can't reach the
server; the island then offers the command that lets in the local network on
those ports (`sudo ufw allow from <network> to any port 47830:47839 proto
tcp`), until a phone gets through. Isle never changes the firewall itself.

## Scope

Areas where a report is especially welcome:

- `isled`'s D-Bus API on the session bus (`docs/dbus-api.md`): input that
  crashes it, or reads or changes data it should not.
- The calendar: an event sent to a calendar you didn't pick, or one you
  deleted in Isle left in your account's calendar.
- The clipboard history in `~/.local/share/isle`: copies kept from apps on
  the ignore list or marked as secrets, or files readable by other users.
- Network requests: anything sent beyond what the table above lists.
- `isle-shelf`: files it opens or exposes that the user did not drop on it.
- The installers and packages (`get.sh`, `install.sh`, the `.deb`, `.rpm`
  and AUR package): files written outside the places they document.
