// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 stefan-hacks

// Decides what the island shows and when (compact, peek or expanded); see docs/product-spec.md.
// Alerts show one at a time; "instant" ones (volume, brightness, critical...) replace what is showing.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import * as Alerts from './alerts.js';
import {AppUsage} from './appUsage.js';
import {ClipboardHistory} from './clipboard.js';
import {CompactView} from './compact.js';
import {HAS_ACCENT, grabsKeyboard, inhibitScanout, isWayland, onUiScale, px, uiScale} from './compat.js';
import * as Palette from './palette.js';
import {Daemon} from './daemon.js';
import {BOTTOM_PADDING, ExpandedView, PAGE_HEIGHT} from './expanded.js';
import {Island} from './island.js';
import {PREVIEWED_KEYS, previewTarget} from './previewMap.js';
import {LyricsEngine} from './lyricsEngine.js';
import {createLyricsCache} from './lyricsCache.js';
import {createHttp} from './lyricsHttp.js';
import {MirrorIsland} from './mirror.js';
import {AudioOutputs} from './audio.js';
import {CallMonitor} from './call.js';
import {FocusMode} from './focusMode.js';
import * as Format from './format.js';
import {refreshClocks} from './wallClock.js';
import {NotificationCenter} from './notifications.js';
import {PrivacyMonitor} from './privacy.js';
import {PeekView} from './peek.js';
import {pageOrder} from './pageOrder.js';
import * as Playback from './playback.js';
import {KeyboardWatcher, OsdHook, REACH_PX, TopBar, windowAtTop} from './shell.js';
import {ShelfHelper} from './shelfHelper.js';
import {isShelfCopy, saveToDownloads, showInFiles} from './downloads.js';
import {AppsPage} from './pages/apps.js';
import {CallPage} from './pages/call.js';
import {CalendarPage} from './pages/calendar.js';
import {DevicesPage} from './pages/devices.js';
import {MediaPage} from './pages/media.js';
import {NotificationsPage} from './pages/notifications.js';
import {ShelfPage} from './pages/shelf.js';
import {SystemPage} from './pages/system.js';
import {TasksPage} from './pages/tasks.js';
import {TimerPage} from './pages/timer.js';
import {ReminderWatcher} from './reminders.js';
import * as Theme from './theme.js';
import {autoHide, revealBand} from './visibilityRules.js';

/** While the pointer rests before the island opens (Settings: hover-delay), it moves at most this far (CSS px). */
const REST_DISTANCE_PX = 10;
/** The views and pages are laid out ahead this long after starting, a step at a time (see `_warmUp`). */
const WARM_START_MS = 3000;
const WARM_STEP_MS = 60;
// A ring alert's parts, the alert views' warm-up (see `_warmUp`). Its words are blank, figure spaces as wide
// as real ones, so nothing readable could ever show even if a frame caught it.
const WARM_ALERT = {key: 'warm', title: '\u2007'.repeat(8), subtitle: '\u2007'.repeat(4), icon: 'isle-bolt', ring: 0,
    value: '\u2007'.repeat(3), tone: 'neutral'};
/** And again this long after the island closes, or a page changes out of sight, while it stays closed... */
const WARM_AFTER_CLOSE_MS = 1500;
/** ...but for changes, at most this often: a notification updating every second (a download) costs little. */
const WARM_GAP_MS = 10000;
/** Outside an island that shrank under it, the pointer is checked this often, and left this long. */
const MOVE_CHECK_MS = 250;
const STILL_OUTSIDE_MS = 30000;
/** Grace period before closing when the pointer leaves. */
const COLLAPSE_DELAY_MS = 300;
/** A preview of a setting (see `_previewSetting`) closes this long after the last change, and the music page goes
 * back to its mode this long after that, once it has closed. */
const PREVIEW_MS = 4500;
const PREVIEW_RESTORE_MS = 700;
/** An alert the pointer rested on stays this long once it leaves, to finish reading. */
const ALERT_LEAVE_MS = 1500;
/** Touchpad travel over an alert that puts it away (up) or opens the island (down); a wheel's click is one. */
const ALERT_SWIPE = 1.5;
/** A pause this long between scroll events starts a new swipe. */
const SWIPE_GAP_MS = 180;
/** A page picked by hand is kept for this long before smart defaults resume. */
const PAGE_MEMORY_MS = 5 * 60 * 1000;
/** An alert's width is checked again this soon after it shows. */
const ALERT_FIT_DELAY_MS = 60;
/** Which switch in Settings each kind of system event answers to. */
const SYSTEM_ALERTS = {power: 'power', battery_low: 'power', battery_full: 'power', network: 'network', bluetooth: 'bluetooth',
    bluetooth_low: 'bluetooth-battery'};
/** The system events that come through Do Not Disturb: a low battery, the laptop's or a device's. */
const URGENT_SYSTEM_ALERTS = ['battery_low', 'bluetooth_low'];
/** The open island's header on a display without the top bar. */
const HEADER_WITHOUT_BAR = 32;
/** A window's animation (minimizing, say) is over by then, so whether it covers the display is checked again. */
const SCANOUT_SETTLE_MS = 400;
/** Auto-hidden on a display without the top bar, its top this many px (CSS) still brings it back. */
const REVEAL_EDGE_PX = 2;
/** isled may be away this long (restarting after an update) before the island does anything about it. */
const SERVICE_GRACE_MS = 5000;
/** Opened from the keyboard without getting it, the island closes this soon unless the pointer is on it. */
const KEYBOARD_LESS_CLOSE_MS = 4000;
/** Notifications waiting to be shown past this many come as one summary. */
const MAX_QUEUED_NOTIFICATIONS = 3;
/** Without input for this long, the user is away and animations rest; sooner on battery. */
const IDLE_MS = 60 * 1000;
const IDLE_ON_BATTERY_MS = 15 * 1000;

// Corner and shoulder ("ear") radii per presentation, in CSS pixels (see `px`); the shoulders grow with the island.
// The compact island hangs 30 px by default, with a 16 px corner and a 10 px shoulder.
const COMPACT_RADIUS = 16;
const COMPACT_SHOULDER = 10;
// Inside the top bar the closed island is a small notch. Its shoulders only show on a bar that is
// not black, where it hangs from the screen's top edge.
const IN_BAR_RADIUS = 10;
const IN_BAR_SHOULDER = 7;
// The badge's radius plus the room round it (see PADDING in peek.js): the corners follow the badge.
const PEEK_RADIUS = 28;
const PEEK_SHOULDER = 13;
const EXPANDED_RADIUS = 32;
const EXPANDED_SHOULDER = 22;
// The pill (Settings → Shape) floats with room above it: centred in the top bar (36 px round a pill, see shell.js), 3 px
// above and below; just below a bar it hangs under; from a display's top edge without one. Closed, it is 30 px tall in
// the bar and 32 off it, its signs and clock the bar's size in it as the notch's are (larger off it), and fully round;
// open, an alert grows down from where it sits, round all over.
const PILL_IN_BAR_GAP = 3;
const PILL_BELOW_BAR_GAP = 6;
const PILL_EDGE_GAP = 8;
const PILL_HEIGHT = 32;
/** Open, a pill's tabs sit this much lower in it (CSS px): 11 px from its edge, clear of its 32 px corners, as the
 * notch's sit in the bar; its pages keep their 20 px to the sides and the bottom. */
const PILL_HEADER_TOP = 8;

/** The pages a shortcut of their own may open from anywhere (Settings → Shortcuts; `shortcut-<page>`, none set at
 * first: the usual ones are GNOME's). As prefs.js lists them. */
const SHORTCUT_PAGES = ['music', 'notifications', 'focus', 'reminders', 'shelf', 'calendar', 'apps', 'devices',
    'system'];

/** Where in its flow, and how bright, the still glow of an alert that asks is drawn. */
const ALERT_GLOW_TIME = 2.2;
const ALERT_GLOW_LEVEL = 0.3;
// Pages that open by default when they have something to show, best first, unless one was picked
// by hand lately. Notifications count only when some arrived unseen (others were shown as alerts).
const DEFAULT_PAGE_ORDER = ['call', 'notifications', 'music', 'focus'];
/** Whether `alert` waits on screen while no one is there, its time counted once they are back: a reminder,
 * or a notification, as GNOME's banner does. */
function waitsWhileAway(alert) {
    return alert.sticky || alert.kind === 'notification';
}

