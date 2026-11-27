# isled D-Bus API

`isled` owns `io.github.stefanhacks.gnomeisland.Daemon` on the session bus and serves every
interface at `/io/github/stefanhacks/gnomeisland/Daemon`. State is exposed as read-only string
properties holding JSON, with `PropertiesChanged` emitted on every change.
Timestamps are milliseconds since the Unix epoch; durations are
milliseconds unless the name says `_us` (microseconds).

Methods that read what the user copied (`Clipboard1.GetText` and `Search`) or share
with a phone (`Share1.Start`, `Stop` and `Answer`) answer GNOME Shell only, where the extension runs; any other caller gets
`org.freedesktop.DBus.Error.AccessDenied`.

`isled --version`, `isled --doctor` (whether the service runs) and
`isled --report` (that, the versions and recent logs, for a bug report) print
and exit. A second
`isled` started by hand exits at once ("already running") and leaves the
running one alone.

## io.github.stefanhacks.gnomeisland.Media1

The active MPRIS player: the one picked with `Choose` while it runs, else the one playing, else the one
that played last, a paused song before a browser's media that rests. Another player starting to play ends
the pick. A player put away with `Dismiss` is left out until it plays again.

| Member | Signature | |
|---|---|---|
| `PlayPause()`, `Next()`, `Previous()` | | Control the active player. |
| `SetPosition(x position_us)` | | Seek to an absolute position. |
| `Raise()` | | Bring the player's window to the front. |
| `Choose(s name)` | | Show and control the player `name` (from `Players`). |
| `Dismiss()` | | Put the active player away until it plays again (the Music page's ×); another shows, or none. |
| `SetLyrics(b enabled)` | | Look lyrics up online (LRCLIB), or not; off, `Lyrics` says `off`. The extension sends its setting whenever isled appears. |
| `SetWatching(b watching)` | | While on, read the active player at once and then every second it plays (every 0.35 s to confirm a read that fell behind or while it buffers, every 0.5 s after a read that was off or while a new speed is measured, every 10 s after a read failed). The extension turns it on only while the open island shows the position (the player or lyrics), and sends it again whenever isled appears; off, isled sets no timer at all. |
| `NowPlaying` | `s` | `{available, identity, desktop_entry, status, title, artist, album, art_path, length_us, position_us, sampled_at_ms, rate, can_go_next, can_go_previous, can_play_pause, can_seek, resting}`; `resting`: a browser's media that is over (paused at its end, or paused for a minute), which the closed island leaves out |
| `Lyrics` | `s` | `{track, status, lines: [{time_ms, text}]}`; `status` is `none`, `loading`, `synced`, `plain` (lines have `time_ms` -1), `instrumental`, `not_found`, `error` (LRCLIB could not be reached), `unavailable` (LRCLIB answered but is busy or failing) or `off` (turned off with `SetLyrics`); isled retries `error` and `unavailable` on its own. |
| `Players` | `s` | `[{name, identity, desktop_entry, playing, active}]`, sorted by name; empty unless two or more players run. |

The position is sampled when something changes, and while watched (see
`SetWatching`) every second as well: MPRIS signals no progress, and players
signal stalls, ads and seeks made inside them unreliably. While playing, the
current position is `position_us + (now - sampled_at_ms) * 1000 * rate`.
A player that reports position 0 while it is still playing (Firefox and Zen do)
does not move that sample; a `Seeked` signal does, and its position is the one
kept. A browser's read more than 1.5 s behind the sample is kept only once the
next read moved on from it at a speed a player plays at (a stall, not a stale
read); so is a 0 from any player's poll. Firefox reads whole seconds, cut
down: once three reads in a row are whole seconds, a read moves the sample
only when the sample falls outside the second after it. `rate` is the player's `Rate`, unless
two agreeing steps between reads show another speed (0.25–4, a player that keeps
`Rate` at 1 while it plays faster); that measure ends with a seek, a pause, the
song or a new `Rate`. While two reads in a row stand at the same place though
the player says it plays (buffering), `rate` is 0 until a read moves on. A length that disappears for the same track is kept.
While playing with no length yet, isled reads the player again after 1s and
after 3s. A relative seek, used when the player gives no track id, is measured
from this position when the player's own `Position` read is 0.

The control methods only fail when no player is running. They return
without waiting for the player, so a slow player cannot hold the daemon up;
if the player then rejects the command, isled only logs it.

## io.github.stefanhacks.gnomeisland.Pomodoro1

| Member | Signature | |
|---|---|---|
| `Start()` | | Start a focus session, or resume a paused phase. |
| `StartPhase(s phase)` | | Start `focus`, `short_break` or `long_break` right away (`idle` stops). |
| `Pause()`, `Stop()`, `Skip()` | | `Skip` ends the phase early without counting it. |
| `SetConfig(s json)` | | Replace the configuration (below). |
| `State` | `s` | `{phase, running, ends_at_ms, started_at_ms, remaining_ms, duration_ms, completed_sessions, sessions_before_long_break, today_sessions, today_focus_ms}`; `phase` is `idle`, `focus`, `short_break` or `long_break`; `started_at_ms` is when the phase first ran, null while it waits to be started (a focus session after a break, without `auto_start_focus`). |
| `Config` | `s` | `{focus_minutes, short_break_minutes, long_break_minutes, sessions_before_long_break, auto_start_breaks, auto_start_focus}` |
| `PhaseFinished(s finished, s next)` | signal | A phase ran out (not emitted for `Skip` or `Stop`). |

## io.github.stefanhacks.gnomeisland.Todo1

| Member | Signature | |
|---|---|---|
| `Add(s text) → t id` | | Adds a task; a blank title is refused. |
| `SetDone(t id, b done)`, `Rename(t id, s title)`, `Remove(t id)`, `ClearDone()` | | Finished tasks are cleared at midnight. |
| `Items` | `s` | `[{id, title, done, done_at_ms}]`; `done_at_ms` is when the task was ticked off, or null. |

## io.github.stefanhacks.gnomeisland.Calendar1

Isle's own calendar events, kept in `~/.local/share/isle/calendar.json`.
Times are local wall-clock times. (Events of the desktop's calendars come
from GNOME Shell, not from here.)

| Member | Signature | |
|---|---|---|
| `Add(s date, s text) → t id` | | Adds an event on `date` (`YYYY-MM-DD`) from a line of text, taking its time from it: `Dinner 8:00 pm`, `Standup 9:00-9:15`, `Gym at 7pm`; without a time it lasts all day. A date that does not exist, or no title left, is refused with `InvalidArgs`. |
| `AddTo(s calendar, s date, s text) → s` | | As `Add`, to a desktop calendar: a uid `Calendars` lists, or `"isle"` for Isle's own; `""`, or a uid no longer there, tries each account calendar in order (without waiting on which only read: one that does turns the event down). When none takes it (read only, offline, signed out) the event is kept in Isle's own instead. A calendar out of reach (EDS offline, or its server not taking a TCP connection within 3 seconds; behind a proxy, EDS's word is taken) isn't written to, as EDS would only queue the event: the event waits in Isle's own (its `send`) and isled tries it again every 30 seconds with the same iCalendar uid, so it never lands twice; once there it leaves Isle's own. It stays in Isle's own for good when its calendar goes, or turns it down 10 times running. One its server had, with no answer within 20 seconds, counts as added, so it never shows twice; one still on its way to the server by then waits in Isle's own as above. Returns where it went: the calendar's uid, or `""` for Isle's own. |
| `Calendars() → s` | | The desktop's calendars a new event can go to, `[{uid, name, account, color}]` by account (its own calendar first) and name: those of Online Accounts and other accounts in Evolution Data Server, without the ones that only read (birthdays, weather, web subscriptions, and any EDS reports as not `Writable`, such as a subscribed holiday calendar) nor EDS's own on this computer. `[]` without accounts; fails (Failed) while EDS can't be asked (not running yet), so that is never taken for no accounts. |
| `Colors() → s` | | Every desktop calendar's colour, `{uid: "#rrggbb"}`, read only ones too: GNOME Shell's events name their calendar's uid on the first line of their id. `{}` without EDS. |
| `Parse(s text) → s` | | How `Add` reads `text`, without adding it: `{title, start, end}`, times as `HH:MM` or null. Fails (InvalidArgs) when no title is left. |
| `Remove(t id)` | | One waiting to be sent is taken out of its calendar too, in case a try with no answer got it there. |
| `MeetingLink(s source_uid, s event_uid) → s` | | The meeting link of a desktop calendar's event (the first two lines of the id GNOME Shell's calendar server gives it), or `""`. |
| `Events` | `s` | `[{id, title, date, start, end, send?}]` by day and time; `start` and `end` are `HH:MM` or null (all day; no end given); `send` (`{calendar, uid}`) on one waiting to go to a desktop calendar out of reach (see `AddTo`). Events over 400 days old are forgotten. |

`AddTo` writes through Evolution Data Server: `CalendarFactory.OpenCalendar`,
`Calendar.Open`, `CreateObjects([event], 0)` and `Close`, each step given five
seconds. The event is one `VEVENT` with its times in UTC (an hour long without
an end; a whole day without a time). `Calendars` reads the sources from
`org.gnome.evolution.dataserver.Sources5` (`ObjectManager.GetManagedObjects`),
leaving out those turned off, and those of an account whose calendars are off.
Each one left is opened once (`OpenCalendar`, and `Calendar.Open` when it
reads as read only, then asked again for up to 3 seconds, as a calendar just
opened reads as read only until it has reached its server) for its `Writable`
property. Writable is remembered while isled runs; read only, for an hour, and
only from a server that takes a connection (out of reach, EDS calls a calendar
read only for now).

`MeetingLink` reads the event from Evolution Data Server
(`org.gnome.evolution.dataserver.Calendar8`, else `Calendar7`:
`CalendarFactory.OpenCalendar`, then `Calendar.Open`, `GetObject(uid, "")` and
`Close`) and looks in its `X-GOOGLE-CONFERENCE`, `URL`, `LOCATION` and
`DESCRIPTION`, in that order, for the first `https://` link to Google Meet
(`meet.google.com`), Zoom (`zoom.us` or `*.zoom.us`, `/j/`, `/my/` or `/w/`),
Microsoft Teams (`teams.microsoft.com/l/meetup-join/` or `/meet/`,
`teams.live.com`) or Webex (`*.webex.com`). Answers are kept for six hours (at
most 256 events). Without EDS (not installed, masked or not answering within
five seconds) it is `""`; empty or over-long ids are refused with
`InvalidArgs`.

## io.github.stefanhacks.gnomeisland.Shelf1

| Member | Signature | |
|---|---|---|
| `Add(as uris)` | | Add local `file://` URIs (moved to the front if already there). The shelf holds 6 files: files that do not fit are refused with `LimitsExceeded`. Other URIs are skipped and reported with `InvalidArgs` once the rest are added. |
| `Remove(s uri)`, `Clear()` | | |
| `Refresh()` | | Drop items whose files no longer exist, shortly after it returns. A file that does not answer within two seconds (a network mount gone offline) stays. |
| `Items` | `s` | `[{uri, name, added_at_ms}]`, newest first. |

Files a phone sends (see `Share1`) are kept in the shelf's own folder,
`~/.local/share/isle/shelf`, as copied clipboard images are; taking one off
the shelf deletes it.

## io.github.stefanhacks.gnomeisland.Share1

Sharing the shelf with a phone (see SECURITY.md). While it runs, isled serves
one web page and the shelf's files over plain HTTP on the local network; off,
nothing listens and nothing runs.

| Member | Signature | |
|---|---|---|
| `Start()` | | Starts sharing, or keeps the session already running. It listens on one IPv4 address: the one on the interface of the default route (not a container's, VM's or VPN's), private first, Wi-Fi first; on a random port from 47830 to 47839. Fails (`Failed`, with words for the island) without a network, or with all ten ports taken. GNOME Shell only. |
| `Stop()` | | Stops sharing: the port closes, transfers under way end, pages say it stopped. GNOME Shell only. |
| `Code() → s` | | `{url, qr}`: the address with its token (`http://<address>:<port>/<token>`) and its QR code (level L, without the quiet zone) as rows of `0` and `1` (dark). Kept out of `State`, which any program on the bus can read. Fails while not sharing. GNOME Shell only. |
| `Answer(s id, b allow)` | | Allows or turns down the phone `id` in `asking`, and only that one; turned down, it is told so and its address can't ask again until sharing stops. `InvalidArgs` when no such phone asks. GNOME Shell only. |
| `Remove(s id)` | | Takes the allowed phone `id` off: it sees nothing more, its downloads and uploads stop at their next piece (a file half received is deleted), it is told so, and its address can't ask again until sharing stops. `InvalidArgs` when no such phone is in. GNOME Shell only. |
| `State` | `s` | No secret in it. Off: `{active: false, ended}`, `ended` being why the last session ended (`stopped`, `idle`, `locked`, `asleep`, `gone`, `network`: its address left the computer) or null. On: `{active: true, session, network, firewall, asking, phones, idle_minutes}`: `session` counts sessions (a new one has a new `Code`); `network` is `home`, `open` (Wi-Fi without a password, or OWE), `public` (a public address) or `unknown` (NetworkManager could not say); `firewall`, while ufw is on with a dropping input policy and no phone has got through yet, the command that lets the local network in, else null; `asking` is `[{id, device, address, code}]`, the phones waiting for an answer with the four digits each one's page shows; `phones` is `[{id, device, address, code, here}]`, those allowed. A phone is `here` while its page polls, it moves a file, its page is behind the phone's file picker (up to 5 minutes, said by `api/picking`), or it asked anything in the last 90 s; after a goodbye, 4 s unless it is back (a reload). Away (`here` false) it is still in, still counted, and back without a new Allow when it returns with its cookie from the same address; `Remove` takes it off. An ask lives its full 2 minutes, unless its page said goodbye. An address makes one new phone per 2 minutes, and phones that ended are kept 16 at most. `id` is the island's handle on a phone, never its cookie; `device` is one of a few fixed names ("iPhone · Safari", "Android phone · Chrome"). At most three phones asking or allowed. |
| `Received(s name)` | signal | A file from a phone landed on the shelf under `name`. |

Sharing ends on its own after 10 minutes without a download, an upload, a
phone picking files to send or an Allow (a page open and polling, its hellos
and goodbyes don't count; a transfer under way holds it), when
the screen locks (logind's `LockedHint`), when the computer goes to sleep, and
when the caller of `Start` leaves the bus, and when its network is not the one
it started on: its address gone from its interface, or the connection active
on that interface another, even with the same address (looked at as
NetworkManager reports a change; no polling; another device taking the default
route, a VPN or NetworkManager restarting change nothing, and no answer is
taken as no change).
The extension calls `Stop` when it is turned off.

The phone's side, all under `/<token>`: `GET /<token>` the page; `POST
api/hello` asks to connect (sets the `isle` cookie, `HttpOnly`,
`SameSite=Strict`; answers `{status, code}`, `status` being `asking`,
`allowed`, `denied`, `removed` or `expired`, or `403 {status: denied | busy}`,
or `403 {status: later, wait}` for a new phone from an address that made one
less than 2 minutes ago, `wait` the seconds left);
`GET api/state?v=<n>` where the phone stands (`code` while it asks) and, once
allowed, the shelf (`{v, status, items: [{id, name, size, kind, thumb, view}],
room, capacity, max_file, left}`), held up to 25 s until `v` changes or the
page goes; `POST api/bye` the page is going (closed, reloaded); `POST api/picking` the page goes behind the phone's file picker; `GET f/<id>` a file (`?view=1` shows a JPEG, PNG, GIF or WebP in
place); `GET t/<id>` a picture's preview (the extension's own, in
`~/.cache/isle/shelf`); `PUT api/upload?name=<name>` a file as the body, with
a `Content-Length`, answered `201 {name}` or `400 incomplete`, `403
not-allowed`, `409 shelf-full`, `411 length`, `413 too-big` or
`session-full`, `507 disk`. Every other request is `404 Not found`.

## io.github.stefanhacks.gnomeisland.Clipboard1

Clipboard history. The extension watches the clipboard and reports each
copy; isled keeps the list in `~/.local/share/isle/clipboard.json` and
images in `~/.local/share/isle/clips` (`<hash>.png` as copied, plus a
`<hash>.card.png` thumbnail: the middle of the image cut to the card's shape
at 272×216, or at its own pixels when too small or thin to fill that).
Thumbnails older versions made (`<hash>.thumb.png`) are made again shortly
after isled starts. `app_id` is the desktop app id of the app copied from,
or `""`.

| Member | Signature | |
|---|---|---|
| `AddText(s text, s app_id) → t id` | | Copied text, at most 512 KiB and not blank. A lone `http://` or `https://` address is a `link`. |
| `AddImage(ay png, s app_id) → t id` | | A copied PNG image, at most 16 MiB. |
| `AddFiles(as uris, s app_id) → t id` | | Copied files; only `file://` URIs. |
| `GetText(t id) → s` | | The full content to copy back: the text, the URIs one per line, or the path of an image's PNG. GNOME Shell only. |
| `Search(s query) → at ids` | | The items whose whole text (or files' names) holds `query`, ignoring case, in the list's order; images match nothing. Only ids, never the text. GNOME Shell only. |
| `Touch(t id)` | | Move to the top, as copied again (e.g. from the history). |
| `SetPinned(t id, b pinned)` | | At most 10 items are pinned; pinning an eleventh fails with `LimitsExceeded`. |
| `Remove(t id)` | | |
| `Clear()` | | Remove every item that is not pinned. |
| `Items` | `s` | `[{id, kind, preview, uris, image, thumb, thumb_width, thumb_height, width, height, app_id, at_ms, pinned}]`, newest first. `kind` is `text`, `link`, `image` or `files`; `preview` is the first 160 characters of a text, or the file names one per line; `uris` is empty except for files; `image` and `thumb` (paths), `width` and `height` are null except for images; `thumb` is null, and `thumb_width` and `thumb_height` too, while the thumbnail is being made again, and the two sizes are null while an older one stands in; `at_ms` is when it was last copied. |

Adding something already in the history (the same text, image or list of
files) moves that item to the top and returns its id; it stays pinned if
it was. Beyond 20 unpinned items the oldest are
dropped; pinned items are only removed by hand. Unknown ids and invalid
content are rejected with `InvalidArgs`.

## io.github.stefanhacks.gnomeisland.Reminders1

Reminders, kept in
`~/.local/share/isle/reminders.json`. The extension shows each as an alert
when it is due, then dismisses it.

| Member | Signature | |
|---|---|---|
| `Add(t delay_ms, s text) → t id` | | A reminder due `delay_ms` from now. |
| `Dismiss(t id)` | | Forgets one, once shown (or cancelled). |
| `Items` | `s` | `[{id, text, due_ms}]`, soonest first. |

## io.github.stefanhacks.gnomeisland.AppUsage1

Time spent in each application, timed by the extension as GNOME's focus
changes and kept in `~/.local/share/isle/app-usage.json` for 30 days. Only
the application in front is timed, whether or not there is keyboard or
pointer input; it stops when focus moves, when no window is in front, or
when the screen locks. Five minutes without input pause it too, unless a
program holds the session from going idle (a video playing does). The
extension keeps the stretches and reports them at most once a minute, when
the Apps page opens and when timing stops; turning the Apps page or its
switch in Settings off stops the timing.

Every method is GNOME Shell's: the history names every app the user ran.

| Member | Signature | |
|---|---|---|
| `Report(a(ssxx) stretches)` | | Adds timed stretches, each `(app_id, name, start_ms, ms)`: `app_id` is the desktop id (or `window:<wmclass>` when the app has no desktop file), `start_ms` when the stretch began in milliseconds since the Unix epoch, and `ms` how long it lasted. Stretches past local midnight are split between the days. At most 1,000 fit in one call; a blank id, a start before 1970, or a time not between 1 ms and 24 hours refuses the whole batch with `InvalidArgs`. |
| `GetStats() → s` | | `{today: [{id, name, ms}], week: [{id, name, ms}], month: [{id, name, ms}]}`, most used first; `week` is the last seven days including today, and `month` the last 30 (all that is kept). |
| `Clear()` | | Forgets every day. |

## io.github.stefanhacks.gnomeisland.Updates1

Whether a newer Isle is out: GitHub's latest release, looked up at most once a day while enabled.

| Member | Signature | |
|---|---|---|
| `SetEnabled(b enabled)` | | Look, or not (Settings → New versions); off until set. |
| `Latest` | `s` | The latest release's version (`0.8.0`) when it is newer than this isled; empty otherwise. |

## io.github.stefanhacks.gnomeisland.System1

| Member | Signature | |
|---|---|---|
| `State` | `s` | `{battery: {percent (a whole number), plugged, charging} or null, network: {connected, connection, name}, bluetooth: [{path, name, icon, battery}], camera_in_use}` |
| `Event(s json)` | signal | One of `{kind: "power", plugged, percent}`, `{kind: "battery_low", percent}`, `{kind: "battery_full"}`, `{kind: "network", connected, connection, name}`, `{kind: "bluetooth", connected, device}`, `{kind: "bluetooth_low", device}` (a connected device's battery went under 20, 10 or 5%, `device.battery` its level now: once per level on the way down, again once it has charged more than 5 points above it). |

## io.github.stefanhacks.gnomeisland.ShelfWindow1

Served by `isle-shelf` (not `isled`) as `io.github.stefanhacks.gnomeisland.ShelfWindow` at
`/io/github/stefanhacks/gnomeisland/ShelfWindow`.

| Member | | |
|---|---|---|
| `Show(i x, i y, i width, i height)` | | Show the shelf window over this area, in logical pixels. |
| `ShowOver(i x, i y, i width, i height, i ax, i ay, i awidth, i aheight)` | | While a file is dragged in: the window covers the whole island (the first four), so a drop lands anywhere on it, with the files in the tab's area inside it (the last four). |
| `Hide()` | | |
| `Scale()` | → `i` | The scale GTK draws the window at: X pixels per logical one. |
| `SetScale(i scale)` | | Draw at this scale (1 to 4) from now on: the extension sets it when the window comes out another size than asked, as when GTK started before GNOME told X11 apps the display's scale. |
| `SetDropping(b dropping)` | | A file is being dragged towards the island: show where it will land. |
| `Hovering` | signal `as uris` | The files dragged over the window, for the island to light in their colours; empty once they leave. |
| `SetSaves(b saves)` | | 1.5.4: the extension saves files on `Save`; until it says so (an older one), the helper shows no ↓. The extension says it whenever the helper starts. |
| `Save` | signal `s uri` | 1.5.4: ↓ was pressed on a file the shelf keeps itself (in isled's shelf folder); the extension copies it into Downloads, as from its own tile, and only such a file. |