/** Builds the island a part at a time, then decides what it shows until `destroy`. */
export class Controller {
    /** Starts building on idle; nothing shows until `_buildIsland`. */
    constructor(extension) {
        this._extension = extension;
        this._settings = extension.getSettings();
        // Before any view shows a time: 24 or 12 hours, or as GNOME's clock (Settings → Appearance → Clock).
        Format.setClockFormat(this._settings.get_string('clock-format'));
        this._daemon = new Daemon();
        // Heard once everything listening is built (see `_connectAll`).
        this._daemon.hold();
        this._timeouts = new Map();
        this._presentation = 'compact';
        /** Whether auto-hide has faded the closed island away (see `_syncAutoHide`). */
        this._autoHidden = false;
        /** Whether `_warmUp` shows the open island's view out of sight. */
        this._warmShown = false;
        /** A warm-up the island opened in the middle of, and whether it was of all (see `_warmUp`); else null. */
        this._warmHeld = null;
        this._expandWanted = false;
        /** While the island is open to preview a setting: what to put back when it closes (see `_previewSetting`). */
        this._preview = null;
        this._alert = null;
        this._queue = [];
        this._keyboardGrab = null;
        this._pagePickedAt = 0;
        this._lastTrack = null;
        this._tint = null;
        this._tintStyle = null;
        /** The touchpad swipe over an alert under way: {dy, at, done} (see `_onAlertScroll`). */
        this._swipe = null;
        /** Whether the alert views were laid out ahead since the theme last changed (see `_warmUp`). */
        this._viewsWarm = false;
        /** With the island on every display, its copies on the others (see mirror.js), and what their closed
         * views are told as the island's is (see `_setCompact`). */
        this._mirrors = [];
        this._compactState = {};
        /** The display the pointer took the island to from a copy, until it leaves the island; else null. Taken
         * there by a tap, which no pointer leaves, until it is closed again. */
        this._pointedMonitor = null;
        this._pointedByTap = false;

        // Built a part at a time, frames drawn in between: all at once, it held the screen still for a tenth
        // of a second at every login and unlock. Nothing outside calls in before the last part.
        this._pages = [];
        this._buildSteps = [
            () => this._buildServices(),
            () => this._buildViews(),
            // A page a step: the music and shelf pages alone take a frame's time.
            ...this._pageMakers().map(make => () => this._pages.push(make())),
            () => (this._expanded = this._buildExpanded(this._pages)),
            () => this._buildIsland(),
            () => this._connectAll(),
        ];
        this._building = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            try {
                this._buildSteps.shift()();
            } catch (e) {
                // A part failing (on a GNOME that changed under it) leaves no half-built island: what was built goes.
                console.warn(`Isle: could not start: ${e.message}\n${e.stack}`);
                this._building = 0;
                this._failed = true;
                this._destroyPartial();
                return GLib.SOURCE_REMOVE;
            }
            if (this._buildSteps.length)
                return GLib.SOURCE_CONTINUE;
            this._building = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    /** What the views watch: notifications, privacy, calls, audio, focus mode and the clipboard. */
    _buildServices() {
        // One "system alerts" switch before 0.7: an "off" there carries over to each of its parts.
        if (!this._settings.get_boolean('system-alerts')) {
            for (const category of ['power', 'network', 'bluetooth', 'caps-lock'])
                this._settings.set_boolean(`alert-${category}`, false);
            this._settings.set_boolean('system-alerts', true);
        }
        this._notifications = new NotificationCenter(this._settings);
        this._notifications.remindsOf = id => this._expanded?.pageNamed('calendar')?.remindsOf(id) ?? false;
        this._privacy = new PrivacyMonitor(this._daemon);
        this._call = new CallMonitor(this._privacy, this._settings);
        this._audio = new AudioOutputs();
        this._focusMode = new FocusMode(this._daemon, this._notifications, this._settings);
        this._clipboard = new ClipboardHistory(this._daemon, this._settings);
        this._appUsage = new AppUsage(this._daemon);
        this._clearingAppUsage = false;
    }

    /** The island and its closed and alert views; the pages follow a step at a time. */
    _buildViews() {
        this._island = new Island();
        this._syncTheme();
        this._compact = new CompactView(this._daemon, this._settings, this._privacy, this._call);
        // Two, taking turns: a new alert fades in over the one it replaces, rather than swapping in a frame.
        this._peeks = [new PeekView(), new PeekView()];
        this._peek = this._peeks[0];
    }

    // The bar and the island appear together: the clock gives way to it in the same frame.
    _buildIsland() {
        this._topBar = new TopBar(this._settings);
        this._shelf = this._expanded.pageNamed('shelf');
        this._shelfHelper = new ShelfHelper(this._island, this._shelf);
        for (const view of [this._compact, ...this._peeks, this._expanded])
            this._island.addView(view);
        Main.layoutManager.addChrome(this._island, this._chromeParams());
        this._chrome = this._chromeParams();
        // GNOME Shell shutting down takes the island with the stage, Isle still on, and GNOME 51 runs on a
        // moment after: nothing of Isle's may run on it then.
        this._island.connect('destroy', () => {
            for (const name of [...this._timeouts.keys()])
                this._cancel(name);
            this._destroying = true;
            // The display outlives it, its windows still going (Xwayland's as it ends, others as they are freed,
            // when no JS may run): not followed. What else it watched may be gone already: see `_syncScanout`.
            if (this._focusChanged)
                global.display.disconnect(this._focusChanged);
            this._focusChanged = 0;
        });
        this._updateGeometry();
        this._render();
    }

    /** The last step: hooks the island to GNOME and isled, then lets isled's held changes through. */
    _connectAll() {
        // Watch GNOME's light/dark preference so the island follows it, and its accent colour.
        try {
            this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
            const syncGnomeScheme = () => {
                const scheme = this._interfaceSettings.get_string('color-scheme');
                Theme.setGnomeScheme(scheme);
                if (this._settings.get_string('island-theme') === 'gnome')
                    this._syncTheme();
            };
            this._interfaceChanged = this._interfaceSettings.connect('changed::color-scheme', syncGnomeScheme);
            syncGnomeScheme();
        } catch {
            // Not on GNOME or the schema is missing; keep the default dark.
        }
        // A new accent restyles the island and what is drawn in it.
        this._accentWatch = Palette.watchAccent(() => this._syncTheme());

        // The window in front changed: the island may follow it to another display.
        this._focusChanged = global.display.connect('notify::focus-window', () => this._syncMonitor());
        // Drawn into the edge by auto-hide: GNOME may send a window covering the display straight to the screen again.
        this._island.connect('auto-hide-settled', () => this._syncScanout());
        // Hidden by a fullscreen window meanwhile: what waited shows now.
        this._island.connect('notify::visible', () => {
            this._syncScanout();
            this._syncAutoHide();
            // On every display, a fullscreen window sends it to another display, rather than hiding it.
            if (!this._island.visible && this._mirrors.length && this._wantedMonitor() !== this._monitor) {
                this._updateGeometry();
                return;
            }
            if (!this._island.visible) {
                this._onHidden();
                return;
            }
            // A pointer on it as it hid told it nothing on leaving.
            this._island.syncHover();
            if (!this._alert)
                this._nextAlert();
        });
        // A window that may now cover the island's display, or no longer: see `_syncScanout`. Again once its
        // animation (minimizing, say) is over, as some signals come as it starts.
        const sync = () => {
            this._syncScanout();
            this._syncAutoHide();
            this._later('scanout', SCANOUT_SETTLE_MS, () => {
                this._syncScanout();
                this._syncAutoHide();
            });
        };
        this._scanoutWatches = [
            [global.display, ['restacked', 'workareas-changed', 'in-fullscreen-changed', 'window-entered-monitor',
                'window-left-monitor', 'grab-op-end']],
            [Main.overview, ['showing', 'hidden']],
            [global.window_manager, ['size-changed', 'minimize', 'unminimize', 'map', 'destroy']],
            [global.workspace_manager, ['active-workspace-changed']],
            [Main.layoutManager.panelBox, ['notify::mapped', 'notify::y', 'notify::translation-y']],
        ].flatMap(([source, signals]) => signals.map(signal => [source, source.connect(signal, sync)]));
        this._syncScanout();
        this._panelAdded = Main.layoutManager.uiGroup.connect('child-added', (_group, actor) => {
            // Once GNOME has placed it, which it does right after this.
            if (actor === Main.layoutManager.panelBox)
                this._later('panel', 0, () => this._keepAbovePanel());
        });
        this._keepAbovePanel();
        this._connectSignals();
        this._keyboard = new KeyboardWatcher();
        this._keyboard.connect('caps-lock', (_watcher, on) => this._postSystemAlert(Alerts.capsLock(on), 'caps-lock'));
        this._osd = new OsdHook((icon, label, level, maxLevel, displays) => this._showOsd(icon, label, level, maxLevel, displays));
        this._watchIdle();
        this._reminders = new ReminderWatcher(this._daemon, (reminder, done) => {
            this._post(Alerts.reminder(reminder, () => {
                this._chime('complete');
                done();
            }));
        });
        this._bindPageShortcuts();
        this._syncEventAlerts();
        this._syncPages();
        // The pointer met while it was still being built (after unlocking, at rest on it) is told now.
        if (this._island.hovered)
            this._onHoverChanged();
        this._render();
        this._later('warm', WARM_START_MS, () => this._warmUp(true));
        this._daemon.release();
    }

    /** Makes each page, in Isle's own tab order (DEFAULT_ORDER in pageOrder.js); Settings may put them in another. */
    _pageMakers() {
        const size = {height: PAGE_HEIGHT};
        return [
            () => new CallPage(this._daemon, this._call, this._privacy, this._settings, size),
            () => new MediaPage(this._daemon, this._audio, size, this._settings),
            () => new NotificationsPage(this._daemon, this._notifications, size),
            () => new TimerPage(this._daemon, size),
            () => new TasksPage(this._daemon, size),
            () => new ShelfPage(this._daemon, this._clipboard, this._settings, size),
            () => new CalendarPage(this._daemon, this._settings, size),
            () => new AppsPage(this._daemon, this._appUsage, size),
            () => new DevicesPage(this._daemon, size),
            () => new SystemPage(this._daemon, size),
        ];
    }

    /** The open island over `pages`, its signals wired to the keyboard, closing, warm-ups and tints. */
    _buildExpanded(pages) {
        for (const page of pages) {
            page.connect('request-keyboard', (_page, wanted) => this._setKeyboard(wanted));
            page.connect('request-close', () => this.collapse());
            page.connect('cold', () => this._scheduleWarm());
        }
        const expanded = new ExpandedView(this._daemon, this._privacy, this._call, this._settings, pages);
        expanded.order = this._tabOrder();
        // Pages are laid out ahead only while the island holds still (see `ExpandedView._openWarmStep`).
        expanded.islandMoving = () => this._island?.moving ?? false;
        expanded.connect('page-changed', () => {
            // Picked by hand (a tab) while open; not when opening, nor when a page
            // (the call's) goes away by itself.
            if (this._expandWanted && expanded.pickedByHand)
                this._pagePickedAt = Date.now();
            if (expanded.page === this._shelf)
                this._shelfHelper?.prepare();
            this._shelfHelper?.sync();
        });
        expanded.connect('page-settled', () => this._shelfHelper?.sync());
        // Another page shown by itself (Music left out in Settings, say): pinned lyrics no longer hold it open.
        expanded.connect('page-changed', () => {
            if (expanded.pageNamed('music')?.pinned && !this._lyricsHeld)
                this._onLyricsHold();
        });
        expanded.pageNamed('music').connect('hold-changed', () => this._onLyricsHold());
        expanded.pageNamed('shelf').connect('helper-area-changed', () => this._shelfHelper?.sync());
        // Lyrics widen the island and wash it with the cover's colour; a page that lists things may be taller.
        for (const signal of ['width-changed', 'height-changed']) {
            expanded.connect(signal, () => {
                if (this._presentation === 'expanded')
                    this._render();
            });
        }
        expanded.connect('tint-changed', () => this._syncTint());
        expanded.connect('tint-motion', (_view, time, level) => {
            if (this._presentation === 'expanded')
                this._island.setTintMotion(time, level);
        });
        // Settings open in their own window; the island gets out of its way.
        expanded.connect('settings-requested', () => {
            this.collapse();
            this._extension.openPreferences();
        });
        return expanded;
    }

    /** Everything else it reacts to: pointer, keys, the shelf helper, Settings, isled and notifications. */
    _connectSignals() {
        const island = this._island;
        island.connect('notify::hovered', () => this._onHoverChanged());
        // Hidden (under a fullscreen window), nothing can be laid out: it waits until shown again.
        island.connect('notify::mapped', () => this._scheduleWarm());
        // A new theme, accent or text size restyles every view and page: all laid out ahead again once the
        // island rests closed (not before the first warm-up), else each first showing styles them afresh.
        island.connect('style-changed', () => {
            this._viewsWarm = false;
            if (this._warmedAt === undefined)
                return;
            this._expanded.pages.forEach(page => page.markCold());
            if (this._presentation === 'compact')
                this._later('warm', WARM_AFTER_CLOSE_MS, () => this._warmUp(true));
        });
        // Before the field under it sees the press: see `_onFieldPress`.
        island.connect('captured-event', (_actor, event) => this._onFieldPress(event));
        island.connect('button-release-event', (_actor, event) => this._onClick(event));
        island.connect('touch-event', (_actor, event) => this._onTap(event));
        island.connect('scroll-event', (_actor, event) => this._onAlertScroll(event));
        island.connect('geometry-changed', () => this._shelfHelper.sync());

        // A file dragged towards the island opens the shelf to drop it on.
        this._shelfHelper.connect('drag-near', () => {
            // Left out in Settings: no shelf to drop on.
            if (this._shelf.hidden)
                return;
            this._shelf.showTab('files');
            this._shelf.dropping = true;
            this.expand('shelf');
            // The shelf stays the page to open on, to drag the files out again.
            this._pagePickedAt = Date.now();
        });
        this._shelfHelper.connect('drag-over', (_helper, over) => (this._shelf.dropOver = over));
        this._shelfHelper.connect('drag-files', (_helper, uris) => this._shelf.showDragged(uris));
        // ↓ on a file the Shelf keeps itself, from the island's own tile or the helper's.
        this._shelf.connect('save-requested', (_page, uri) => this._saveToDownloads(uri));
        this._shelfHelper.connect('save', (_helper, uri) => this._saveToDownloads(uri));
        this._shelfHelper.connect('drag-end', (_helper, onShelf = false) => {
            // A full shelf turns the file away: the island shakes its head.
            if (this._shelf.endDrop(onShelf))
                this._island.nudge();
            if (!this._island.hovered)
                this._later('collapse', COLLAPSE_DELAY_MS, () => this._collapseUnlessHeld());
        });
        // It went elsewhere after all.
        this._shelfHelper.connect('drag-away', () => {
            this._shelf.dropping = false;
            this._collapseUnlessHeld();
        });
        this._shelfHelper.connect('available-changed', () =>
            (this._shelf.helperAvailable = this._shelfHelper.available));
        // Found already, a step of the build before this one: told now, or the tab says it is missing.
        this._shelf.helperAvailable = this._shelfHelper.available;

        this._compact.connect('width-changed', () => {
            if (this._presentation === 'compact')
                this._render();
        });

        this._settingsChanged = ['notch-depth', 'island-in-top-bar'].map(key =>
            this._settings.connect(`changed::${key}`, () => this._render()));
        // Notch or pill: where the island starts, whether it blends into a black bar, and its open header.
        this._settingsChanged.push(this._settings.connect('changed::island-shape', () => this._updateGeometry()));
        for (const key of ['auto-hide', 'auto-hide-delay'])
            this._settingsChanged.push(this._settings.connect(`changed::${key}`, () => this._syncAutoHide(true)));
        this._settingsChanged.push(this._settings.connect('changed::alerts-over-fullscreen', () => {
            this._trackIsland();
            this._syncFullscreen();
            this._syncAutoHide(true);
            // On every display, the island no longer needs to leave a full-screen app's display, or now does.
            this._syncMonitor();
        }));
        this._settingsChanged.push(this._settings.connect('changed::island-monitor', () => this._updateGeometry()));
        // Notifications left to GNOME again: those in the island, shown or waiting, go as a fresh start has none.
        this._settingsChanged.push(this._settings.connect('changed::gnome-banners', () => {
            if (!this._settings.get_boolean('gnome-banners'))
                return;
            // The waiting ones first: else each would show, with its sound, as the one before it goes.
            const notification = alert => alert?.kind === 'notification' || alert?.key === 'notifications-summary';
            this._queue = this._queue.filter(alert => !notification(alert));
            if (notification(this._alert))
                this._withdrawAlert(this._alert.key);
        }));
        // On the display in use, it follows the window in front, once closed.
        this._focusMonitorChanged = global.display.connect('window-entered-monitor', () => this._syncMonitor());
        // On every display, it leaves one a fullscreen window takes (see `_wantedMonitor`).
        this._fullscreenChanged = global.display.connect('in-fullscreen-changed', () => this._syncMonitor());
        for (const key of ['event-alerts', 'event-alert-minutes'])
            this._settingsChanged.push(this._settings.connect(`changed::${key}`, () => this._syncEventAlerts()));
        for (const key of ['hidden-pages', 'world-clocks', 'app-usage', 'devices-page', 'open-size'])
            this._settingsChanged.push(this._settings.connect(`changed::${key}`, () => this._syncPages()));
        this._settingsChanged.push(this._settings.connect('changed::app-usage-clear', () => this._syncAppUsage()));
        this._settingsChanged.push(this._settings.connect('changed::page-order', () => {
            this._expanded.order = this._tabOrder();
            // The open island fits its tabs again, as it would opened anew.
            if (this._presentation === 'expanded')
                this._render();
        }));
        for (const key of ['island-theme'])
            this._settingsChanged.push(this._settings.connect(`changed::${key}`, () => this._syncTheme()));
        // While Settings change something that is seen on the open island, it opens on it (see `_previewSetting`).
        for (const key of PREVIEWED_KEYS)
            this._settingsChanged.push(this._settings.connect(`changed::${key}`, () => this._previewSetting(key)));
        // Changed: the clocks on show change at once, the rest as they next draw.
        this._settingsChanged.push(this._settings.connect('changed::clock-format', () => {
            Format.setClockFormat(this._settings.get_string('clock-format'));
            refreshClocks();
            // A page on show with times in it writes them again too (the Calendar's).
            this._expanded?.pages.forEach(page => page.clockChanged?.());
        }));

        this._topBar.connect('height-changed', () => this._updateGeometry());
        this._settingsChanged.push(this._settings.connect('changed::island-clock', () => this._updateGeometry()));
        this._topBar.connect('style-changed', () => this._updateGeometry());
        this._topBar.connect('moved', () => this._updateGeometry());
        this._topBar.connect('calendar-requested', (_bar, page) => this._toggleFromKeyboard(page));
        island.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this.collapse();
                return Clutter.EVENT_STOP;
            }
            // Open and holding the keyboard: Ctrl+Tab (Shift back) or Ctrl+PageDown/Up turns the tabs, Ctrl+1…9 picks one.
            if (this._presentation === 'expanded' && this._pageKey(event))
                return Clutter.EVENT_STOP;
            return Clutter.EVENT_PROPAGATE;
        });
        this._monitorsChanged = Main.layoutManager.connect('monitors-changed', () => this._updateGeometry());
        // Another scale (display settings, a display of another one): every size is laid out again.
        onUiScale(island, () => this._updateGeometry(), {now: false});

        const daemon = this._daemon;
        daemon.connect('changed', (_daemon, key) => {
            if (key === 'nowPlaying')
                this._onNowPlaying();
        });
        daemon.connect('running-changed', () => this._onServiceChanged());
        // Never started at all (a broken install) is the same as stopped.
        this._onServiceChanged();
        // isled forgets the settings when it restarts; they are sent again whenever it appears.
        daemon.connect('appeared', (_daemon, name) => {
            if (name === 'updates')
                this._syncUpdates();
            else if (name === 'media')
                this._syncLyrics();
            else if (name === 'appUsage')
                this._syncAppUsage();
        });
        daemon.connect('phone-received', (_daemon, name) => this._onPhoneReceived(name));
        this._expanded.pageNamed('calendar').connect('event-soon', (_page, json) => this._onEventSoon(JSON.parse(json)));
        daemon.connect('changed', (_daemon, key) => {
            if (key === 'updates')
                this._onLatest();
            // Back online: an "Offline" still waiting its turn, or on screen, is no longer so.
            else if (key === 'system' && daemon.state.system?.network?.connected)
                this._withdrawAlert('network');
            else if (key === 'share')
                this._onShare();
        });
        this._settingsChanged.push(this._settings.connect('changed::check-updates', () => this._syncUpdates()));
        this._settingsChanged.push(this._settings.connect('changed::lyrics-online', () => this._syncLyrics()));
        for (const peek of this._peeks)
            peek.connect('close-requested', () => this._alert && !this._expandWanted && this._dismissAlert(true));
        daemon.connect('pomodoro-finished', (_daemon, finished, next) => {
            this._chime('complete');
            this._post(Alerts.pomodoroFinished(finished, next, daemon.state.pomodoro, daemon));
        });
        daemon.connect('system-event', (_daemon, event) =>
            this._postSystemAlert(Alerts.system(event), SYSTEM_ALERTS[event.kind] ?? 'power',
                URGENT_SYSTEM_ALERTS.includes(event.kind)));

        // Sharing or recording the screen, what others write and what was copied stay out of sight.
        this._privacy.connect('changed', () => this._syncSharing());
        this._syncSharing();
        this._privacy.connect('recording-started', () =>
            this._post(Alerts.recordingStarted(() => this._privacy.stopRecording())));
        // A new call is what the island opens on next, whatever was picked before.
        this._call.connect('started', () => (this._pagePickedAt = 0));

        // GNOME's notifications appear in the island instead of as banners.
        const notifications = this._notifications;
        notifications.connect('banner', (_center, notification) => {
            const urgent = notification.urgency === MessageTray.Urgency.CRITICAL;
            this._post(Alerts.notification(notification, urgent, {
                // Its sound as it comes; read once someone is there to see it (see `_timeAlert`).
                onShown: () => notification.playSound(),
                onSeen: () => notifications.acknowledge(notification),
                // Taken back by its app: it goes from the island too.
                onWithdrawn: key => !this._destroying && this._withdrawAlert(key),
            }, this._sharing));
        });
        notifications.connect('dnd-changed', () => this._setCompact('doNotDisturb', notifications.dnd));
        notifications.connect('changed', () => this._syncUnseen());
        notifications.connect('seen-changed', () => this._syncUnseen());
        this._setCompact('doNotDisturb', notifications.dnd);
        this._syncUnseen();
    }

    /** Tells the closed island, and its copies on other displays, what it shows: `name` is a CompactView setter. */
    _setCompact(name, value) {
        this._compactState[name] = value;
        for (const compact of [this._compact, ...this._mirrors.map(mirror => mirror.compact)])
            compact[name] = value;
    }

    /** The unread dot, unless the Notifications page it leads to is left out. */
    _syncUnseen() {
        this._setCompact('unseenNotifications', this._notifications.unseenCount > 0 &&
            !this._settings.get_strv('hidden-pages').includes('notifications'));
    }

    // Layout

    /** Places the island on its display, in or under the top bar, and its copies on the others; then redraws. */
    _updateGeometry() {
        if (this._destroying)
            return;
        const before = this._monitor;
        this._syncMirrors();
        this._monitor = this._wantedMonitor();
        // On a black bar the island grows out of it, its shoulders below the
        // bar; on any other it hangs from the top of the screen like a notch.
        this._island.topInset = this._blendsIn ? this._topBar.height : 0;
        this._island.monitor = this._monitor;
        // Without a top bar (another display) the open island's header is its own; in the bar, the bar's height
        // (the space below the closed island is the closed one's alone). A pill's is always its own.
        this._expanded.topInset = this._onBar && !this._pill ? this._topBar.height : px(HEADER_WITHOUT_BAR);
        // A copy of the island in the bar keeps the clock away as the island does.
        this._topBar.clockShown = !this._onBar && !this._mirrors.some(mirror => this._isOnBar(mirror.monitor));
        // Settings → Clock in the island off: the closed island, and its copies, keep their size with no clock (#62).
        const clockAway = !this._settings.get_boolean('island-clock');
        for (const compact of [this._compact, ...this._mirrors.map(mirror => mirror.compact)])
            compact.clockAway = clockAway;
        for (const mirror of this._mirrors) {
            mirror.island.topInset = this._blendsInOn(this._isOnBar(mirror.monitor)) ? this._topBar.height : 0;
            mirror.shown = mirror.monitor !== this._monitor;
        }
        this._render();
        if (this._monitor !== before) {
            this._syncFullscreen();
            // Where a copy showed the same, it takes the copy's shape at once rather than growing into it.
            if (before && this._mirrors.length)
                this._island.settle();
        }
        this._syncScanout();
    }

    /** With the island on every display (Settings), a copy of it on each (see mirror.js); the one on the island's
     * own display stays hidden. Made again as the displays change. */
    _syncMirrors() {
        const {monitors} = Main.layoutManager;
        const wanted = this._settings.get_string('island-monitor') === 'all' && monitors.length > 1 ? monitors : [];
        if (wanted.length === this._mirrors.length && wanted.every((monitor, i) => this._mirrors[i].monitor === monitor))
            return;
        // Displays changed: what was pending for the old copies goes, and the display pointed at is the new one
        // in its place.
        this._cancel('monitor');
        this._cancel('pointed');
        this._pointedMonitor = this._pointedMonitor ? wanted[this._pointedMonitor.index] ?? null : null;
        this._destroyMirrors();
        const services = {daemon: this._daemon, settings: this._settings, privacy: this._privacy, call: this._call};
        this._mirrors = wanted.map(monitor => {
            const mirror = new MirrorIsland(monitor, services, {
                onHover: copy => this._onMirrorHover(copy),
                onRelease: (released, event) => this._onMirrorRelease(released, event),
                // Closed, as copies are but for alerts.
                onResize: resized => this._presentation !== 'peek' && this._renderMirror(resized),
                onShown: shown => {
                    this._renderMirror(shown);
                    this._syncAutoHide();
                },
                onClose: () => this._alert && !this._expandWanted && this._dismissAlert(true),
            });
            mirror.island.connect('auto-hide-settled', () => this._syncScanout());
            for (const [name, value] of Object.entries(this._compactState))
                mirror.compact[name] = value;
            this._styleIsland(mirror.island);
            if (this._alert)
                mirror.setAlert(this._alert, this._alertDone(this._alert));
            return mirror;
        });
        this._keepAbovePanel();
    }

    _destroyMirrors() {
        this._mirrors.forEach(mirror => {
            this._cancel(mirror.autoHideKey);
            mirror.destroy();
        });
        this._mirrors = [];
    }

    /** The pointer came onto a copy (see `_useMirror`), or left it: a hidden copy comes back as the island does. */
    _onMirrorHover(mirror) {
        if (mirror.island.hovered)
            this._useMirror(mirror);
        if (this._mirrors.includes(mirror))
            this._syncAutoHideOf(mirror);
    }

    /** The pointer came onto a copy of the island: the island itself takes the copy's place, unless it is open on
     * another display (then once it closes, see `_render`). Presses on a copy go no further. */
    _useMirror(mirror, {press = false} = {}) {
        if (this._destroying || !this._mirrors.includes(mirror) || !mirror.shown || this._expandWanted)
            return Clutter.EVENT_STOP;
        // A copy that grew under a still pointer (an alert): no hover yet, on the island either (see `_onHoverChanged`).
        const came = !mirror.island.changedUnderPointer;
        this._pointedMonitor = mirror.monitor;
        this._pointedByTap = false;
        this._updateGeometry();
        // Under the pointer, where the copy was: a hover as soon as GNOME sees the pointer on it.
        if (came)
            this._island.pointerCame();
        this._island.syncHover();
        // A tap moves no pointer, which may never come: it goes back once closed again (see `_render`).
        if (press) {
            this._pointedByTap = !this._island.hovered;
            return Clutter.EVENT_STOP;
        }
        // Only passed over, the pointer gone by then: back to the display in use.
        this._later('pointed', MOVE_CHECK_MS, () => {
            this._island.syncHover();
            if (!this._island.hovered)
                this._leavePointed();
        });
        return Clutter.EVENT_STOP;
    }

    /** A click or a tap on a copy, without a hover first: the island comes there and takes it as a primary click
     * on the closed island (see `_onClick`, `_onTap`). Open on another display, nothing. */
    _onMirrorRelease(mirror, event) {
        const tap = event.type() === Clutter.EventType.TOUCH_END;
        if (!tap && event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_STOP;
        this._useMirror(mirror, {press: true});
        if (this._monitor !== mirror.monitor || this._expandWanted)
            return Clutter.EVENT_STOP;
        this._openFromClosed();
        if (tap && this._expandWanted && !this._keyboardGrab)
            this._holdOpen();
        return Clutter.EVENT_STOP;
    }

    /** The pointer left the island it took to another display: back to the display in use once closed. */
    _leavePointed() {
        if (!this._pointedMonitor)
            return;
        this._pointedMonitor = null;
        this._pointedByTap = false;
        this._syncMonitor();
    }

    /** GNOME sends a window covering the whole display straight to the screen, hiding the island (or a copy of
     * it) that still takes the pointer. Painting stays on while both show, as for GNOME's own menus and OSDs. */
    _syncScanout() {
        // Until auto-hide has drawn it into the edge, it still shows (see Island.drawn). Not read once the island
        // is gone: GNOME Shell shutting down takes it, and windows still go after.
        const shownOn = () => [...this._island.visible && this._island.drawn ? [this._monitor] : [],
            ...this._mirrors.filter(mirror => mirror.island.visible && mirror.island.drawn).map(mirror => mirror.monitor)];
        const inhibit = !this._destroying && shownOn().some(monitor => this._windowCoversDisplay(monitor));
        if (inhibit === Boolean(this._scanoutInhibited))
            return;
        this._scanoutInhibited = inhibit;
        inhibitScanout(inhibit);
    }

    /** Whether the top window on `monitor` covers all of it with no top bar drawn there. The top one only, as
     * GNOME picks: not the desktop's own (a desktop-icons extension's covers the display under every window). */
    _windowCoversDisplay(monitor) {
        if (!monitor)
            return false;
        const panelBox = Main.layoutManager.panelBox;
        if (this._isOnBar(monitor) && panelBox.mapped && panelBox.get_transformed_position()[1] >= monitor.y)
            return false;
        const workspace = global.workspace_manager.get_active_workspace();
        const top = global.get_window_actors().map(actor => actor.meta_window).reverse().find(window =>
            !window.minimized && window.get_monitor() === monitor.index && window.located_on_workspace(workspace) &&
            window.get_window_type() !== Meta.WindowType.DESKTOP && !window.is_skip_taskbar() && !window.customJS_ding);
        if (!top)
            return false;
        const rect = top.get_frame_rect();
        return rect.x <= monitor.x && rect.y <= monitor.y && rect.x + rect.width >= monitor.x + monitor.width &&
            rect.y + rect.height >= monitor.y + monitor.height;
    }

    // GNOME hides the island under a fullscreen window only when fullscreen changes, not when it moves
    // to another display: its rule (layout.js `_updateActorVisibility`), here.
    _syncFullscreen() {
        this._island.visible = this._settings.get_boolean('alerts-over-fullscreen') ||
            !(global.window_group.visible && this._monitor?.inFullscreen);
        // Hidden under a full-screen app, pinned lyrics let go: kept open, they would hold the alerts back after it.
        if (!this._island.visible && this._lyricsHeld)
            this.collapse();
    }

    // Auto-hide

    /** Whether `monitor` has a full-screen app that Settings show alerts over. */
    _overFullscreenOn(monitor) {
        return this._settings.get_boolean('alerts-over-fullscreen') && global.window_group.visible &&
            Boolean(monitor?.inFullscreen);
    }

    /** Whether the island, or a copy of it (`mirror`), hides now ('now'), after Settings' wait ('later'), or shows
     * (false); and, hidden, how much of its top still brings it back. Each on its own display, by the same rules.
     * See visibilityRules.js. */
    _autoHideState(mirror = null) {
        const island = mirror?.island ?? this._island;
        const monitor = mirror?.monitor ?? this._monitor;
        const mode = this._settings.get_string('auto-hide');
        const fullscreen = this._overFullscreenOn(monitor);
        const when = autoHide({
            mode, fullscreen,
            // A copy shows the island's alert, or else the closed island.
            presentation: !mirror || this._presentation === 'peek' ? this._presentation : 'compact',
            visible: island.visible,
            hovered: island.hovered,
            barHidden: mode === 'top-bar' && this._barHidden(monitor),
            windowAtTop: mode === 'windows' && this._windowAtTop(monitor, island),
        });
        // A bar another extension hid is not there to point at.
        const barHeight = this._isOnBar(monitor) && !this._barHidden(monitor) ? this._topBar.height : 0;
        const band = revealBand({mode, fullscreen, barHeight, edge: px(REVEAL_EDGE_PX)});
        return {when, band};
    }

    /** Hides the closed island and its copies as Settings say, unless in use; brings them back the moment they are
     * needed again (an alert, the open island, the pointer at its place). */
    _syncAutoHide(restart = false) {
        if (this._destroying)
            return;
        this._syncAutoHideOf(null, restart);
        for (const mirror of this._mirrors)
            this._syncAutoHideOf(mirror, restart);
    }

    /** Auto-hide for the island, or a copy of it (`mirror`), each with its own wait. */
    _syncAutoHideOf(mirror, restart = false) {
        const key = mirror?.autoHideKey ?? 'auto-hide';
        if (restart)
            this._cancel(key);
        const {when, band} = this._autoHideState(mirror);
        if (when !== 'later')
            this._cancel(key);
        if (!when || when === 'now') {
            this._setAutoHidden(Boolean(when), band, mirror);
            return;
        }
        if (mirror?.autoHidden ?? this._autoHidden) {
            this._setAutoHidden(true, band, mirror);
            return;
        }
        if (this._timeouts.has(key))
            return;
        this._later(key, this._settings.get_int('auto-hide-delay') * 1000, () => {
            if (mirror && !this._mirrors.includes(mirror))
                return;
            const now = this._autoHideState(mirror);
            if (now.when)
                this._setAutoHidden(true, now.band, mirror);
        });
    }

    /** Fades the island, or a copy of it (`mirror`), out or back (see Island.setAutoHidden). */
    _setAutoHidden(hidden, band = 0, mirror = null) {
        if (mirror) {
            if (mirror.setAutoHidden(hidden, band, this._isOnBar(mirror.monitor)))
                this._syncScanout();
            return;
        }
        this._island.setAutoHidden(hidden, band);
        if (hidden === this._autoHidden)
            return;
        this._autoHidden = hidden;
        this._trackIsland();
        this._syncScanout();
    }

    /** As chrome: over a full-screen app only for alerts (Settings). On X11 (GNOME 49 and older) hidden in the bar,
     * out of the input region, so clicks below reach the windows; the band stays in the bar's own. */
    _chromeParams() {
        const params = {trackFullscreen: !this._settings.get_boolean('alerts-over-fullscreen')};
        if (!isWayland())
            params.affectsInputRegion = !this._autoHidden || !this._onBar;
        return params;
    }

    /** Tracks the island again if how it should be tracked changed. */
    _trackIsland() {
        const params = this._chromeParams();
        if (!this._chrome || (params.trackFullscreen === this._chrome.trackFullscreen &&
            params.affectsInputRegion === this._chrome.affectsInputRegion))
            return;
        this._chrome = params;
        Main.layoutManager.untrackChrome(this._island);
        // A copy: GNOME fills in its defaults on what it is given.
        Main.layoutManager.trackChrome(this._island, {...params});
    }

    /** Whether the top bar over the island (on `monitor`) is away: hidden or slid off the screen by another
     * extension. */
    _barHidden(monitor = this._monitor) {
        if (!this._isOnBar(monitor))
            return false;
        const panelBox = Main.layoutManager.panelBox;
        return !panelBox.mapped || panelBox.get_transformed_position()[1] + panelBox.height <= monitor.y + 1;
    }

    /** Whether an app's window under the island (or `island`, a copy on `monitor`) reaches the top of its display:
     * maximized, tiled or moved up there. */
    _windowAtTop(monitor = this._monitor, island = this._island) {
        const top = monitor ? monitor.y + (this._isOnBar(monitor) ? this._topBar.height : 0) : 0;
        return windowAtTop(monitor, top + REACH_PX * uiScale(), [island.x, island.x + island.width]);
    }

    /** The display the island belongs on: the main one, or the one of the window in use (see Settings). On every
     * display, the one the pointer took it to from a copy, while the pointer stays on it. */
    _wantedMonitor() {
        const {monitors, primaryMonitor} = Main.layoutManager;
        const where = this._settings.get_string('island-monitor');
        if (where !== 'active' && where !== 'all')
            return primaryMonitor;
        if (where === 'all' && monitors.includes(this._pointedMonitor))
            return this._pointedMonitor;
        const index = global.display.focus_window?.get_monitor() ?? -1;
        const inUse = monitors[index] ?? primaryMonitor;
        // On every display, it shows its alerts on another while a fullscreen window hides it on the one in use
        // (unless Settings show alerts over full-screen apps: then it stays, as do the copies).
        if (where === 'all' && inUse.inFullscreen && !this._settings.get_boolean('alerts-over-fullscreen'))
            return monitors.find(monitor => !monitor.inFullscreen) ?? inUse;
        return inUse;
    }

    /** Moves the island to the display in use, once it is closed (never mid-alert or open). */
    _syncMonitor() {
        if (this._monitor && this._presentation === 'compact' && this._wantedMonitor() !== this._monitor)
            this._updateGeometry();
    }

    /** Whether the island is on the main display, in its top bar; not with the bar moved off the top. */
    get _onBar() {
        return this._isOnBar(this._monitor);
    }

    /** Whether `monitor` has the top bar along its top: the main display, unless another extension moved the
     * bar off it (see TopBar.isOn). */
    _isOnBar(monitor) {
        return this._topBar.isOn(monitor);
    }

    /** Whether it grows out of a black top bar there. */
    get _blendsIn() {
        return this._blendsInOn(this._onBar);
    }

    /** Whether the island grows out of a black top bar on a display with the bar (`onBar`): never a pill, which
     * floats. */
    _blendsInOn(onBar) {
        return onBar && this._topBar.blendsIn && !this._pill;
    }

    /** Whether the closed island's contents take the bar's size (a 15 px clock), notch or pill alike; hanging below
     * the bar, or on a display without it, their larger one (17 px). */
    _compactInBar(onBar) {
        return onBar && this._settings.get_boolean('island-in-top-bar');
    }

    /** Whether the island is a pill (Settings → Shape) rather than a notch. */
    get _pill() {
        return this._settings.get_string('island-shape') === 'pill';
    }

    /** A pill's room above it on a display with the top bar (`onBar`) or without, in stage pixels; null for the
     * notch. */
    _pillGapOn(onBar) {
        if (!this._pill)
            return null;
        const scale = uiScale();
        if (!onBar)
            return PILL_EDGE_GAP * scale;
        return this._settings.get_boolean('island-in-top-bar') ? PILL_IN_BAR_GAP * scale
            : this._topBar.height + PILL_BELOW_BAR_GAP * scale;
    }

    // Calendar

    /** The calendar alarms, as Settings say (see `CalendarPage.alarmLead`). */
    _syncEventAlerts() {
        const minutes = this._settings.get_boolean('event-alerts') ? this._settings.get_int('event-alert-minutes') : 0;
        this._expanded.pageNamed('calendar').alarmLead = minutes;
    }

    /** The tabs' order (Settings → Island → Pages): the call's first, then as set, else Isle's own order. */
    _tabOrder() {
        return ['call', ...pageOrder(this._settings.get_strv('page-order'))];
    }

    /** The pages left out in Settings lose their tabs; the Calendar page's world clocks as Settings say. */
    _syncPages() {
        const hidden = this._settings.get_strv('hidden-pages');
        for (const page of this._expanded.pages) {
            // Apps has its own switch, which times the app in front too: no tab while nothing is timed.
            if (page.name === 'apps')
                page.hidden = !this._settings.get_boolean('app-usage');
            // Devices is off until turned on, as an app is installed: its own switch, not `hidden-pages`.
            else if (page.name === 'devices')
                page.hidden = !this._settings.get_boolean('devices-page');
            else if (page.name !== 'call')
                page.hidden = hidden.includes(page.name);
        }
        this._syncUnseen();
        this._syncLyrics();
        this._syncAppUsage();
        this._expanded.pageNamed('calendar').worldClocks = this._settings.get_boolean('world-clocks');
        // Settings → Appearance → Size: the open island and every page larger, each laid out for it.
        this._expanded.large = this._settings.get_string('open-size') === 'large';
    }

    /** Lets go of GNOME's appearance and accent settings. */
    _disconnectScheme() {
        if (this._interfaceChanged)
            this._interfaceSettings.disconnect(this._interfaceChanged);
        this._interfaceChanged = null;
        this._interfaceSettings = null;
        Palette.unwatchAccent(this._accentWatch);
        this._accentWatch = null;
    }

    /** The island in GNOME's colour, switching dark or light with the system's appearance setting. */
    _syncTheme() {
        Theme.setTheme(this._settings.get_string('island-theme'));
        for (const island of [this._island, ...this._mirrors.map(mirror => mirror.island)])
            this._styleIsland(island);
        // An alert's glow takes the new theme's colours on the copies too.
        for (const mirror of this._mirrors) {
            mirror.glowAlert = null;
            this._tintMirror(mirror);
        }
        // An alert on show takes the new theme's glow (see alerts.js); none while still building.
        if (this._expanded)
            this._syncTint();
    }

    /** The theme on `island` (the island, or a copy of it on another display): its style, shape and parts. */
    _styleIsland(island) {
        const themeName = this._settings.get_string('island-theme');
        const light = themeName === 'gnome' && !Theme.gnomeDark();
        // The accent follows GNOME's where it has one (the stylesheet reads it as -st-accent-color).
        for (const [name, on] of [['isle-light', light], ['isle-accent-system', HAS_ACCENT]]) {
            if (on)
                island.add_style_class_name(name);
            else
                island.remove_style_class_name(name);
        }
        island.refreshTheme();
    }

    /** Times the app in front while the Apps page's switch is on; clears when asked. */
    _syncAppUsage() {
        this._appUsage.enabled = this._settings.get_boolean('app-usage');
        // Settings cannot call isled's shell-only Clear; it leaves this request for the island, which
        // resets it once isled has cleared (asked again when isled appears).
        if (!this._settings.get_boolean('app-usage-clear') || this._clearingAppUsage || !this._daemon.running)
            return;
        this._clearingAppUsage = true;
        this._appUsage.clear().then(cleared => {
            this._clearingAppUsage = false;
            if (!cleared || this._destroying || !this._settings)
                return;
            this._settings.set_boolean('app-usage-clear', false);
            this._expanded?.pageNamed('apps')?.refresh();
        });
    }

    /** Lyrics are looked up online only for the Music page, and only while it is in the island. Which providers are
     * asked, and in what order, is Settings' (see lyricsEngine.js); with LRCLIB alone, isled's lyrics are the page's. */
    _syncLyrics() {
        this._lyrics ??= this._startLyrics();
        this._lyrics.setWanted(this._settings.get_boolean('lyrics-online') &&
            !this._settings.get_strv('hidden-pages').includes('music'));
    }

    /** The lyrics engine, with a web session, a cache on disk and timers on the main loop. */
    _startLyrics() {
        this._lyricsHttp = createHttp();
        const schedule = (ms, run) => {
            let live = true;
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                live = false;
                run();
                return GLib.SOURCE_REMOVE;
            });
            // Cancelled once it has run: nothing to remove.
            return () => {
                if (live) {
                    live = false;
                    GLib.source_remove(id);
                }
            };
        };
        return new LyricsEngine({daemon: this._daemon, settings: this._settings, http: this._lyricsHttp, schedule,
            cache: createLyricsCache()});
    }

    /** An event starts soon: an alert, with Join when the event has a meeting link. Not in Do Not Disturb. */
    async _onEventSoon(event) {
        if (this._notifications.dnd)
            return;
        let link = '';
        // GNOME's id: the calendar, the event and its recurrence, a line each.
        const [source, uid] = event.id?.split('\n') ?? [];
        if (source && uid)
            link = (await this._daemon.call('calendar', 'MeetingLink', source, uid))?.[0] ?? '';
        // Isle turned off, or Do Not Disturb on, while the link was looked for.
        if (this._destroying || this._notifications.dnd)
            return;
        this._post(Alerts.meeting(event, link, () => {
            try {
                Gio.AppInfo.launch_default_for_uri(link, global.create_app_launch_context(0, -1));
            } catch (e) {
                console.warn(`Isle: could not open the meeting: ${e.message}`);
            }
        }, () => this._expanded?.pageNamed('calendar')?.alertShown(event)));
    }

    /** Sizes and shapes the island for what it shows now: the pages, an alert, or nothing. */
    _render() {
        if (this._destroying)
            return;
        const presentation = this._expandWanted ? 'expanded' : this._alert ? 'peek' : 'compact';
        this._presentation = presentation;
        // Alerts and the open island are never auto-hidden; the resting island waits again.
        this._syncAutoHide();
        if (presentation !== 'compact')
            this._putAwayWarm();
        else if (this._warmHeld !== null && !this._timeouts.has('warm'))
            this._later('warm', WARM_AFTER_CLOSE_MS, () => this._warmUp(this._warmHeld));
        // A display without the top bar: the island hangs from its top edge. Sizes are in stage pixels; the
        // CSS ones (padding) are divided by `scale` again, as St multiplies them.
        const scale = uiScale();
        const top = this._onBar ? this._topBar.height : 0;
        // Before measuring it: inside the bar it is smaller.
        this._compact.inBar = this._compactInBar(this._onBar);

        // Alerts hang below the top bar; the open island's header sits in the bar. The compact island
        // either hangs too or sits inside the bar like a notch, covering no window.
        // A pill floats this far below the top, whatever it shows; the notch starts at it.
        const gap = this._pillGapOn(this._onBar);
        this._island.pillGap = gap;
        // The open island's padding, kept as it will be while it is closed too: the warm-up then lays its pages out
        // styled as they show. Set only as it opened, it restyled every page then, each paying for it as it first
        // showed. A new one later (another display, another shape) has them laid out ahead again.
        const expandedInset = gap === null ? 0 : gap + PILL_HEADER_TOP * scale;
        const expandedStyle = gap === null ? null : `padding-top: ${expandedInset / scale}px;`;
        if (this._expanded.style !== expandedStyle) {
            this._expanded.style = expandedStyle;
            if (this._warmedAt !== undefined) {
                this._expanded.pages.forEach(page => page.markCold());
                this._scheduleWarm();
            }
        }
        let size, view;
        switch (presentation) {
        case 'expanded': {
            const header = gap === null ? (this._onBar ? top : HEADER_WITHOUT_BAR * scale) : expandedInset + HEADER_WITHOUT_BAR * scale;
            size = {
                width: this._expanded.preferredWidth,
                height: header + (this._expanded.pageHeight + BOTTOM_PADDING) * scale,
                radius: EXPANDED_RADIUS * scale,
                shoulder: gap === null ? EXPANDED_SHOULDER * scale : 0,
            };
            view = this._expanded;
            break;
        }
        case 'peek':
            size = this._peekShape(this._peek, this._onBar);
            view = this._peek;
            break;
        default:
            size = this._compactShape(this._compact, this._onBar);
            view = this._compact;
        }
        // An even width: centred on the display to the pixel, as much room on either side.
        size.width = 2 * Math.round(size.width / 2);
        view.set_size(size.width, size.height);
        if (this._onBar)
            this._topBar.reserveWidth(this._compact.preferredWidth, this._footprint(this._compact));
        this._island.morph(size, view);
        this._expanded.setActive(presentation === 'expanded');
        // A new alert under the pointer: its × shows (or not) at once.
        this._syncClose();
        this._syncTint();
        this._renderMirrors();
        if (presentation === 'compact' && this._pointedByTap && !this._island.hovered)
            this._leavePointed();
        // Closed again, it goes to the display in use if that changed meanwhile; or to a copy the pointer went to
        // while it was open (see `_useMirror`).
        const pointed = (presentation === 'compact' || presentation === 'peek') &&
            this._mirrors.find(mirror => mirror.shown && mirror.island.hovered);
        if (pointed)
            this._later('monitor', 0, () => this._useMirror(pointed));
        else if (presentation === 'compact' && this._monitor && this._wantedMonitor() !== this._monitor)
            this._later('monitor', 0, () => this._syncMonitor());
        // Have the helper running before it is needed: starting takes a moment.
        if (presentation === 'expanded' && this._expanded.page === this._shelf)
            this._shelfHelper.prepare();
        this._shelfHelper.sync();
    }

    /** The closed island's size on a display with the top bar (`onBar`) or without, `compact` styled for it. */
    _compactShape(compact, onBar) {
        const scale = uiScale();
        const top = onBar ? this._topBar.height : 0;
        const inBar = onBar && this._settings.get_boolean('island-in-top-bar');
        compact.inBar = this._compactInBar(onBar);
        const gap = this._pillGapOn(onBar);
        if (gap !== null) {
            // A pill: centred in the bar, or PILL_HEIGHT tall off it; round all over (the island caps the radius).
            const body = inBar ? Math.max(0, top - 2 * gap) : PILL_HEIGHT * scale;
            compact.pill = true;
            compact.bodyHeight = body;
            compact.style = `padding-top: ${gap / scale}px;`;
            return {width: compact.preferredWidth, height: gap + body, radius: body / 2, shoulder: 0};
        }
        compact.pill = false;
        // Closed inside the bar, it leaves the bar's last few pixels free (Settings); open, it fills the bar.
        const band = top - (inBar ? this._topBar.gap : 0);
        const depth = this._settings.get_int('notch-depth') * scale;
        compact.bodyHeight = inBar ? band : depth;
        const size = {
            width: compact.preferredWidth,
            height: inBar ? band : top + depth,
            radius: (inBar ? IN_BAR_RADIUS : COMPACT_RADIUS) * scale,
            shoulder: (inBar ? IN_BAR_SHOULDER : COMPACT_SHOULDER) * scale,
        };
        compact.style = inBar ? null : `padding-top: ${top / scale}px;`;
        return size;
    }

    /** How much of the top bar `compact`, closed on it, spans: its body and the shoulders flaring from it (a pill has
     * none), in stage px. The bar's items must keep clear of it all (see TopBar `_fitBarClock`). */
    _footprint(compact) {
        const pill = this._pillGapOn(true) !== null;
        const inBar = this._settings.get_boolean('island-in-top-bar');
        const shoulder = pill ? 0 : (inBar ? IN_BAR_SHOULDER : COMPACT_SHOULDER) * uiScale();
        return compact.preferredWidth + 2 * shoulder;
    }

    /** An alert's size on a display with the top bar (`onBar`) or without, `peek` (showing it) styled for it. */
    _peekShape(peek, onBar) {
        const scale = uiScale();
        // Off a black bar its room above counts from the screen's top, as much as below; a pill's from where it floats.
        const gap = this._pillGapOn(onBar);
        const inset = gap ?? (this._blendsInOn(onBar) ? this._topBar.height : 0);
        const size = {width: peek.preferredWidth, height: inset + peek.preferredHeight, radius: PEEK_RADIUS * scale,
            shoulder: gap === null ? PEEK_SHOULDER * scale : 0};
        peek.style = `padding-top: ${inset / scale}px;`;
        return size;
    }

    /** The copies of the island on other displays show the alert it shows, else the closed island: only the
     * island itself opens. */
    _renderMirrors() {
        for (const mirror of this._mirrors)
            this._renderMirror(mirror);
    }

    _renderMirror(mirror) {
        if (this._destroying)
            return;
        const onBar = this._isOnBar(mirror.monitor);
        const alert = this._presentation === 'peek';
        const view = alert ? mirror.peek : mirror.compact;
        mirror.compact.inBar = this._compactInBar(onBar);
        mirror.island.pillGap = this._pillGapOn(onBar);
        const size = alert ? this._peekShape(view, onBar) : this._compactShape(view, onBar);
        size.width = 2 * Math.round(size.width / 2);
        view.set_size(size.width, size.height);
        if (onBar && mirror.shown)
            this._topBar.reserveWidth(mirror.compact.preferredWidth, this._footprint(mirror.compact));
        mirror.island.morph(size, view);
        this._tintMirror(mirror);
    }

    /** A copy glows with the alert it shows, as the island does (see `_syncTint`). */
    _tintMirror(mirror) {
        const alert = this._presentation === 'peek' && this._alert?.glow ? this._alert : null;
        if (alert === mirror.glowAlert)
            return;
        mirror.glowAlert = alert;
        const island = mirror.island;
        island.breathing = false;
        island.setTint(alert?.glow ?? null, 'aura');
        if (alert?.sticky)
            island.setTintMotion(ALERT_GLOW_TIME, ALERT_GLOW_LEVEL);
        else if (alert)
            island.pulseTint(ALERT_GLOW_TIME, ALERT_GLOW_LEVEL);
        island.breathing = Boolean(alert?.sticky);
    }

    /** Lays out ahead, closed and a step at a time, what the frames showing it would otherwise style and lay
     * out: the pages changed out of sight, and with `all` the alert views. */
    _warmUp(all) {
        const island = this._island;
        const expanded = this._expanded;
        this._warmHeld = null;
        if (!island.mapped)
            return;
        const pages = expanded.pages.filter(page => page.cold && !page.hidden);
        const steps = [];
        if (all) {
            // Each alert view shown with a ring alert's parts until the next step: a frame lays them out. Those of
            // the copies on other displays too, but on the island's own (hidden, nothing is laid out there).
            const peeks = [...this._peeks.map(peek => [island, peek]),
                ...this._mirrors.filter(mirror => mirror.island.visible).flatMap(mirror => mirror.peeks.map(peek => [mirror.island, peek]))];
            // A copy goes with its display, maybe between two steps.
            const kept = owner => owner === island || this._mirrors.some(mirror => mirror.island === owner);
            for (const [owner, peek] of peeks) {
                steps.push(() => kept(owner) && owner.warmView(peek, true) && peek.setAlert(WARM_ALERT, null, {fresh: true}));
                steps.push(() => kept(owner) && owner.warmView(peek, false));
            }
        }
        if (pages.length || all) {
            steps.push(() => {
                this._warmShown = island.warmView(expanded, true);
                expanded.warmTabs();
            });
            // Each page stays shown until the next step, so a frame lays it out too.
            pages.forEach((page, i) => steps.push(() => {
                if (!this._warmShown)
                    return;
                if (i)
                    expanded.warmPage(pages[i - 1], false);
                expanded.warmPage(page, true);
            }));
            steps.push(() => this._putAwayWarm());
        }
        const next = () => {
            // Opened meanwhile: it starts again once the island is closed (see `_render`), not polled meanwhile.
            if (this._presentation !== 'compact') {
                this._warmHeld = all;
                return;
            }
            steps.shift()?.();
            if (steps.length) {
                this._later('warm', WARM_STEP_MS, next);
                return;
            }
            this._warmedAt = GLib.get_monotonic_time() / 1000;
            if (all)
                this._viewsWarm = true;
            this._scheduleWarm();
        };
        next();
    }

    /** Hides what `_warmUp` showed out of sight. */
    _putAwayWarm() {
        if (!this._warmShown)
            return;
        this._warmShown = false;
        this._expanded.hideWarmPages();
        this._island.warmView(this._expanded, false);
    }

    /** Lays out the pages that changed out of sight, once the island has rested closed a while. */
    _scheduleWarm() {
        if (this._presentation !== 'compact' || !this._island.mapped || this._timeouts.has('warm') ||
            !this._expanded.pages.some(page => page.cold && !page.hidden))
            return;
        const sinceLast = GLib.get_monotonic_time() / 1000 - (this._warmedAt ?? -Infinity);
        this._later('warm', Math.max(WARM_AFTER_CLOSE_MS, WARM_GAP_MS - sinceLast), () => this._warmUp(false));
    }

    /** The island's colours for what it shows: an alert's glow, or the open page's tint. */
    _syncTint() {
        const expanded = this._presentation === 'expanded';
        // An alert that carries a glow shows it, still: drawn once.
        const glow = this._presentation === 'peek' ? this._alert?.glow : null;
        const tint = glow ?? (expanded ? this._expanded.tint : null);
        const style = glow ? 'aura' : expanded ? this._expanded.tintStyle : null;
        const newGlow = Boolean(glow) && this._alert !== this._glowAlert;
        this._glowAlert = glow ? this._alert : null;
        if (tint !== this._tint || style !== this._tintStyle) {
            this._tint = tint;
            this._tintStyle = style;
            this._island.setTint(tint, style);
        }
        // One that waits for an answer breathes; one that tells something is done lights up once.
        if (newGlow) {
            // A second ask breathes again from the start.
            this._island.breathing = false;
            if (this._alert.sticky)
                this._island.setTintMotion(ALERT_GLOW_TIME, ALERT_GLOW_LEVEL);
            else
                this._island.pulseTint(ALERT_GLOW_TIME, ALERT_GLOW_LEVEL);
        }
        this._island.breathing = Boolean(glow && this._alert?.sticky);
    }

    // Pointer

    /** Whether the pointer is on the island as a hover: not one it grew under that has not moved since. */
    get _pointerOn() {
        return this._island.hovered && !this._hoverUnmoved;
    }

    /** The pointer came or went: holds or times out alerts and answers, and opens or closes the island. */
    _onHoverChanged(moved = false) {
        // With copies, the island stays on the display the pointer is on it in, until the pointer leaves.
        if (this._island.hovered && this._mirrors.length) {
            this._pointedMonitor = this._monitor;
            this._pointedByTap = false;
        }
        else if (!this._island.hovered)
            this._leavePointed();
        // Under the pointer, a hidden island comes back; away, its time to hide starts.
        const wasHidden = this._autoHidden;
        this._syncAutoHide();
        this._stopRevealWait();
        // Brought back by the pointer, it only shows: it opens once the pointer moves on it and rests again.
        if (wasHidden && !this._autoHidden && this._island.hovered && !this._expandWanted) {
            this._hoverUnmoved = true;
            this._hoverOnIslandMove(global.get_pointer());
            return;
        }
        const unmoved = this._hoverUnmoved;
        this._hoverUnmoved = false;
        this._cancel('hover');
        // Grown under a still pointer is no hover yet: it counts once the pointer moves (see `_hoverOnMove`).
        if (this._island.hovered && !moved && this._island.changedUnderPointer && !this._expandWanted) {
            this._hoverUnmoved = true;
            this._hoverOnMove(global.get_pointer());
            return;
        }
        if (!this._island.hovered && unmoved && !this._expandWanted)
            return;
        this._syncClose();
        // An alert waits while the pointer is on it, as a notification should; not the volume's.
        if (this._alert && !this._alert.transient && this._presentation === 'peek') {
            if (this._island.hovered)
                this._cancel('alert');
            // One that waits for an answer (Allow) or a reminder (Join) keeps its own time; a notification goes
            // soon, its button with it, as one without does.
            else if (this._alert.sticky || this._alert.actions?.length || (this._alert.action && this._alert.kind !== 'notification'))
                this._timeAlert();
            else
                this._later('alert', Math.min(ALERT_LEAVE_MS, this._alert.duration ?? ALERT_LEAVE_MS),
                    () => this._dismissAlert(true));
        }
        if (this._island.hovered) {
            this._cancel('collapse');
            if (!this._expandWanted && this._settings.get_string('open-on') === 'hover' && !this._alertHoldsHover)
                this._expandOnRest();
        } else {
            this._cancel('expand');
            if (!this._expandWanted || this._keyboardGrab)
                return;
            // Shrinking under a still pointer is no reason to close: wait until it moves.
            if (this._island.changedUnderPointer)
                this._collapseOnMove(global.get_pointer());
            else
                this._later('collapse', COLLAPSE_DELAY_MS, () => this._collapseUnlessHeld());
        }
    }

    /** Under the pointer, the × on an alert that hovering doesn't open (see `_expandOnRest`). */
    _syncClose() {
        const on = this._pointerOn;
        const opens = this._settings.get_string('open-on') === 'hover' && !this._alertHoldsHover;
        this._peek.showClose(on && this._presentation === 'peek' && !opens);
    }

    /** An alert with buttons (Join, Allow…), or one that opens no page, is on show: the
     * pointer goes there to press or read it, not to open the island. */
    get _alertHoldsHover() {
        const alert = this._alert;
        return this._presentation === 'peek' &&
            Boolean(alert?.action || alert?.actions?.length || (alert?.onActivate && !this._alertPage));
    }

    /** The page the alert shown opens, unless that page is left out in Settings. */
    get _alertPage() {
        const page = this._alert?.page;
        return page && !this._expanded.pageNamed(page)?.hidden ? page : null;
    }

    // Opens once the pointer rests on the island, so passing over it along the top bar opens nothing.
    _expandOnRest() {
        const [x, y] = global.get_pointer();
        this._later('expand', this._settings.get_int('hover-delay'), () => {
            if (this._alertHoldsHover)
                return;
            const [nowX, nowY] = global.get_pointer();
            const rested = Math.hypot(nowX - x, nowY - y) <= px(REST_DISTANCE_PX);
            if (rested)
                this.expand();
            else if (this._island.hovered)
                this._expandOnRest();
        });
    }

    // As `_hoverOnMove`, by the island's own motion: nothing runs while the pointer rests on it at the top.
    _hoverOnIslandMove([x, y]) {
        this._revealMotion = this._island.connect('motion-event', () => {
            const [nowX, nowY] = global.get_pointer();
            if (Math.hypot(nowX - x, nowY - y) > px(REST_DISTANCE_PX)) {
                this._stopRevealWait();
                this._onHoverChanged(true);
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    /** Stops waiting for the pointer to move on the island (see `_hoverOnIslandMove`, `_hoverOnMove`). */
    _stopRevealWait() {
        if (this._revealMotion)
            this._island.disconnect(this._revealMotion);
        this._revealMotion = 0;
    }

    // Counts the pointer on the island as a hover once it moves from `[x, y]`, looked at every MOVE_CHECK_MS from
    // `since`. Only once it moves on the island: one resting there (an alert grown under it while they are away)
    // wakes nothing, where a look each time found it still where it was.
    _hoverOnMove([x, y], since = GLib.get_monotonic_time()) {
        this._revealMotion = this._island.connect('motion-event', () => {
            this._stopRevealWait();
            const waited = (GLib.get_monotonic_time() - since) / 1000;
            this._later('hover', Math.ceil(MOVE_CHECK_MS - waited % MOVE_CHECK_MS), () => {
                const [nowX, nowY] = global.get_pointer();
                if (Math.hypot(nowX - x, nowY - y) > px(REST_DISTANCE_PX))
                    this._onHoverChanged(true);
                else
                    this._hoverOnMove([x, y], since);
            });
            return Clutter.EVENT_PROPAGATE;
        });
    }

    // Closes after the pointer, outside the island, moves away from `[x, y]`, or has rested there a while.
    _collapseOnMove([x, y], waited = 0) {
        this._later('collapse', MOVE_CHECK_MS, () => {
            const [nowX, nowY] = global.get_pointer();
            if (Math.hypot(nowX - x, nowY - y) > px(2) || waited >= STILL_OUTSIDE_MS)
                this._later('collapse', COLLAPSE_DELAY_MS, () => this._collapseUnlessHeld());
            else
                this._collapseOnMove([x, y], waited + MOVE_CHECK_MS);
        });
    }

    /** Closes, unless the pointer is on the shelf helper's window over the island, or the lyrics are pinned open. */
    _collapseUnlessHeld() {
        // The shelf helper window covers the island; the pointer may be on it.
        if (this._shelfHelper.containsPointer()) {
            this._later('collapse', COLLAPSE_DELAY_MS, () => this._collapseUnlessHeld());
            return;
        }
        // Pinned: it stays until unpinned, Esc or a click elsewhere while it holds the keyboard, or an alert. One that
        // came while the pointer was on it waits only until the pointer leaves, never as long as the pin lasts.
        if (this._lyricsHeld && !this._queue.some(alert => !alert.transient))
            return;
        this.collapse();
    }

    /** Whether the open island stays open on the pinned lyrics (#62), the pointer away or not. */
    get _lyricsHeld() {
        return this._expandWanted && this._expanded.page?.name === 'music' &&
            this._expanded.page.holdsOpen;
    }

    /** The lyrics pinned or let go: pinned, the keyboard is let go (the windows below are worked in meanwhile); let
     * go with the pointer away, it closes as the pointer leaving would have. */
    _onLyricsHold() {
        if (this._lyricsHeld) {
            if (this._keyboardGrab)
                this._setKeyboard(false);
            return;
        }
        if (this._expandWanted && !this._keyboardGrab && !this._island.hovered)
            this._later('collapse', COLLAPSE_DELAY_MS, () => this._collapseUnlessHeld());
    }

    /** What a click on the closed island does: an alert's own action, or else the island opens. */
    _openFromClosed() {
        // Clicking a notification opens it, like GNOME's banner did.
        if (!this._expandWanted && this._alert?.onActivate) {
            // Done with: it is not put back in line.
            this._alert.answered = true;
            this._alert.onActivate();
            this._dismissAlert(true);
            return Clutter.EVENT_STOP;
        }
        // isled down: why the island can do little, and how to fix it, rather than the pages.
        if (!this._expandWanted && this._compact.serviceDown) {
            this._post(Alerts.serviceDown(() => this._daemon.start()));
            return Clutter.EVENT_STOP;
        }
        if (!this._expandWanted) {
            this.expand();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    /** Over an alert, a swipe up puts it away and a swipe down opens it, as on a phone. */
    _onAlertScroll(event) {
        if (this._presentation !== 'peek' || !this._alert || this._expandWanted)
            return Clutter.EVENT_PROPAGATE;
        let step;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
            step = -1;
            break;
        case Clutter.ScrollDirection.DOWN:
            step = 1;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const now = GLib.get_monotonic_time() / 1000;
            if (now - (this._swipe?.at ?? 0) > SWIPE_GAP_MS)
                this._swipe = {dy: 0, done: false};
            this._swipe.at = now;
            this._swipe.dy += event.get_scroll_delta()[1];
            if (this._swipe.done || Math.abs(this._swipe.dy) < ALERT_SWIPE)
                return Clutter.EVENT_STOP;
            // Once a swipe, however far it goes.
            this._swipe.done = true;
            step = Math.sign(this._swipe.dy);
            break;
        }
        default:
            return Clutter.EVENT_PROPAGATE;
        }
        // The click-style copies of a smooth scroll count once, as the smooth one.
        if (event.get_flags() & Clutter.EventFlags.POINTER_EMULATED)
            return Clutter.EVENT_STOP;
        // Content scrolls down with fingers moving up (and a wheel turned down): the alert goes up and away.
        if (step > 0)
            this._dismissAlert(true);
        else
            this._openFromClosed();
        return Clutter.EVENT_STOP;
    }

    /** A press on a text field takes the keyboard first, then puts the field back in focus: the grab moves focus
     * to the island. Pages can't ask from the field's own press, which GNOME 50 gives its gestures instead. */
    _onFieldPress(event) {
        const type = event.type();
        if (!(type === Clutter.EventType.TOUCH_BEGIN ||
            (type === Clutter.EventType.BUTTON_PRESS && event.get_button() === Clutter.BUTTON_PRIMARY)))
            return Clutter.EVENT_PROPAGATE;
        // The field or its text, not its icons (the calendar's chip).
        const actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, ...event.get_coords());
        const entry = actor instanceof St.Entry ? actor : actor?.get_parent();
        if (!(entry instanceof St.Entry) || (actor !== entry && actor !== entry.clutter_text) ||
            !entry.clutter_text.reactive || !this._island.contains(entry))
            return Clutter.EVENT_PROPAGATE;
        if (!this._keyboardGrab)
            this._setKeyboard(true);
        // Also from one field to another while typing: a Timer length, not editable until focused, takes no press.
        if (this._keyboardGrab && !entry.clutter_text.has_key_focus())
            entry.clutter_text.grab_key_focus();
        return Clutter.EVENT_PROPAGATE;
    }

    /** A tap is a primary click, but for a button's own; opened by one, a tap elsewhere closes it. */
    _onTap(event) {
        if (event.type() !== Clutter.EventType.TOUCH_END)
            return Clutter.EVENT_PROPAGATE;
        for (let actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, ...event.get_coords());
            actor && actor !== this._island; actor = actor.get_parent()) {
            if (actor instanceof St.Button)
                return Clutter.EVENT_PROPAGATE;
        }
        const wasOpen = this._expandWanted;
        const result = this._onClick(event, Clutter.BUTTON_PRIMARY);
        if (!wasOpen && this._expandWanted && !this._keyboardGrab)
            this._holdOpen();
        return result;
    }

    /** Left opens or acts, middle plays or pauses, right puts an alert away or brings the call or player forward. */
    _onClick(event, button = event.get_button()) {
        // Released off the island: the press outside that ended typing (see `_setKeyboard`) comes back here.
        if (!this._shelfHelper.containsPointer() &&
            !this._island.contains(global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, ...event.get_coords())))
            return Clutter.EVENT_STOP;
        switch (button) {
        case Clutter.BUTTON_PRIMARY:
            return this._openFromClosed();
        case Clutter.BUTTON_MIDDLE:
            this._daemon.call('media', 'PlayPause');
            return Clutter.EVENT_STOP;
        case Clutter.BUTTON_SECONDARY:
            // On an alert: puts it away without opening what it is about.
            if (!this._expandWanted && this._alert) {
                this._dismissAlert(true);
                return Clutter.EVENT_STOP;
            }
            // Brings the call, or else the music player, to the front from the closed island
            // (the open one has its own controls, cards and fields).
            if (this._expandWanted)
                return Clutter.EVENT_PROPAGATE;
            if (this._call.active) {
                this._call.raise();
                return Clutter.EVENT_STOP;
            }
            if (!Playback.showsClosed(this._daemon.state.nowPlaying))
                return Clutter.EVENT_PROPAGATE;
            this.collapse();
            this._daemon.call('media', 'Raise');
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    /** Opens the island, on `pageName` or the most useful page. */
    expand(pageName = null) {
        // An action finishing after Isle was turned off.
        if (this._destroying)
            return;
        // A close still pending (the pointer just left) would shut it again.
        this._cancel('expand');
        this._cancel('collapse');
        const target = pageName ?? this._alertPage ?? this._defaultPage();
        if (target)
            this._expanded.showPage(target, {animate: this._expandWanted});
        // Opening the island takes over from the alert being shown.
        this._dismissAlert(false);
        this._expandWanted = true;
        this._render();
    }

    /** A setting changed in Settings: the island opens on what it changes, for a few seconds after the last change, and
     * closes again unless the pointer is on it by then (previewMap.js says what opens for which). Not while the island
     * is open already: what changes shows there at once. */
    _previewSetting(key) {
        if (this._destroying || !this._settings.get_boolean('preview-settings'))
            return;
        const target = previewTarget(key);
        if (!target || (this._expandWanted && !this._preview))
            return;
        const music = this._expanded.pageNamed('music');
        // What to put back when it closes: the music page as it was.
        this._preview ??= {mode: music?.mode ?? null};
        this._cancel('preview-restore');
        if (target.mode && music)
            music.showMode(target.mode);
        this.expand(target.page);
        this._cancel('preview');
        this._later('preview', PREVIEW_MS, () => this._endPreview());
    }

    /** The preview is over: the island closes, and the music page goes back to its mode once it has. */
    _endPreview() {
        const preview = this._preview;
        if (!preview)
            return;
        // The pointer is on it, or the lyrics are pinned open: it is open for the user now, as it is.
        if (this._island.hovered || this._lyricsHeld) {
            this._preview = null;
            return;
        }
        this._preview = null;
        this.collapse();
        const music = this._expanded.pageNamed('music');
        if (preview.mode && music && music.mode !== preview.mode)
            this._later('preview-restore', PREVIEW_RESTORE_MS, () => music.showMode(preview.mode));
    }

    /** Closes the open island, then shows what waited. */
    collapse() {
        if (this._destroying)
            return;
        this._cancel('collapse');
        this._setKeyboard(false);
        // Once closed and settled, what changed meanwhile is laid out for next time (see `_warmUp`); the
        // alert views keep their layout, unless the theme changed.
        this._later('warm', WARM_AFTER_CLOSE_MS, () => this._warmUp(!this._viewsWarm));
        if (!this._expandWanted)
            return;
        this._expandWanted = false;
        // Closed, the lyrics' pin is let go: it holds them open only until then.
        const music = this._expanded.pageNamed('music');
        if (music)
            music.pinned = false;
        this._nextAlert();
    }

    /** The page to open on: the one picked lately by hand, else one with something live, else music. */
    _defaultPage() {
        if (Date.now() - this._pagePickedAt < PAGE_MEMORY_MS)
            return null; // stay on the current page
        const page = DEFAULT_PAGE_ORDER.map(name => this._expanded.pageNamed(name)).find(p => p?.available && p.relevant);
        return page?.name ?? this._expanded.pages.find(p => p.available)?.name ?? null;
    }

    // Keyboard

    // Super+V (GNOME's calendar shortcut, taken over) opens the clipboard history, search ready, or the Calendar
    // page (Settings), and holds the island open without the pointer; Super+V again, Esc or a click elsewhere
    // closes it.
    _toggleFromKeyboard(page = 'clipboard') {
        // Hidden by a fullscreen window, it would take the keyboard unseen.
        if (!this._island.visible)
            return;
        const pageName = page === 'clipboard' ? 'shelf' : page;
        // A page's own shortcut while it has no tab (Devices with none connected, a page left out): nothing to open.
        if (pageName && !this._expanded.pageNamed(pageName)?.available)
            return;
        if (this._expandWanted && this._keyboardGrab) {
            // Open on that page (or on any, with no page asked for), it closes; on another, it turns to that one.
            if (!pageName || this._expanded.page === this._expanded.pageNamed(pageName)) {
                this.collapse();
                return;
            }
        }
        if (page !== 'clipboard') {
            this.expand(pageName);
            this._holdOpen();
            return;
        }
        this._shelf.showTab('clipboard');
        this.expand('shelf');
        this._holdOpen();
        if (this._keyboardGrab)
            this._shelf.showTab('clipboard', {focusSearch: true});
    }

    /** Turns the open island's tabs from the keyboard (see the key handler); whether `event` did. */
    _pageKey(event) {
        const state = event.get_state();
        if (!(state & Clutter.ModifierType.CONTROL_MASK) || state & (Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SUPER_MASK))
            return false;
        const key = event.get_key_symbol();
        const back = Boolean(state & Clutter.ModifierType.SHIFT_MASK);
        if (key === Clutter.KEY_Tab || key === Clutter.KEY_ISO_Left_Tab)
            this._expanded.stepPage(back || key === Clutter.KEY_ISO_Left_Tab ? -1 : 1);
        else if (key === Clutter.KEY_Page_Down || key === Clutter.KEY_Page_Up)
            this._expanded.stepPage(key === Clutter.KEY_Page_Down ? 1 : -1);
        else if (key >= Clutter.KEY_1 && key <= Clutter.KEY_9 && !back)
            this._expanded.showTab(key - Clutter.KEY_1 + 1);
        else
            return false;
        return true;
    }

    /** Each page's own shortcut (Settings), bound once: GNOME follows a key set or cleared later. They open the
     * island on that page as Super+V does (see `_toggleFromKeyboard`); none is set at first. */
    _bindPageShortcuts() {
        for (const page of SHORTCUT_PAGES) {
            Main.wm.addKeybinding(`shortcut-${page}`, this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
                () => this._toggleFromKeyboard(page));
        }
        this._pageShortcutsBound = true;
    }

    _unbindPageShortcuts() {
        if (!this._pageShortcutsBound)
            return;
        for (const page of SHORTCUT_PAGES)
            Main.wm.removeKeybinding(`shortcut-${page}`);
        this._pageShortcutsBound = false;
    }

    /** Opened without the pointer, it takes the keyboard: Esc or a click elsewhere closes it. */
    _holdOpen() {
        this._setKeyboard(true);
        if (!this._keyboardGrab) // another grab holds the keyboard: it closes once the pointer is not on it
            this._later('collapse', KEYBOARD_LESS_CLOSE_MS, () => {
                if (!this._island.hovered)
                    this._collapseUnlessHeld();
            });
    }

    /** Grabs the keyboard for typing into the island (e.g. a new task). */
    _setKeyboard(wanted) {
        if (wanted && !this._keyboardGrab) {
            const grab = Main.pushModal(this._island, {actionMode: Shell.ActionMode.POPUP});
            // Another grab (a menu, a dialog) may hold the keyboard already.
            if (!grabsKeyboard(grab)) {
                Main.popModal(grab);
                return;
            }
            this._keyboardGrab = grab;
            // Clicking anywhere else ends typing and closes the island. Watched on the island: under its grab
            // GNOME 46 hands it the presses outside too, and never shows them to the stage.
            this._stageCapture = this._island.connect('captured-event', (_island, event) => {
                // The shelf helper's window lies over the island: inside too.
                const press = [Clutter.EventType.BUTTON_PRESS, Clutter.EventType.TOUCH_BEGIN].includes(event.type());
                if (press && !this._shelfHelper.containsPointer() &&
                    !this._island.contains(global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, ...event.get_coords()))) {
                    this.collapse();
                    // Nothing in the island takes it; its release is let go in `_onClick`.
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
        } else if (!wanted && this._keyboardGrab) {
            // Clear the grab first: releasing it moves key focus, which can
            // make a text field ask to release it again.
            const grab = this._keyboardGrab;
            this._keyboardGrab = null;
            this._island.disconnect(this._stageCapture);
            Main.popModal(grab);
            // Left during the grab, the pointer told the island nothing: an alert would wait for it forever.
            // Read now, so the alert shown next is timed by where the pointer really is.
            this._island.syncHover();
            if (!this._island.hovered)
                this._later('collapse', COLLAPSE_DELAY_MS, () => this._collapseUnlessHeld());
        }
    }

    // Alerts

    /** Shows `alert` now, or queues it behind the one on screen. */
    _post(alert) {
        if (!alert)
            return;
        // Hidden by a fullscreen window: shown once it is gone, but a volume or Caps Lock change is stale by then.
        if (!this._island.visible) {
            if (!alert.transient)
                this._enqueue(alert);
            return;
        }
        if (this._alert && this._alert.key === alert.key) {
            this._showAlert(alert, {inPlace: true});
            return;
        }
        // The lyrics pinned open with no one at them: an alert must not wait behind them for as long as the pin may
        // last. They close (unpinned) and the alert shows; volume and the like are let pass, as when open.
        if (!alert.transient && this._lyricsHeld && !this._island.hovered && !this._keyboardGrab)
            this.collapse();
        if (this._expandWanted) {
            // Volume and the like are stale by the time the island closes.
            if (!alert.transient)
                this._enqueue(alert);
            return;
        }
        if (this._alert && alert.priority !== 'instant') {
            this._enqueue(alert);
            return;
        }
        // Shown again afterwards, unless it was a passing one (the volume) or answered; a critical notification stays.
        this._shelveAlert();
        this._showAlert(alert);
    }

    /** A system alert of `category` (power, network, bluetooth, caps-lock), if wanted; only a low battery gets
     * through Do Not Disturb. */
    _postSystemAlert(alert, category, urgent = false) {
        if (!alert || !this._settings.get_boolean(`alert-${category}`))
            return;
        if (this._notifications.dnd && !urgent)
            return;
        this._post(alert);
    }

    /** Queues `alert`, replacing one with its key; past a few waiting notifications, they merge into a summary. */
    _enqueue(alert) {
        this._queue = this._queue.filter(queued => queued.key !== alert.key);
        this._queue.push(alert);
        // Many notifications waiting (a long fullscreen video) come as one; each stays unread in the list.
        // With no list (the Notifications page left out), each comes on its own, to be read and clicked.
        if (this._expanded.pageNamed('notifications').hidden)
            return;
        const waiting = this._queue.filter(queued => queued.kind === 'notification' && queued.priority !== 'instant');
        const summary = this._queue.find(queued => queued.key === 'notifications-summary');
        if (waiting.length > (summary ? 0 : MAX_QUEUED_NOTIFICATIONS)) {
            // Counted once each, however often one was updated meanwhile.
            const items = new Set([...summary?.items ?? [], ...waiting.map(queued => queued.item)]);
            this._queue = this._queue.filter(queued => !waiting.includes(queued) && queued !== summary);
            this._queue.push(Alerts.notificationsSummary(items));
        }
    }

    /** `inPlace` for a newer version of the alert on screen (the volume moving): it doesn't animate in again. */
    _showAlert(alert, {inPlace = false} = {}) {
        // Another alert on screen takes the other view; the same one (the volume moving) updates in place.
        const turn = this._presentation === 'peek' && this._shownAlertKey !== alert.key;
        if (turn)
            this._peek = this._peeks[1 - this._peeks.indexOf(this._peek)];
        this._shownAlertKey = alert.key;
        this._alert = alert;
        try {
            if (!alert.shown) {
                alert.shown = true;
                alert.onShown?.();
            }
            this._peek.setAlert(alert, this._alertDone(alert), {fresh: !inPlace});
            // Shown on every display: the copies show it too.
            for (const mirror of this._mirrors)
                mirror.setAlert(alert, this._alertDone(alert), {inPlace, turn});
        } catch (e) {
            // One that can't be shown must not hold up those behind it, never timed out.
            console.warn(`Isle: could not show an alert: ${e.message}`);
            this._alert = null;
            this._shownAlertKey = null;
            this._nextAlert();
            return;
        }
        this._timeAlert();
        this._render();
        // Parts shown for the first time are only measured right once styled;
        // fit the island again then.
        this._later('alert-fit', ALERT_FIT_DELAY_MS, () => {
            if (this._presentation === 'peek')
                this._render();
        });
    }

    /** Its button does what it says, and that is the end of `alert` (not of one fading in over it). */
    _alertDone(alert) {
        return () => {
            if (this._alert === alert)
                this._dismissAlert(true);
        };
    }

    // An alert goes after its time; a reminder or a notification only counts it while someone is there.
    _timeAlert() {
        const alert = this._alert;
        if (!alert)
            return;
        // No one there: it waits on screen, a notification unread (see `_watchIdle`).
        if (waitsWhileAway(alert) && this._compact.idle) {
            this._cancel('alert');
            return;
        }
        // On screen with someone there: a notification is read.
        alert.onSeen?.();
        // Not while someone reads it (see `_onHoverChanged`).
        if (this._pointerOn && !alert.transient) {
            this._cancel('alert');
            return;
        }
        this._later('alert', alert.duration ?? 3000, () => this._dismissAlert(true));
    }

    /** Puts the alert away; with `showNext`, the next in line comes on. */
    _dismissAlert(showNext) {
        this._cancel('alert');
        if (this._alert && !this._alert.answered)
            this._alert.onDismissed?.();
        this._alert = null;
        if (showNext)
            this._nextAlert();
    }

    /** Puts the alert on screen back first in line, not put away; a passing or answered one just goes. */
    _shelveAlert() {
        const alert = this._alert;
        this._cancel('alert');
        this._alert = null;
        if (alert && !alert.transient && !alert.answered)
            this._queue.unshift(alert);
    }

    // Hidden by a fullscreen window: the alert on screen waits to be seen, its time not running out unseen.
    _onHidden() {
        this._shelveAlert();
        this._render();
    }

    /** Shows the first alert in line that still has something to say, once nothing else is on screen. */
    _nextAlert() {
        if (this._destroying)
            return;
        if (this._alert || !this._island.visible || this._expandWanted || !this._queue.length) {
            this._render();
            return;
        }
        // What waited may have been read, withdrawn or become private meanwhile.
        while (this._queue.length) {
            const queued = this._queue.shift();
            const alert = queued.fresh ? queued.fresh(this._sharing) : queued;
            if (alert) {
                this._showAlert(alert);
                return;
            }
        }
        this._render();
    }

    /** Volume or brightness as an alert in place of GNOME's OSD. `displays`, for an OSD about some displays only
     * (brightness: {index: {level, maxLevel}}), or null for one about all (volume). Returns true when the island
     * shows it all, false to let GNOME show its own, or the indexes of the displays the island showed it for, GNOME
     * showing it on the others. */
    _showOsd(icon, label, level, maxLevel, displays = null) {
        if (!this._settings.get_boolean('replace-osd') || !this._island.visible)
            return false;
        // While the island is open the OSD would cover it; let GNOME show it.
        if (this._expandWanted)
            return false;
        const own = this._monitor?.index;
        if (displays) {
            // The island's own display's (the laptop's brightness, say) is the island's wherever the pointer is: its
            // change is on that display, and GNOME's own there flickered as it showed and took back one display's
            // after another. Another display's stays GNOME's, on that display; with a copy of the island on each,
            // the island shows them all.
            const mine = displays[own] ?? (this._mirrors.length ? Object.values(displays).find(Boolean) : null);
            if (!mine)
                return false;
            this._postOsd(icon, label, mine.level, mine.maxLevel);
            return this._mirrors.length ? true : [own];
        }
        // Working on another display, the user would not see it: GNOME shows its own there. Not with a copy of
        // the island on each display, which shows it too.
        if (Main.layoutManager.monitors.length > 1 && !this._mirrors.length && global.display.get_current_monitor() !== own)
            return false;
        this._postOsd(icon, label, level, maxLevel);
        return true;
    }

    /** Shows an OSD as the island's alert. */
    _postOsd(icon, label, level, maxLevel) {
        const alert = Alerts.osd(icon, label, level, maxLevel);
        // Pressing on at 0% or 100% stretches the island like a rubber band.
        const atLimit = alert.level !== null && (alert.level >= 1 || alert.level <= 0);
        const repeated = this._alert?.key === 'osd' && this._alert.title === alert.title &&
            this._alert.level === alert.level;
        this._post(alert);
        if (atLimit && repeated)
            this._island.nudge();
    }

    /** A new song that starts playing peeks in, if Settings want that. */
    _onNowPlaying() {
        const nowPlaying = this._daemon.state.nowPlaying;
        const track = Playback.hasTrack(nowPlaying) ? `${nowPlaying.title}\u001f${nowPlaying.artist}` : null;
        const changed = track !== this._lastTrack;
        this._lastTrack = track;
        if (changed && track && Playback.isPlaying(nowPlaying) && this._settings.get_boolean('track-peek') &&
            !this._notifications.dnd && !this._expanded.pageNamed('music').hidden)
            this._post(Alerts.track(nowPlaying));
    }

    // isled gone (a crash, or stopped by hand): started again once; still gone, the island says so and offers
    // to restart it, with a warning on the closed island meanwhile.
    _onServiceChanged() {
        if (this._daemon.running) {
            this._cancel('service-check');
            this._setCompact('serviceDown', false);
            if (this._alert?.key === 'service-down')
                this._dismissAlert(true);
            this._queue = this._queue.filter(queued => queued.key !== 'service-down');
            return;
        }
        this._later('service-check', SERVICE_GRACE_MS, () => {
            this._daemon.start();
            this._later('service-check', SERVICE_GRACE_MS, () => {
                if (this._daemon.running)
                    return;
                this._setCompact('serviceDown', true);
                this._post(Alerts.serviceDown(() => this._daemon.start()));
            });
        });
    }

    /** Whether others may see the screen now: shared, or recorded. */
    get _sharing() {
        return this._privacy.screenShare || this._privacy.recording;
    }

    /** While others can see the screen, private text leaves the shelf, the notifications and the alert shown. */
    _syncSharing() {
        this._shelf.sharing = this._sharing;
        this._expanded.pageNamed('notifications').sharing = this._sharing;
        // A message on screen as sharing starts loses its text at once; one gone meanwhile goes.
        const redone = this._alert?.fresh?.(this._sharing);
        if (this._alert?.fresh && !redone)
            this._dismissAlert(true);
        else if (redone && redone !== this._alert)
            this._showAlert(redone, {inPlace: true});
    }

    // Updates

    /** Tells isled whether to look for new versions. */
    _syncUpdates() {
        this._daemon.call('updates', 'SetEnabled', this._settings.get_boolean('check-updates'));
    }

    /** A newer Isle is out: said once per version; in Do Not Disturb, next time Isle starts. */
    _onLatest() {
        const latest = this._daemon.state.updates;
        if (!latest || latest === this._settings.get_string('update-shown') || this._notifications.dnd)
            return;
        this._settings.set_string('update-shown', latest);
        // Settings' About page has the Update button (or, for a package, how to update it).
        this._post(Alerts.update(latest, () => {
            this._settings.set_string('prefs-page', 'about');
            this._extension.openPreferences();
        }, this._extension.path.startsWith('/usr/')));
    }

    /** Takes the alert with `key` away, shown or waiting its turn; one answered on screen goes once its answer
     * has shown ("Running"). */
    _withdrawAlert(key) {
        this._queue = this._queue.filter(alert => alert.key !== key);
        if (this._alert?.key === key && !this._alert.answered) {
            this._alert.answered = true;
            this._dismissAlert(true);
        }
    }

    // Phone sharing: a phone asking to connect gets an alert to answer (the Phone tab asks too); one answered
    // there, or given up on, goes.
    _onShare() {
        const state = this._daemon.state.share;
        const asking = state?.active ? state.asking ?? [] : [];
        const keys = new Set(asking.map(ask => `phone-ask:${ask.id}`));
        for (const key of this._phoneAsks ?? []) {
            if (!keys.has(key))
                this._withdrawAlert(key);
        }
        for (const ask of asking) {
            if (!this._phoneAsks?.has(`phone-ask:${ask.id}`))
                this._post(Alerts.phoneAsks(ask, allow => this._daemon.call('share', 'Answer', ask.id, allow)));
        }
        this._phoneAsks = keys;
        // Stopped because this computer's network changed: said once, so it isn't a mystery.
        if (this._wasSharing && !state?.active && state?.ended === 'network')
            this._post(Alerts.sharingStopped());
        this._wasSharing = Boolean(state?.active);
    }

    /** Copies `uri` into Downloads (off the shell's thread), then says so, with Show; or why not. */
    async _saveToDownloads(uri) {
        // Only a copy the Shelf keeps itself, whoever asks (the helper's Save signal included).
        if (!isShelfCopy(uri))
            return;
        this._saving ??= new Gio.Cancellable();
        try {
            const file = await saveToDownloads(uri, this._saving);
            // Already being saved: the first press says how it went.
            if (file && !this._destroying)
                this._post(Alerts.savedToDownloads(file.get_basename(), () => showInFiles(file)));
        } catch (e) {
            if (!this._destroying && !this._saving.is_cancelled())
                this._post(Alerts.saveFailed(e.message));
        }
    }

    // A file came from a phone: one alert counts those that come together, as long as it is up or waiting.
    _onPhoneReceived(name) {
        const waiting = [this._alert, ...this._queue].some(alert => alert?.key === 'phone-received');
        this._phoneNames = waiting ? [...this._phoneNames ?? [], name] : [name];
        this._post(Alerts.phoneReceived(this._phoneNames, () => this._shelf.showTab('files')));
    }

    /** Plays a theme sound, if chimes are on. */
    _chime(soundName) {
        if (this._settings.get_boolean('chimes'))
            global.display.get_sound_player().play_from_theme(soundName, 'Isle', null);
    }

    // Idle

    /** Marks the user away after a minute without input (sooner on battery), so animations rest. */
    _watchIdle() {
        const monitor = global.backend.get_core_idle_monitor();
        const rest = () => {
            this._setCompact('idle', true);
            // Away: a reminder or a notification on screen waits for them.
            if (this._alert && waitsWhileAway(this._alert))
                this._cancel('alert');
            if (!this._activeWatch) {
                this._activeWatch = monitor.add_user_active_watch(() => {
                    this._activeWatch = 0;
                    this._setCompact('idle', false);
                    // Back: one that waited is seen, and starts its time now.
                    this._timeAlert();
                });
            }
        };
        this._idleWatch = monitor.add_idle_watch(IDLE_MS, rest);
        this._batteryIdleWatch = monitor.add_idle_watch(IDLE_ON_BATTERY_MS, () => {
            const battery = this._daemon.state.system?.battery;
            if (battery && !battery.plugged)
                rest();
        });
    }

    // Timeouts

    /** Runs `callback` after `ms`, replacing a pending one of the same name; nothing once tearing down. */
    _later(name, ms, callback) {
        if (this._destroying)
            return;
        this._cancel(name);
        this._timeouts.set(name, GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(name);
            callback();
            return GLib.SOURCE_REMOVE;
        }));
    }

    /** Drops the named timeout, if pending. */
    _cancel(name) {
        const id = this._timeouts.get(name);
        if (id) {
            GLib.source_remove(id);
            this._timeouts.delete(name);
        }
    }

    /** Turns Isle off: all it built is torn down. */
    destroy() {
        // Failed to start: what it built went then.
        if (this._failed)
            return;
        // Turned off while still being built (locked at once): only what was built goes.
        if (this._building) {
            GLib.source_remove(this._building);
            this._building = 0;
            this._destroyPartial();
            return;
        }
        this._stopRevealWait();
        // Sharing with a phone never outlives Isle (the screen locking turns it off too): asked whatever the
        // state last said (a Start may be on its way), but never starting isled just for that.
        if (this._daemon.running)
            this._daemon.call('share', 'Stop');
        // What waits goes with Isle, never shown (a notification marked read, its sound played) as it goes.
        this._queue = [];
        Alerts.stopWatching();
        this._disconnectScheme();
        Main.layoutManager.uiGroup.disconnect(this._panelAdded);
        if (this._focusChanged)
            global.display.disconnect(this._focusChanged);
        this._focusChanged = 0;
        global.display.disconnect(this._focusMonitorChanged);
        global.display.disconnect(this._fullscreenChanged);
        this._unbindPageShortcuts();
        // Releasing the keyboard may schedule a collapse; cancel it after. Tearing down schedules nothing.
        this._setKeyboard(false);
        for (const name of [...this._timeouts.keys()])
            this._cancel(name);
        this._destroying = true;
        this._saving?.cancel();

        const monitor = global.backend.get_core_idle_monitor();
        if (this._idleWatch)
            monitor.remove_watch(this._idleWatch);
        if (this._batteryIdleWatch)
            monitor.remove_watch(this._batteryIdleWatch);
        if (this._activeWatch)
            monitor.remove_watch(this._activeWatch);

        this._settingsChanged.forEach(id => this._settings.disconnect(id));
        Main.layoutManager.disconnect(this._monitorsChanged);
        this._releaseScanout();
        this._osd.destroy();
        this._keyboard.destroy();
        this._shelfHelper.destroy();
        this._reminders.destroy();
        // Ending focus mode can turn Do Not Disturb off, which the views
        // still show.
        this._focusMode.destroy();

        // The views listen to the services below, so they go first.
        this._destroyMirrors();
        this._island.destroy();
        this._appUsage.destroy();
        this._clipboard.destroy();
        this._call.destroy();
        this._privacy.destroy();
        this._audio.destroy();
        this._notifications.destroy();
        this._topBar.destroy();
        this._lyrics?.destroy();
        this._lyricsHttp?.destroy();
        this._daemon.destroy();
        this._settings = null;
        Format.release();
    }

    /** Lets GNOME send windows straight to the screen again, as it was before Isle (see `_syncScanout`). */
    // Hide Top Bar adds the bar again, over the island, which then never gets the pointer: put it back below.
    _keepAbovePanel() {
        const group = Main.layoutManager.uiGroup;
        const children = group.get_children();
        // Below the lowest of the island and its copies, one of which may be in the bar.
        const lowest = [this._island, ...this._mirrors.map(mirror => mirror.island)]
            .reduce((low, island) => children.indexOf(island) < children.indexOf(low) ? island : low);
        if (children.indexOf(Main.layoutManager.panelBox) > children.indexOf(lowest))
            group.set_child_below_sibling(Main.layoutManager.panelBox, lowest);
    }

    _releaseScanout() {
        this._scanoutWatches?.forEach(([source, id]) => source.disconnect(id));
        this._scanoutWatches = null;
        if (this._scanoutInhibited)
            inhibitScanout(false);
        this._scanoutInhibited = false;
    }

    /** Frees what the steps of building (see the constructor) made before it was turned off: nothing
     * outside knows of it yet, but for what it built. */
    _destroyPartial() {
        this._destroying = true;
        for (const name of [...this._timeouts.keys()])
            this._cancel(name);
        // What the last step had connected before it failed (see `_connectAll`).
        Alerts.stopWatching();
        this._disconnectScheme();
        if (this._panelAdded)
            Main.layoutManager.uiGroup.disconnect(this._panelAdded);
        for (const id of [this._focusChanged, this._focusMonitorChanged, this._fullscreenChanged].filter(Boolean))
            global.display.disconnect(id);
        this._focusChanged = 0;
        this._unbindPageShortcuts();
        this._setKeyboard(false);
        const monitor = global.backend.get_core_idle_monitor();
        for (const watch of [this._idleWatch, this._batteryIdleWatch, this._activeWatch].filter(Boolean))
            monitor.remove_watch(watch);
        this._settingsChanged?.forEach(id => this._settings.disconnect(id));
        if (this._monitorsChanged)
            Main.layoutManager.disconnect(this._monitorsChanged);
        this._releaseScanout();
        for (const part of [this._osd, this._keyboard, this._reminders])
            part?.destroy();
        this._shelfHelper?.destroy();
        // The views are the island's once it is on screen (see `_buildIsland`); before, each goes by itself.
        if (!this._island?.get_parent()) {
            for (const view of [this._compact, ...this._peeks ?? [], this._expanded])
                view?.destroy();
            if (!this._expanded)
                this._pages.forEach(page => page.destroy());
        }
        this._destroyMirrors();
        this._island?.destroy();
        for (const service of [this._topBar, this._appUsage, this._clipboard, this._focusMode, this._call,
            this._privacy, this._audio, this._notifications, this._daemon])
            service?.destroy();
        this._settings = null;
        Format.release();
    }
}
