// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 stefan-hacks


import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {DesktopAppInfo} from './src/appInfo.js';
import {DEFAULT_ORDER, PROVIDERS} from './src/lyricsProviders.js';
import {movePage, pageOrder, storedOrder} from './src/pageOrder.js';
import {listenForSuperV} from './src/shortcutRecorder.js';
import * as WorldClocks from './src/worldClocks.js';
import {getBundleNames} from './src/themeBundles.js';

const DAEMON = 'io.github.stefanhacks.gnomeisland.Daemon';
const DAEMON_PATH = '/io/github/stefanhacks/gnomeisland/Daemon';
const POMODORO_INTERFACE = 'io.github.stefanhacks.gnomeisland.Pomodoro1';
const CLIPBOARD_INTERFACE = 'io.github.stefanhacks.gnomeisland.Clipboard1';
/** Edits to the timer are sent once typing pauses for this long. */
const SAVE_DELAY_MS = 400;

// Runs in a process of its own when Settings opens, never inside GNOME Shell.
export default class IslePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(560, 680);
        window.add(this._islandPage(settings, window));
        window.add(this._musicPlayerPage(settings, window));
        window.add(this._clipboardPage(settings, window));
        window.add(this._timerPage(settings, window));
        window.add(this._autoThemePage(settings, window));
        window.add(this._aboutPage(settings, window));
        // A page asked for by the island (its Update button: About), once, also while open.
        const showAsked = () => {
            const asked = settings.get_string('prefs-page');
            if (!asked)
                return false;
            settings.reset('prefs-page');
            window.visible_page_name = asked;
            return true;
        };
        // Asked while open (perhaps behind other windows): brought forward too.
        const asked = settings.connect('changed::prefs-page', () => showAsked() && window.present());
        window.connect('close-request', () => {
            settings.disconnect(asked);
            return false;
        });
        showAsked();
    }

    // The music player's own settings: where lyrics come from (and the keys some need), and cava's bars behind them.
    _musicPlayerPage(settings, window) {
        const page = new Adw.PreferencesPage({title: 'Music player', name: 'music-player', icon_name: 'audio-x-generic-symbolic'});
        page.add(lyricsProvidersGroup(settings, window));
        page.add(apiKeysGroup(settings, window));
        page.add(cavaGroup(settings));
        return page;
    }

    // The version, where to get help, a bug report to paste, and a way back to the defaults.
    _aboutPage(settings, window) {
        const page = new Adw.PreferencesPage({title: 'About', name: 'about', icon_name: 'help-about-symbolic'});
        const about = new Adw.PreferencesGroup({title: `GNOME Island ${this.metadata['version-name'] ?? ''}`.trim(),
            description: 'A notch-style island for GNOME. © 2026 stefan-hacks, free software under the GPL.'});
        const link = (title, subtitle, url) => {
            const row = new Adw.ActionRow({title, subtitle, activatable: true});
            row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
            row.connect('activated', () => new Gtk.UriLauncher({uri: url}).launch(window, null, null));
            return row;
        };
        // Whether a newer Isle is out, as isled last found, and the switch for asking.
        for (const row of updateRows(settings, window, this.metadata['version-name'] ?? '', this.path))
            about.add(row);
        about.add(link('Website', 'Features, installing and updating', 'https://github.com/stefan-hacks/gnome-island'));
        about.add(link('Report a problem', 'On GitHub; paste the report below in it', 'https://github.com/stefan-hacks/gnome-island/issues/new/choose'));
        const report = new Adw.ActionRow({title: 'Copy a bug report', subtitle: 'What’s installed, what works, and recent activity, ready to paste into a report',
            activatable: true});
        report.add_suffix(new Gtk.Image({icon_name: 'edit-copy-symbolic'}));
        report.connect('activated', () => copyReport(window, report));
        about.add(report);
        page.add(about);

        const reset = new Adw.PreferencesGroup({title: 'Settings'});
        const resetRow = new Adw.ActionRow({title: 'Reset all settings', subtitle: 'Back to how Isle came; your data stays',
            activatable: true});
        resetRow.connect('activated', () => confirm(window, {
            heading: 'Reset all of Isle’s settings?',
            body: 'Every option goes back to its default. Your tasks, events, clipboard history and files stay.',
            action: 'Reset',
        }, () => {
            // Not Isle's state: which update was announced, the page asked for, and a focus session's Do Not Disturb.
            const state = ['update-shown', 'prefs-page', 'focus-dnd-owned', 'focus-dnd-declined'];
            for (const key of settings.settings_schema.list_keys().filter(key => !state.includes(key)))
                settings.reset(key);
            // The timer's lengths, kept by isled: an empty config is its defaults.
            Gio.DBus.session.call(DAEMON, DAEMON_PATH, POMODORO_INTERFACE, 'SetConfig', new GLib.Variant('(s)', ['{}']),
                null, Gio.DBusCallFlags.NONE, -1, null, null);
        }));
        reset.add(resetRow);
        page.add(reset);
        return page;
    }

    // AI features removed in this fork.


    // History on or off, clearing it, and the apps whose copies are never kept.
    _clipboardPage(settings, window) {
        const page = new Adw.PreferencesPage({title: 'Clipboard', icon_name: 'edit-paste-symbolic'});

        const history = new Adw.PreferencesGroup({
            title: 'Clipboard History',
            description: 'Everything stays on this computer.',
        });
        const keep = switchRow(settings, 'clipboard-history', 'Keep clipboard history',
            'Text, links, images and files you copy. Passwords from password managers are never kept.');
        history.add(keep);
        // Its shortcut is set with the others' (Island → Shortcuts), so a page never has two: said here.
        const describe = () => {
            const off = settings.get_strv('hidden-pages').includes('shelf');
            keep.sensitive = !off;
            const shortcut = superVPage(settings) === 'shelf' && !settings.get_strv('shortcut-shelf').length ? 'Super+V'
                : settings.get_strv('shortcut-shelf')[0] ? Gtk.accelerator_get_label(...parsedAccelerator(settings.get_strv('shortcut-shelf')[0]))
                    : null;
            history.description = off ? 'Off while the Shelf page is off (Island → Pages).'
                : `${shortcut ? `${shortcut} opens it` : 'No shortcut opens it'} (Island → Shortcuts). Everything stays on this computer.`;
        };
        const described = ['hidden-pages', 'super-v', 'shortcut-shelf'].map(key => settings.connect(`changed::${key}`, describe));
        window.connect('close-request', () => {
            described.forEach(id => settings.disconnect(id));
            return false;
        });
        describe();
        history.add(choiceRow(settings, 'clipboard-layout', 'Layout', 'How copied items are arranged', [
            ['horizontal', 'Horizontal'],
            ['vertical', 'Vertical'],
        ]));
        const columns = new Adw.ActionRow({
            title: 'Columns',
            subtitle: 'Cards per row in vertical layout',
        });
        const columnsBox = new Gtk.Box({css_classes: ['linked'], valign: Gtk.Align.CENTER});
        let firstColumn = null;
        const columnButtons = [1, 2, 3].map(n => {
            const button = new Gtk.ToggleButton({
                label: String(n),
                ...(firstColumn ? {group: firstColumn} : {}),
            });
            firstColumn ??= button;
            button.connect('toggled', () => {
                if (button.active && settings.get_int('clipboard-columns') !== n)
                    settings.set_int('clipboard-columns', n);
            });
            columnsBox.append(button);
            return [n, button];
        });
        const syncColumns = () => {
            const current = settings.get_int('clipboard-columns');
            for (const [n, button] of columnButtons)
                button.active = current === n;
        };
        syncColumns();
        const columnsChanged = settings.connect('changed::clipboard-columns', syncColumns);
        columns.connect('destroy', () => settings.disconnect(columnsChanged));
        columns.add_suffix(columnsBox);
        columns.visible = settings.get_string('clipboard-layout') === 'vertical';
        history.add(columns);
        const width = Adw.SpinRow.new_with_range(400, 1200, 20);
        width.title = 'Width';
        width.subtitle = 'In pixels';
        settings.bind('clipboard-width', width, 'value', Gio.SettingsBindFlags.DEFAULT);
        history.add(width);
        const height = Adw.SpinRow.new_with_range(150, 800, 20);
        height.title = 'Height';
        height.subtitle = 'In pixels';
        settings.bind('clipboard-height', height, 'value', Gio.SettingsBindFlags.DEFAULT);
        const layoutChanged = settings.connect('changed::clipboard-layout', () => {
            const vertical = settings.get_string('clipboard-layout') === 'vertical';
            columns.visible = vertical;
            const current = settings.get_int('clipboard-height');
            if (vertical && current === 150)
                settings.set_int('clipboard-height', 360);
            else if (!vertical && current === 360)
                settings.reset('clipboard-height');
        });
        height.connect('destroy', () => settings.disconnect(layoutChanged));
        history.add(height);
        history.add(switchRow(settings, 'clipboard-paste-keyboard', 'Auto-paste with keyboard',
            'Pressing Enter pastes into the active window; when off, it only copies'));
        history.add(switchRow(settings, 'clipboard-paste-mouse', 'Auto-paste on click',
            'Clicking an item pastes into the active window; when off, it only copies'));
        const clear = new Adw.ActionRow({title: 'Clear history', subtitle: 'Pinned items are kept'});
        const clearButton = new Gtk.Button({label: 'Clear…', valign: Gtk.Align.CENTER});
        clearButton.connect('clicked', () => confirmClear(window));
        clear.add_suffix(clearButton);
        history.add(clear);
        page.add(history);

        const ignored = new Adw.PreferencesGroup({
            title: 'Never Keep Copies From',
            description: 'Known password managers are on the list from the start.',
        });
        page.add(ignored);
        fillIgnoredApps(ignored, settings);
        return page;
    }

    // Look, pages, world clocks, alerts and calls.
    _islandPage(settings, window) {
        const page = new Adw.PreferencesPage({title: 'Island', icon_name: 'preferences-desktop-appearance-symbolic'});

        const look = new Adw.PreferencesGroup({title: 'Appearance'});
        look.add(switchRow(settings, 'preview-settings', 'Preview changes',
            'While a setting changes here, the island opens on what it changes for a few seconds, then closes'));
        look.add(choiceRow(settings, 'island-shape', 'Shape', 'Joined to the top of the screen, or floating free', [
            ['notch', 'Notch'],
            ['pill', 'Pill'],
        ]));
        look.add(switchRow(settings, 'top-bar-color', 'Colour the top bar',
            'Turn off to let your theme or another extension style the bar'));
        look.add(topBarRow(settings, window));
        look.add(blackBesideWindowsRow(settings, window));
        look.add(switchRow(settings, 'compact-top-bar', 'Compact top bar', 'Smaller text and spacing in the top bar; slimmer too with the island below it'));
        look.add(switchRow(settings, 'island-in-top-bar', 'Island inside the top bar',
            'Like a notch: the closed island never covers windows'));
        // One of the two, as the notch sits: below the bar, or inside it. A pill sizes itself.
        const depth = spinRow(settings, 'notch-depth', 'Island height', 'How far the closed island hangs below the top bar, in pixels', 24, 40);
        look.add(depth);
        const gap = switchRow(settings, 'notch-gap', 'Space below the island',
            'A little room between the closed island and the windows below');
        look.add(gap);
        const byShape = () => {
            const notch = settings.get_string('island-shape') === 'notch';
            const inBar = settings.get_boolean('island-in-top-bar');
            depth.visible = notch && !inBar;
            gap.visible = notch && inBar;
        };
        const shapeChanged = ['island-shape', 'island-in-top-bar'].map(key => settings.connect(`changed::${key}`, byShape));
        window.connect('close-request', () => {
            shapeChanged.forEach(id => settings.disconnect(id));
            return false;
        });
        byShape();
        // Every clock row together: the format, then the island's clock, then the top bar's.
        look.add(choiceRow(settings, 'clock-format', 'Time format', '12- or 24-hour, wherever Isle shows the time', [
            ['system', 'As GNOME'],
            ['24h', '24-hour (20:40)'],
            ['12h', '12-hour (8:40 PM)'],
        ]));
        look.add(switchRow(settings, 'island-clock', 'Clock in the island',
            'Turn off for an empty island; the open island still shows the time'));
        const date = switchRow(settings, 'clock-date', 'Show the date', 'The day beside the time on the closed island, as “Fri 6”');
        settings.bind('island-clock', date, 'sensitive', Gio.SettingsBindFlags.GET);
        look.add(date);
        look.add(choiceRow(settings, 'top-bar-clock', 'Clock in the top bar',
            'An extra clock at the left or right end of the bar. Click it to open the calendar', [
                ['off', 'Off'],
                ['left', 'Left'],
                ['right', 'Right'],
            ]));
        look.add(barClockShowsRow(settings));
        look.add(switchRow(settings, 'compact-song-title', 'Song title in the island',
            'While music plays, the closed island shows the song’s title and artist in place of the clock'));
        const titleWidth = spinRow(settings, 'compact-title-width', 'Longest song title',
            'The island widens for a long title and artist up to this width, in pixels; past it they scroll', 80, 600);
        // Only while the title shows.
        settings.bind('compact-song-title', titleWidth, 'sensitive', Gio.SettingsBindFlags.GET);
        look.add(titleWidth);
        look.add(switchRow(settings, 'mini-bars-cover-color', 'Cover colour for the bars',
            'The little bars beside the song in the closed island take the cover’s main colour instead of white'));
        look.add(switchRow(settings, 'dnd-icon', 'Do Not Disturb moon',
            'A moon in the island while Do Not Disturb is on; Do Not Disturb stays on either way'));
        look.add(switchRow(settings, 'keep-gnome-clock', 'Keep GNOME’s clock',
            'GNOME’s own clock and its calendar stay in the top bar, to the right, out from under the island'));
        look.add(choiceRow(settings, 'open-size', 'Size', 'The open island, every page', [
            ['standard', 'Standard'],
            ['large', 'Large'],
        ]));
        look.add(switchRow(settings, 'privacy-indicators', 'Privacy indicators', 'Dots when the camera, microphone or screen sharing is in use'));
        look.add(choiceRow(settings, 'island-monitor', 'Display', 'With more than one display, where the island is', [
            ['primary', 'Main display'],
            ['active', 'Display in use'],
            ['all', 'All displays'],
        ]));
        look.add(choiceRow(settings, 'open-on', 'Open', 'How the closed island opens', [
            ['hover', 'On hover'],
            ['click', 'On click'],
        ]));
        const delay = Adw.SpinRow.new_with_range(60, 1000, 20);
        delay.title = 'Rest before opening';
        delay.subtitle = 'In milliseconds';
        settings.bind('hover-delay', delay, 'value', Gio.SettingsBindFlags.DEFAULT);
        const byHover = () => (delay.sensitive = settings.get_string('open-on') === 'hover');
        const openOnChanged = settings.connect('changed::open-on', byHover);
        delay.connect('destroy', () => settings.disconnect(openOnChanged));
        byHover();
        look.add(delay);
        look.add(choiceRow(settings, 'auto-hide', 'Auto-hide', 'Hide the closed island; alerts still show, and pointing at its place brings it back', [
            ['off', 'Off'],
            ['always', 'Always'],
            ['top-bar', 'With the top bar'],
            ['windows', 'Beside windows'],
        ]));
        // The wait only counts where the island hides on its own: not with a bar that hides.
        const hideDelay = spinRow(settings, 'auto-hide-delay', 'Hide after', 'Seconds without the pointer on the island', 1, 60);
        const waits = () => (hideDelay.sensitive = ['always', 'windows'].includes(settings.get_string('auto-hide')));
        const waitsChanged = settings.connect('changed::auto-hide', waits);
        hideDelay.connect('destroy', () => settings.disconnect(waitsChanged));
        waits();
        look.add(hideDelay);
        page.add(look);
        page.add(pagesGroup(settings, window));
        // "gnome", from before, opens the island's calendar now: shown as that.
        if (settings.get_string('super-v') === 'gnome')
            settings.set_string('super-v', 'calendar');
        page.add(shortcutsGroup(settings));
        page.add(appUsageGroup(settings, window));
        page.add(worldClocksGroup(settings, window));

        const alerts = new Adw.PreferencesGroup({title: 'Alerts'});
        // On: in the island; off: left to GNOME's own banners (`gnome-banners`).
        const notifications = new Adw.SwitchRow({title: 'Notifications',
            subtitle: 'Apps’ notifications in the island, with their buttons, as GNOME shows them'});
        settings.bind('gnome-banners', notifications, 'active', Gio.SettingsBindFlags.INVERT_BOOLEAN);
        alerts.add(notifications);
        alerts.add(switchRow(settings, 'replace-osd', 'Volume and brightness', 'Show them in the island instead of the centre of the screen'));
        alerts.add(switchRow(settings, 'alerts-over-fullscreen', 'Over full-screen apps',
            'Alerts show over a video or game, then hide again; off, they wait until it leaves full screen'));
        alerts.add(switchRow(settings, 'alert-power', 'Charging and battery', 'Plugged in, unplugged, full and low'));
        alerts.add(switchRow(settings, 'alert-network', 'Network', 'When the connection drops'));
        alerts.add(switchRow(settings, 'alert-bluetooth', 'Bluetooth', 'Devices connecting, with their battery'));
        alerts.add(switchRow(settings, 'alert-bluetooth-battery', 'Bluetooth battery',
            'A device’s battery low, at 20, 10 and 5%'));
        alerts.add(switchRow(settings, 'alert-caps-lock', 'Caps Lock', 'When it turns on or off'));
        alerts.add(switchRow(settings, 'event-alerts', 'Calendar events',
            'Before each event with a time, with Join for a Meet, Zoom or Teams link'));
        const eventMinutes = spinRow(settings, 'event-alert-minutes', 'Minutes before an event', null, 1, 60);
        settings.bind('event-alerts', eventMinutes, 'sensitive', Gio.SettingsBindFlags.GET);
        alerts.add(eventMinutes);
        alerts.add(switchRow(settings, 'track-peek', 'New song', 'Briefly show the song when the track changes'));
        alerts.add(switchRow(settings, 'lyrics-online', 'Lyrics', 'Look up the playing song’s lyrics online, at the providers chosen under Music player'));
        alerts.add(switchRow(settings, 'chimes', 'Sounds', 'Chime when a focus session or break ends, and for reminders'));
        page.add(alerts);

        const calls = new Adw.PreferencesGroup({
            title: 'Calls',
            description: 'WhatsApp, Telegram, Meet and other calls, in any app or browser.',
        });
        calls.add(switchRow(settings, 'call-activity', 'Calls in the island', 'The call’s length, mute and a way back to it'));
        const preview = switchRow(settings, 'call-preview', 'Live preview',
            'See yourself and whoever you call, live in the open island');
        settings.bind('call-activity', preview, 'sensitive', Gio.SettingsBindFlags.GET);
        calls.add(preview);
        page.add(calls);
        return page;
    }

    // Lengths live in isled, so this page needs it running; changes are saved as typing pauses.
    _timerPage(settings, window) {
        const page = new Adw.PreferencesPage({title: 'Timer', icon_name: 'alarm-symbolic'});
        const focus = new Adw.PreferencesGroup({title: 'While Focusing'});
        focus.add(switchRow(settings, 'focus-dnd', 'Do Not Disturb', 'Silence notifications during focus sessions, and restore them afterwards'));
        page.add(focus);

        const group = new Adw.PreferencesGroup({
            title: 'Pomodoro',
            description: 'Focus sessions with short breaks, and a long break after a few sessions.',
        });
        page.add(group);

        let proxy = null;
        let config = null;
        try {
            proxy = Gio.DBusProxy.new_for_bus_sync(Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE,
                null, DAEMON, DAEMON_PATH, POMODORO_INTERFACE, null);
            config = JSON.parse(proxy.get_cached_property('Config')?.unpack() ?? 'null');
        } catch (e) {
            console.warn(`Isle: could not read the timer settings: ${e.message}`);
        }
        if (!config) {
            group.add(new Adw.ActionRow({
                title: 'The timer settings aren’t available right now',
                subtitle: 'Isle isn’t running in the background. Log out and back in, or install Isle again.',
            }));
            return page;
        }

        let saveId = 0;
        const save = () => {
            if (saveId)
                GLib.source_remove(saveId);
            saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS, () => {
                saveId = 0;
                proxy.call('SetConfig', new GLib.Variant('(s)', [JSON.stringify(config)]),
                    Gio.DBusCallFlags.NONE, -1, null, null);
                return GLib.SOURCE_REMOVE;
            });
        };
        // Don't lose the last change when the window closes before it is saved.
        window.connect('close-request', () => {
            if (!saveId)
                return false;
            GLib.source_remove(saveId);
            saveId = 0;
            try {
                proxy.call_sync('SetConfig', new GLib.Variant('(s)', [JSON.stringify(config)]),
                    Gio.DBusCallFlags.NONE, -1, null);
            } catch (e) {
                console.warn(`Isle: could not save the timer settings: ${e.message}`);
            }
            return false;
        });
        // Each row, by its key, with the property it shows: set anew when isled's config changes.
        const rows = [];
        const number = (key, title, min, max) => {
            const row = Adw.SpinRow.new_with_range(min, max, 1);
            row.title = title;
            row.value = config[key];
            row.connect('notify::value', () => {
                if (config[key] === row.value)
                    return;
                config[key] = row.value;
                save();
            });
            rows.push([key, row, 'value']);
            return row;
        };
        const toggle = (key, title, subtitle) => {
            const row = new Adw.SwitchRow({title, subtitle, active: config[key]});
            row.connect('notify::active', () => {
                if (config[key] === row.active)
                    return;
                config[key] = row.active;
                save();
            });
            rows.push([key, row, 'active']);
            return row;
        };
        // Changed elsewhere (Reset all settings): the rows follow, unless a change here is still to be saved.
        const configChanged = proxy.connect('g-properties-changed', (_proxy, changed) => {
            // Only the lengths: the timer starting or ending a phase changes State, and leaves the rows be.
            if (!changed.deepUnpack().Config)
                return;
            let next;
            try {
                next = JSON.parse(proxy.get_cached_property('Config')?.unpack() ?? 'null');
            } catch {
                return;
            }
            if (!next || saveId)
                return;
            config = next;
            for (const [key, row, property] of rows)
                row[property] = config[key];
        });
        window.connect('close-request', () => {
            proxy.disconnect(configChanged);
            return false;
        });

        group.add(number('focus_minutes', 'Focus (minutes)', 1, 180));
        group.add(number('short_break_minutes', 'Short break (minutes)', 1, 60));
        group.add(number('long_break_minutes', 'Long break (minutes)', 1, 120));
        group.add(number('sessions_before_long_break', 'Sessions before a long break', 1, 12));
        group.add(toggle('auto_start_breaks', 'Start breaks automatically', null));
        group.add(toggle('auto_start_focus', 'Start focus automatically', 'After a break ends'));
        return page;
    }

    _autoThemePage(settings, window) {
        const page = new Adw.PreferencesPage({title: 'Auto-theme', name: 'auto-theme', icon_name: 'preferences-color-symbolic'});

        const main = new Adw.PreferencesGroup({
            title: 'Wallpaper-based theming',
            description: 'Extract colours from the desktop wallpaper and match them to a curated theme that works across GNOME Shell, GTK, Flatpak and kitty.',
        });
        const enabled = switchRow(settings, 'auto-theme-enabled', 'Enable auto-theme',
            'Match the island and desktop to the wallpaper');
        main.add(enabled);

        const shell = switchRow(settings, 'auto-theme-shell', 'GNOME Shell & island',
            'Change the island fill colour and GNOME accent');
        settings.bind('auto-theme-enabled', shell, 'sensitive', Gio.SettingsBindFlags.GET);
        main.add(shell);

        const gtk = switchRow(settings, 'auto-theme-gtk', 'GTK3 / GTK4 apps',
            'Write a CSS override into ~/.config/gtk-3.0 and ~/.config/gtk-4.0');
        settings.bind('auto-theme-enabled', gtk, 'sensitive', Gio.SettingsBindFlags.GET);
        main.add(gtk);

        const flatpak = switchRow(settings, 'auto-theme-flatpak', 'Flatpak apps',
            'Allow sandboxed apps to read the GTK CSS via a global override');
        settings.bind('auto-theme-enabled', flatpak, 'sensitive', Gio.SettingsBindFlags.GET);
        main.add(flatpak);

        const kitty = switchRow(settings, 'auto-theme-kitty', 'kitty terminal',
            'Select the closest matching kitty theme in kitty.conf');
        settings.bind('auto-theme-enabled', kitty, 'sensitive', Gio.SettingsBindFlags.GET);
        main.add(kitty);

        const refresh = switchRow(settings, 'auto-theme-refresh', 'Refresh on wallpaper change',
            'Re-match automatically when the desktop wallpaper changes');
        settings.bind('auto-theme-enabled', refresh, 'sensitive', Gio.SettingsBindFlags.GET);
        main.add(refresh);
        page.add(main);

        const info = new Adw.PreferencesGroup({
            title: 'Current theme',
        });
        const currentRow = new Adw.ActionRow({title: 'Matched bundle'});
        const currentLabel = new Gtk.Label({
            label: settings.get_string('auto-theme-current-bundle') || 'None',
            css_classes: ['dim-label'],
        });
        currentLabel.set_valign(Gtk.Align.CENTER);
        currentRow.add_suffix(currentLabel);
        const syncCurrent = () => {
            currentLabel.label = settings.get_string('auto-theme-current-bundle') || 'None';
        };
        const currentChanged = settings.connect('changed::auto-theme-current-bundle', syncCurrent);
        window.connect('close-request', () => {
            settings.disconnect(currentChanged);
            return false;
        });
        info.add(currentRow);
        page.add(info);

        const curated = new Adw.PreferencesGroup({
            title: 'Curated themes',
            description: 'The themes the wallpaper can be matched to. Install the matching kitty themes for the terminal to follow.',
        });
        const names = getBundleNames();
        for (const name of names) {
            const row = new Adw.ActionRow({title: name, activatable: false});
            curated.add(row);
        }
        page.add(curated);

        return page;
    }
}





/** A switch bound to a boolean key. */
function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/** The lyrics providers in the order they are asked: a switch each, and arrows to move them up and down. */
function lyricsProvidersGroup(settings, window) {
    const group = new Adw.PreferencesGroup({
        title: 'Lyrics providers',
        description: 'Asked from the top down: if one has no lyrics for a song, or cannot be reached, the lyrics page goes on to the next.',
    });
    const order = () => {
        const saved = [...new Set(settings.get_strv('lyrics-provider-order'))].filter(id => id in PROVIDERS);
        return [...saved, ...DEFAULT_ORDER.filter(id => !saved.includes(id))];
    };
    const isOff = id => settings.get_strv('lyrics-providers-off').includes(id);
    const setOff = (id, off) => {
        const list = settings.get_strv('lyrics-providers-off').filter(each => each !== id);
        if (off)
            list.push(id);
        settings.set_strv('lyrics-providers-off', list);
    };
    const hasKey = () => settings.get_string('musixmatch-api-key').trim() !== '';
    const subtitleOf = id => {
        const {description, needsKey} = PROVIDERS[id];
        return needsKey && !hasKey() ? `${description} No key yet, so it is skipped.` : description;
    };

    /** The rows now in the group, and each provider's switch, rows and arrows. */
    let rows = [];
    const parts = new Map();
    const build = (focus = null) => {
        rows.forEach(row => group.remove(row));
        rows = [];
        parts.clear();
        const list = order();
        list.forEach((id, index) => {
            const row = new Adw.ActionRow({title: PROVIDERS[id].name, subtitle: subtitleOf(id), subtitle_lines: 0});
            const up = new Gtk.Button({icon_name: 'go-up-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'],
                tooltip_text: 'Ask sooner', sensitive: index > 0});
            const down = new Gtk.Button({icon_name: 'go-down-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'],
                tooltip_text: 'Ask later', sensitive: index < list.length - 1});
            const toggle = new Gtk.Switch({valign: Gtk.Align.CENTER, active: !isOff(id)});
            toggle.connect('notify::active', () => {
                if (toggle.active === isOff(id))
                    setOff(id, !toggle.active);
            });
            const move = step => {
                const next = order();
                const from = next.indexOf(id);
                const to = from + step;
                if (to < 0 || to >= next.length)
                    return;
                [next[from], next[to]] = [next[to], next[from]];
                settings.set_strv('lyrics-provider-order', next);
                build({id, step});
            };
            up.connect('clicked', () => move(-1));
            down.connect('clicked', () => move(1));
            row.add_prefix(new Gtk.Label({label: `${index + 1}`, css_classes: ['dim-label', 'numeric'], width_chars: 2}));
            row.add_suffix(up);
            row.add_suffix(down);
            row.add_suffix(toggle);
            row.activatable_widget = toggle;
            group.add(row);
            rows.push(row);
            parts.set(id, {row, toggle, up, down});
        });
        // The arrow that was pressed stays under the keyboard, on the row that moved.
        if (focus) {
            const {up, down} = parts.get(focus.id);
            (focus.step < 0 ? up : down).sensitive ? (focus.step < 0 ? up : down).grab_focus() : (focus.step < 0 ? down : up).grab_focus();
        }
    };
    build();

    const changed = [
        // Switches follow the setting (a change made elsewhere); the rows follow the order.
        settings.connect('changed::lyrics-providers-off', () => {
            for (const [id, {toggle}] of parts)
                toggle.active = !isOff(id);
        }),
        settings.connect('changed::lyrics-provider-order', () => {
            const shown = rows.map(row => row.title).join();
            if (order().map(id => PROVIDERS[id].name).join() !== shown)
                build();
        }),
        settings.connect('changed::musixmatch-api-key', () => {
            for (const [id, {row}] of parts)
                row.subtitle = subtitleOf(id);
        }),
    ];
    window.connect('close-request', () => {
        changed.forEach(id => settings.disconnect(id));
        return false;
    });
    return group;
}

/** Cava's bars under the lyrics: on or off, and how they look. Cava itself must be installed. */
function cavaGroup(settings) {
    const installed = GLib.find_program_in_path('cava') !== null;
    const group = new Adw.PreferencesGroup({
        title: 'Cava',
        description: installed ? 'Bars that follow the music, as the background of the player and the lyrics.'
            : 'Bars that follow the music, as the background of the player and the lyrics. Cava is not installed: install it (the “cava” package) first.',
    });
    const enabled = switchRow(settings, 'cava-enabled', 'Bars behind the player and lyrics',
        'Cava runs only while the player or the lyrics are open. The island’s own little bars give way to them meanwhile.');
    group.add(enabled);
    const rows = [
        spinRow(settings, 'cava-height-pct', 'Height', 'How high the bars may rise, in percent of the page', 10, 100),
        spinRow(settings, 'cava-opacity', 'Opacity', 'How strongly the bars show behind the player and the lyrics, in percent', 10, 100),
        spinRow(settings, 'cava-zoom', 'Zoom', 'How large the bars are, in percent: above 100 they grow past the island’s sides', 50, 300),
        spinRow(settings, 'cava-offset-x', 'Horizontal position', 'Moves the bars right (or left, below 0), in pixels', -300, 300),
        spinRow(settings, 'cava-offset-y', 'Vertical position', 'Moves the bars up (or down, below 0), in pixels', -300, 300),
        spinRow(settings, 'cava-sensitivity', 'Sensitivity', 'How strongly the bars answer the music, in percent: above 100 they rise higher', 20, 400),
        spinRow(settings, 'cava-bars', 'Bars', 'How many bars', 8, 64),
        spinRow(settings, 'cava-smoothness', 'Smoothness', 'Higher is calmer, lower is quicker and jumpier', 0, 100),
        choiceRow(settings, 'cava-source', 'Listens to', '“Automatic” tries PipeWire, then PulseAudio', [
            ['auto', 'Automatic'],
            ['pipewire', 'PipeWire'],
            ['pulse', 'PulseAudio'],
        ]),
    ];
    for (const row of rows) {
        // Their settings matter only while the bars are on.
        settings.bind('cava-enabled', row, 'sensitive', Gio.SettingsBindFlags.GET);
        group.add(row);
    }
    enabled.sensitive = installed;
    return group;
}

/** The API keys of the providers that need one, each in a drop-down row. */
function apiKeysGroup(settings, window) {
    const group = new Adw.PreferencesGroup({
        title: 'API keys',
        description: 'For the lyrics providers that need one. A key is kept in Isle’s settings on this computer, as plain text.',
    });
    const musixmatch = new Adw.ExpanderRow({title: 'Musixmatch'});
    const describe = () => {
        musixmatch.subtitle = settings.get_string('musixmatch-api-key').trim() ? 'Key saved' : 'No key yet';
    };
    describe();
    const entry = new Adw.PasswordEntryRow({title: 'API key', show_apply_button: true});
    entry.text = settings.get_string('musixmatch-api-key');
    entry.connect('apply', () => settings.set_string('musixmatch-api-key', entry.text.trim()));
    musixmatch.add_row(entry);
    const help = new Adw.ActionRow({
        title: 'Get a key',
        subtitle: 'At developer.musixmatch.com. The free plan gives part of a song’s words; synced lyrics need a paid plan.',
        subtitle_lines: 0,
    });
    help.add_suffix(new Gtk.LinkButton({uri: 'https://developer.musixmatch.com/', label: 'Open', valign: Gtk.Align.CENTER}));
    musixmatch.add_row(help);
    group.add(musixmatch);
    const none = new Adw.ActionRow({title: 'LRCLIB and NetEase', subtitle: 'Need no key'});
    none.add_css_class('dim-label');
    group.add(none);

    const id = settings.connect('changed::musixmatch-api-key', describe);
    window.connect('close-request', () => {
        settings.disconnect(id);
        return false;
    });
    return group;
}

/** How dark the Glass look is, Clear to Dark; shown only while the island is glass. */

/** The top bar beside the island, from glass to black, on a slider. */
function topBarRow(settings, window) {
    const row = new Adw.ActionRow({title: 'Top bar'});
    const scale = new Gtk.Scale({
        adjustment: new Gtk.Adjustment({lower: 0, upper: 100, step_increment: 5, page_increment: 25}),
        draw_value: false, width_request: 150, valign: Gtk.Align.CENTER,
    });
    scale.add_mark(50, Gtk.PositionType.BOTTOM, null);
    const ends = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER});
    ends.append(new Gtk.Label({label: 'Glass', css_classes: ['dim-label', 'caption']}));
    ends.append(scale);
    ends.append(new Gtk.Label({label: 'Black', css_classes: ['dim-label', 'caption']}));
    row.add_suffix(ends);
    row.activatable_widget = scale;
    // Unset, the older Glass or Black choice says (as TopBar.opacity in shell.js).
    const current = () => settings.get_user_value('top-bar-opacity') ? settings.get_int('top-bar-opacity')
        : settings.get_string('top-bar-style') === 'black' ? 100 : 0;
    const describe = value => {
        row.subtitle = value <= 0 ? 'See-through glass' : value >= 100 ? 'The island blends into the bar'
            : `${value}% black`;
    };
    let syncing = false;
    scale.connect('value-changed', () => {
        if (syncing)
            return;
        // Stored in steps of 5; the knob stays under the pointer meanwhile.
        const value = Math.round(scale.get_value() / 5) * 5;
        describe(value);
        settings.set_int('top-bar-opacity', value);
        // Kept in step, for anything that still reads the older choice.
        const style = value >= 100 ? 'black' : 'glass';
        if (settings.get_string('top-bar-style') !== style)
            settings.set_string('top-bar-style', style);
    });
    const sync = () => {
        // Moved only for a change from elsewhere: the step the knob is in already is this one.
        if (Math.round(scale.get_value() / 5) * 5 !== current()) {
            syncing = true;
            scale.set_value(current());
            syncing = false;
        }
        describe(current());
        // Isle's colour only: left to others, the slider has nothing to set.
        row.sensitive = settings.get_boolean('top-bar-color');
    };
    const changed = ['top-bar-opacity', 'top-bar-style', 'top-bar-color'].map(key => settings.connect(`changed::${key}`, sync));
    window.connect('close-request', () => {
        changed.forEach(id => settings.disconnect(id));
        return false;
    });
    sync();
    return row;
}

/** What Isle's clock in the top bar shows, each choice with an example of now in the chosen time format; shown only
 * while that clock is on. */
function barClockShowsRow(settings) {
    const examples = () => {
        const now = GLib.DateTime.new_now_local();
        const time = now.format(useTwelveHour(settings) ? '%l:%M %p' : '%H:%M').trim();
        return [['time', 'Time', time], ['day', 'Day', `${now.format('%a')} ${time}`],
            ['date', 'Date', `${now.format('%a %-d %b')} ${time}`]];
    };
    const row = choiceRow(settings, 'top-bar-clock-shows', 'Top bar clock shows',
        'It hides by itself while the bar is too full',
        examples().map(([value, name, example]) => [value, `${name} · ${example}`]));
    // The examples follow the time format; the choice stays.
    const relabel = () => {
        const selected = row.selected;
        row.model = Gtk.StringList.new(examples().map(([, name, example]) => `${name} · ${example}`));
        row.selected = selected;
    };
    const byClock = () => (row.visible = settings.get_string('top-bar-clock') !== 'off');
    const changed = [settings.connect('changed::top-bar-clock', byClock), settings.connect('changed::clock-format', relabel)];
    row.connect('destroy', () => changed.forEach(id => settings.disconnect(id)));
    byClock();
    return row;
}

/** Whether the bar turns black beside a window that reaches it; only for a bar that is not black already. */
function blackBesideWindowsRow(settings, window) {
    const row = switchRow(settings, 'top-bar-black-with-windows', 'Black top bar beside windows',
        'While a window reaches the top bar, maximized or tiled, the bar turns black');
    // Unset, the older Glass or Black choice says (as TopBar.opacity in shell.js).
    const sync = () => {
        const opacity = settings.get_user_value('top-bar-opacity') ? settings.get_int('top-bar-opacity')
            : settings.get_string('top-bar-style') === 'black' ? 100 : 0;
        row.sensitive = opacity < 100 && settings.get_boolean('top-bar-color');
    };
    const changed = ['top-bar-opacity', 'top-bar-style', 'top-bar-color'].map(key => settings.connect(`changed::${key}`, sync));
    window.connect('close-request', () => {
        changed.forEach(id => settings.disconnect(id));
        return false;
    });
    sync();
    return row;
}

/** The open island's pages that can be left out, in tab order, with what goes with each. */
const PAGES = [
    ['music', 'Music', 'audio-x-generic-symbolic', 'The player and lyrics, and the song in the closed island'],
    ['notifications', 'Notifications', 'preferences-system-notifications-symbolic', 'The list to look back at, and its unread dot; alerts show either way'],
    ['focus', 'Timer', 'alarm-symbolic', 'Pomodoro focus sessions and breaks'],
    ['reminders', 'Reminders', 'object-select-symbolic', 'Your to-do list'],
    ['shelf', 'Shelf', 'edit-paste-symbolic', 'Clipboard history (Super+V), the files tray and sharing with a phone'],
    ['calendar', 'Calendar', 'x-office-calendar-symbolic', 'The month, its events and world clocks'],
    ['system', 'System', 'utilities-system-monitor-symbolic', 'CPU, memory, network, storage and temperature sensors'],
];

/** The pages a shortcut of their own may open from anywhere, as the controller's SHORTCUT_PAGES, with their names. */
const SHORTCUT_PAGES = [...PAGES.map(([name, title, iconName]) => [name, title, iconName]),
    ['apps', 'Apps', 'view-app-grid-symbolic'], ['devices', 'Devices', 'bluetooth-active-symbolic'],
    ['system', 'System', 'utilities-system-monitor-symbolic'],
];
function shortcutsGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: 'Shortcuts',
        description: 'Open a page from anywhere; the same shortcut closes it. Super+V opens the Shelf’s clipboard or the Calendar: press it on either. In the open island, Ctrl+Tab and Ctrl+1–9 change pages.',
    });
    for (const [name, title, iconName] of SHORTCUT_PAGES) {
        const row = SUPER_V_PAGES[name] ? superVPageRow(settings, name, title) : shortcutRow(settings, `shortcut-${name}`, title, null);
        row.add_prefix(new Gtk.Image({icon_name: iconName}));
        group.add(row);
    }
    return group;
}

/** The pages GNOME's calendar shortcut (Super+V, Super+M) may open, as the `super-v` setting names them. */
const SUPER_V_PAGES = {shelf: 'isle', calendar: 'calendar'};

/** Which of SUPER_V_PAGES Super+V opens now ('gnome', from before, is the calendar), or null when it opens none. */
function superVPage(settings) {
    const setting = settings.get_string('super-v');
    return setting === 'none' ? null : setting === 'isle' ? 'shelf' : 'calendar';
}

/** Whether `accelerator` is GNOME's calendar shortcut, which Isle takes (Super+V, Super+M). */
function isSuperV(accelerator) {
    const gnome = new Gio.Settings({schema_id: 'org.gnome.shell.keybindings'}).get_strv('toggle-message-tray');
    const [keyval, modifiers] = parsedAccelerator(accelerator);
    return gnome.some(other => {
        const [otherKey, otherModifiers] = parsedAccelerator(other);
        return otherKey === keyval && otherModifiers === modifiers;
    });
}

/** Gives `page` (one of SUPER_V_PAGES) `accelerator` ('' for none), one shortcut a page: Super+V taken from the other
 * page, or, given another, Super+V taken off it. Why it wasn't, or null. */
function setPageShortcut(settings, page, accelerator) {
    const key = `shortcut-${page}`;
    if (accelerator && isSuperV(accelerator)) {
        settings.set_strv(key, []);
        settings.set_string('super-v', SUPER_V_PAGES[page]);
        return null;
    }
    const taken = accelerator && shortcutTakenBy(accelerator, settings, key);
    if (taken)
        return `${Gtk.accelerator_get_label(...parsedAccelerator(accelerator))} is already ${taken}`;
    settings.set_strv(key, accelerator ? [accelerator] : []);
    // Another shortcut takes Super+V's place on this page: Super+V opens nothing until given again. Taking its own
    // off leaves Super+V where it is.
    if (accelerator && superVPage(settings) === page)
        settings.set_string('super-v', 'none');
    return null;
}

/** The Shelf's or the Calendar's shortcut, one shortcut a page: Super+V shows on the page it opens. Given another,
 * that page lets Super+V go to the other one (Clipboard, or Calendar); given Super+V, it takes it from the other. The
 * Clipboard page's Super+V choice is the same setting. */
function superVPageRow(settings, name, title) {
    const key = `shortcut-${name}`;
    const row = new Adw.ActionRow({title, activatable: true});
    const shown = new Gtk.ShortcutLabel({disabled_text: 'Off', valign: Gtk.Align.CENTER});
    // Takes off what it shows: its own shortcut, or else Super+V (which then opens nothing, until given again).
    const remove = removeButton(() => {
        if (settings.get_strv(key).length)
            setPageShortcut(settings, name, '');
        else
            settings.set_string('super-v', 'none');
    });
    const sync = () => {
        const own = settings.get_strv(key)[0] ?? '';
        const superV = superVPage(settings) === name;
        shown.accelerator = own || (superV ? '<Super>v' : '');
        remove.visible = Boolean(own) || superV;
        // Both set (each page given its own): Super+V still opens one of them, said here.
        row.subtitle = own && superV ? 'Super+V opens it too' : '';
    };
    const changed = ['super-v', key].map(changedKey => settings.connect(`changed::${changedKey}`, sync));
    row.connect('destroy', () => changed.forEach(id => settings.disconnect(id)));
    sync();
    row.add_suffix(shown);
    row.add_suffix(remove);
    row.connect('activated', () => recordShortcut(row.get_root(), accelerator => {
        const problem = setPageShortcut(settings, name, accelerator);
        if (problem)
            row.get_root()?.add_toast?.(new Adw.Toast({title: problem}));
    }, {superV: true}));
    return row;
}

/** A switch per page, in tab order, with arrows to move each tab; the last one on can't be turned off, so the island
 * always has a page. */
function pagesGroup(settings, window) {
    const group = new Adw.PreferencesGroup({title: 'Pages',
        description: 'The open island’s tabs, top here is left there. Use the arrows to reorder them and the switches to hide the ones you don’t use.'});
    const rows = PAGES.map(([name, title, iconName, subtitle]) => {
        const row = new Adw.SwitchRow({title, subtitle});
        row.add_prefix(new Gtk.Image({icon_name: iconName}));
        row.connect('notify::active', () => {
            const hidden = settings.get_strv('hidden-pages').filter(other => other !== name);
            if (!row.active)
                hidden.push(name);
            if (hidden.join() !== settings.get_strv('hidden-pages').join())
                settings.set_strv('hidden-pages', hidden);
        });
        return [name, row];
    });
    // The Apps, Devices and Usage pages' own switches, here too, so every tab is in one place.
    const apps = switchRow(settings, 'app-usage', 'Apps', 'Time spent in each app, kept on this computer for 30 days');
    apps.add_prefix(new Gtk.Image({icon_name: 'view-app-grid-symbolic'}));
    const devices = switchRow(settings, 'devices-page', 'Devices',
        'Connected Bluetooth devices and their battery; its tab shows while one is connected');
    devices.add_prefix(new Gtk.Image({icon_name: 'bluetooth-active-symbolic'}));
    // Only its switch goes grey: its tab can still be moved meanwhile.

    const byName = new Map([...rows, ['apps', apps], ['devices', devices]]);
    const order = () => pageOrder(settings.get_strv('page-order'));
    const arrows = new Map();
    for (const [name, row] of byName) {
        const move = (step, iconName, tooltip) => {
            const button = new Gtk.Button({icon_name: iconName, css_classes: ['flat', 'circular'], tooltip_text: tooltip,
                valign: Gtk.Align.CENTER});
            button.connect('clicked', () => settings.set_strv('page-order', storedOrder(movePage(order(), name, step))));
            row.add_suffix(button);
            return button;
        };
        const earlier = move(-1, 'go-up-symbolic', 'Move up: the tab goes left');
        const later = move(1, 'go-down-symbolic', 'Move down: the tab goes right');
        // The arrows before its switch, which stays last, as in every other row.
        const toggle = row.activatable_widget;
        const box = toggle?.get_parent();
        if (box && box.get_last_child() !== toggle)
            toggle.insert_after(box, box.get_last_child());
        arrows.set(name, {earlier, later});
    }
    const reset = new Gtk.Button({label: 'Reset Order', css_classes: ['flat'], valign: Gtk.Align.CENTER,
        tooltip_text: 'Put the tabs back in Isle’s own order'});
    reset.connect('clicked', () => settings.reset('page-order'));
    group.header_suffix = reset;
    const laidOut = [];
    const layOut = () => {
        const wanted = [...order().map(name => byName.get(name))];
        if (wanted.every((row, at) => laidOut[at] === row))
            return;
        laidOut.forEach(row => group.remove(row));
        wanted.forEach(row => group.add(row));
        laidOut.splice(0, laidOut.length, ...wanted);
    };
    const syncOrder = () => {
        const current = order();
        current.forEach((name, at) => {
            const {earlier, later} = arrows.get(name);
            earlier.sensitive = at > 0;
            later.sensitive = at < current.length - 1;
        });
        reset.visible = settings.get_strv('page-order').length > 0;
        layOut();
    };
    syncOrder();
    const orderChanged = settings.connect('changed::page-order', syncOrder);
    const sync = () => {
        const hidden = settings.get_strv('hidden-pages');
        const shown = rows.filter(([name]) => !hidden.includes(name));
        for (const [name, row] of rows) {
            row.active = !hidden.includes(name);
            const last = shown.length === 1 && row.active;
            lockSwitch(row, last);
            row.subtitle = last ? 'The island keeps at least one page' : PAGES.find(([page]) => page === name)[3];
        }
    };
    const changed = settings.connect('changed::hidden-pages', sync);
    window.connect('close-request', () => {
        settings.disconnect(changed);
        settings.disconnect(orderChanged);
        return false;
    });
    sync();
    return group;
}

/** Greys out `row`'s switch alone (`locked`), so it can't be turned, its arrows still working. */
function lockSwitch(row, locked) {
    row.activatable_widget.sensitive = !locked;
    row.activatable = !locked;
}

/** What the Apps page keeps, and a way to forget it; its switch is with the other pages. */
function appUsageGroup(settings, window) {
    const group = new Adw.PreferencesGroup({
        title: 'App Usage',
        description: 'With the Apps page on, the app in front is timed. Five minutes without input pause it, unless a video keeps the screen awake.',
    });
    const clear = new Adw.ActionRow({title: 'Clear app usage', subtitle: 'Forget every day recorded so far'});
    const button = new Gtk.Button({label: 'Clear…', valign: Gtk.Align.CENTER});
    button.connect('clicked', () => confirm(window, {
        heading: 'Clear app usage?',
        body: 'Every app’s time recorded so far is removed. This cannot be undone.',
        action: 'Clear',
    }, () => settings.set_boolean('app-usage-clear', true)));
    clear.add_suffix(button);
    group.add(clear);
    return group;
}

/** GNOME's World Clocks: the cities, each with its time and a remove button, and a search to add one. */
function worldClocksGroup(settings, window) {
    const shell = WorldClocks.shellSettings();
    const group = new Adw.PreferencesGroup({
        title: 'World Clocks',
        description: 'The time in other cities on the Calendar page. The same list as GNOME’s calendar menu and Clocks app.',
    });
    const show = switchRow(settings, 'world-clocks', 'Show world clocks', 'Under the day’s events; click them for more');
    group.add(show);
    if (!shell) {
        show.sensitive = false;
        show.subtitle = 'GNOME’s world clocks are not available here';
        return group;
    }
    // ButtonRow since libadwaita 1.6 (GNOME 47).
    const add = Adw.ButtonRow ? new Adw.ButtonRow({title: 'Add a City…', start_icon_name: 'list-add-symbolic'})
        : new Adw.ActionRow({title: 'Add a City…', activatable: true});
    if (!Adw.ButtonRow)
        add.add_prefix(new Gtk.Image({icon_name: 'list-add-symbolic'}));
    add.connect('activated', () => chooseCity(group.get_root(), location => {
        const cities = WorldClocks.readCities(shell).map(city => city.location);
        if (!cities.some(other => other.equal(location)))
            WorldClocks.writeCities(shell, [...cities, location]);
    }));
    let rows = [];
    /** Each row's time and day, written again each minute while Settings is open. */
    let ticks = [];
    const refresh = () => {
        rows.forEach(row => group.remove(row));
        const cities = WorldClocks.readCities(shell);
        ticks = [];
        rows = cities.map(({location, name, timezone}) => {
            const country = location.get_country_name?.() ?? '';
            const row = new Adw.ActionRow({title: name});
            const time = new Gtk.Label({css_classes: ['numeric', 'dim-label'], valign: Gtk.Align.CENTER});
            row.add_suffix(time);
            const tick = () => {
                const now = GLib.DateTime.new_now_local();
                const when = [WorldClocks.dayText(timezone, now), WorldClocks.offsetText(timezone, now) || 'Same time as here']
                    .filter(Boolean).join(' · ');
                row.subtitle = [country, when].filter(Boolean).join(' · ');
                time.label = now.to_timezone(timezone).format(useTwelveHour(settings) ? '%l:%M %p' : '%H:%M').trim();
            };
            tick();
            ticks.push(tick);
            const remove = new Gtk.Button({icon_name: 'list-remove-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'],
                tooltip_text: 'Remove this city'});
            remove.connect('clicked', () => WorldClocks.writeCities(shell,
                WorldClocks.readCities(shell).map(city => city.location).filter(other => !other.equal(location))));
            row.add_suffix(remove);
            settings.bind('world-clocks', row, 'sensitive', Gio.SettingsBindFlags.GET);
            return row;
        });
        group.remove(add);
        rows.forEach(row => group.add(row));
        group.add(add);
    };
    group.add(add);
    settings.bind('world-clocks', add, 'sensitive', Gio.SettingsBindFlags.GET);
    const changed = shell.connect('changed::locations', refresh);
    // Isle's 12/24-hour setting changed: the times again now, not at the next minute.
    const clockChanged = settings.connect('changed::clock-format', () => ticks.forEach(tick => tick()));
    // At each minute's turn by the clock, so a suspend or a changed clock is caught up at the next.
    let timer = 0;
    const next = () => {
        timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, (60 - GLib.DateTime.new_now_local().get_second()) * 1000 + 50, () => {
            ticks.forEach(tick => tick());
            next();
            return GLib.SOURCE_REMOVE;
        });
    };
    next();
    window.connect('close-request', () => {
        shell.disconnect(changed);
        settings.disconnect(clockChanged);
        GLib.Source.remove(timer);
        return false;
    });
    refresh();
    return group;
}

/** Whether times show with a 12-hour clock: as Isle's Clock setting says, else as GNOME's clock. */
function useTwelveHour(settings) {
    const format = settings.get_string('clock-format');
    if (format !== 'system')
        return format === '12h';
    return new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).get_string('clock-format') === '12h';
}

/** A dialog to search GNOME's list of cities; `onPick` gets the one chosen. */
function chooseCity(window, onPick) {
    const cities = WorldClocks.allCities();
    const dialog = new Adw.Dialog({title: 'Add a City', content_width: 420, content_height: 480});
    const view = new Adw.ToolbarView();
    view.add_top_bar(new Adw.HeaderBar());
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12, margin_start: 12, margin_end: 12, margin_bottom: 12});
    const search = new Gtk.SearchEntry({placeholder_text: 'Search for a city'});
    box.append(search);
    const list = new Gtk.ListBox({css_classes: ['boxed-list'], selection_mode: Gtk.SelectionMode.NONE, valign: Gtk.Align.START});
    const scroller = new Gtk.ScrolledWindow({child: list, vexpand: true, hscrollbar_policy: Gtk.PolicyType.NEVER});
    box.append(scroller);
    const empty = new Adw.StatusPage({icon_name: 'find-location-symbolic', title: 'Search for a City',
        description: 'Type a city’s name, like Tokyo or New York', vexpand: true});
    box.append(empty);
    view.set_content(box);
    dialog.set_child(view);
    const fill = () => {
        list.remove_all();
        const query = search.text.trim().toLowerCase();
        // Names starting with what was typed first: "par" finds Paris before Parramatta's suburbs.
        const starts = city => city.name.toLowerCase().startsWith(query);
        const found = query ? cities.filter(city => city.search.includes(query))
            .sort((a, b) => starts(b) - starts(a)).slice(0, 40) : [];
        for (const city of found) {
            const row = new Adw.ActionRow({title: city.name, subtitle: city.place, activatable: true});
            row.connect('activated', () => {
                onPick(city.location);
                dialog.close();
            });
            list.append(row);
        }
        scroller.visible = found.length > 0;
        empty.visible = found.length === 0;
        empty.title = query ? 'No City Found' : 'Search for a City';
        empty.description = query ? 'Try another spelling, or a bigger city nearby' : 'Type a city’s name, like Tokyo or New York';
    };
    search.connect('search-changed', fill);
    fill();
    dialog.present(window);
}





/** `command` on the PATH or where installers and Node version managers put it, as isled looks; else null. */
// The same places isled looks in (brain.rs `install_dirs`), for an AI installed with npm, nvm, Homebrew…

/** nvm's Nodes' bin folders, newest first. */

// AI plan usage data removed in this fork.

/** Items of a drop-down's list that wrap a long name rather than cutting it. */
function wrappingItems() {
    const factory = new Gtk.SignalListItemFactory();
    factory.connect('setup', (_factory, item) => item.set_child(new Gtk.Label({
        xalign: 0, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, max_width_chars: 36,
    })));
    factory.connect('bind', (_factory, item) => {
        item.get_child().label = item.get_item().get_string();
    });
    return factory;
}

/** A drop-down's chosen item beside its title, whole: never cut (the row's title wraps instead), as the
 * row doesn't grow taller for a value on more lines. */
function valueItem() {
    const factory = new Gtk.SignalListItemFactory();
    factory.connect('setup', (_factory, item) => item.set_child(new Gtk.Label({xalign: 1})));
    factory.connect('bind', (_factory, item) => {
        item.get_child().label = item.get_item().get_string();
    });
    return factory;
}

/** A drop-down for a string key with `choices`: [[value, label], …]. */
function choiceRow(settings, key, title, subtitle, choices) {
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(choices.map(([, label]) => label)),
        factory: valueItem(),
        list_factory: wrappingItems(),
    });
    const sync = () => {
        const index = choices.findIndex(([value]) => value === settings.get_string(key));
        row.selected = Math.max(0, index);
    };
    sync();
    const changed = settings.connect(`changed::${key}`, sync);
    row.connect('notify::selected', () => {
        const value = choices[row.selected]?.[0];
        if (value !== undefined && value !== settings.get_string(key))
            settings.set_string(key, value);
    });
    row.connect('destroy', () => settings.disconnect(changed));
    return row;
}

/** Whole numbers from `min` to `max`, bound to an int key. */
function spinRow(settings, key, title, subtitle, min, max) {
    const row = Adw.SpinRow.new_with_range(min, max, 1);
    row.title = title;
    row.subtitle = subtitle;
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/** A small × beside a shortcut that takes it off; `onClick` does. */
function removeButton(onClick) {
    const button = new Gtk.Button({icon_name: 'window-close-symbolic', valign: Gtk.Align.CENTER,
        css_classes: ['flat', 'circular'], tooltip_text: 'Remove the shortcut'});
    button.update_property([Gtk.AccessibleProperty.LABEL], ['Remove the shortcut']);
    button.connect('clicked', onClick);
    return button;
}

/** A row showing `key`'s shortcut; clicking it records a new one. */
function shortcutRow(settings, key, title, subtitle) {
    const row = new Adw.ActionRow({title, subtitle, activatable: true});
    const shown = new Gtk.ShortcutLabel({disabled_text: 'Off', valign: Gtk.Align.CENTER});
    const remove = removeButton(() => settings.set_strv(key, []));
    const sync = () => {
        shown.accelerator = settings.get_strv(key)[0] ?? '';
        remove.visible = Boolean(shown.accelerator);
    };
    const changed = settings.connect(`changed::${key}`, sync);
    row.connect('destroy', () => settings.disconnect(changed));
    sync();
    row.add_suffix(shown);
    row.add_suffix(remove);
    row.connect('activated', () => recordShortcut(row.get_root(), accelerator => {
        // One GNOME or Isle already uses would take it from there: kept as it was, and said why.
        const taken = accelerator && shortcutTakenBy(accelerator, settings, key);
        if (taken) {
            row.get_root()?.add_toast?.(new Adw.Toast({title: `${Gtk.accelerator_get_label(...parsedAccelerator(accelerator))} is already ${taken}`}));
            return;
        }
        settings.set_strv(key, accelerator ? [accelerator] : []);
    }));
    return row;
}

/** `accelerator` as [keyval, modifiers], the key lower case, for comparing. */
function parsedAccelerator(accelerator) {
    const [, keyval, modifiers] = Gtk.accelerator_parse(accelerator);
    return [Gdk.keyval_to_lower(keyval), modifiers];
}

/** GNOME's shortcut settings, and what they are for (said in the warning). */
const GNOME_SHORTCUTS = [
    ['org.gnome.desktop.wm.keybindings', 'a GNOME window shortcut'],
    ['org.gnome.shell.keybindings', 'a GNOME Shell shortcut'],
    ['org.gnome.mutter.keybindings', 'a GNOME window shortcut'],
    ['org.gnome.mutter.wayland.keybindings', 'a GNOME shortcut'],
    ['org.gnome.settings-daemon.plugins.media-keys', 'a GNOME system shortcut'],
];

/** What already uses `accelerator` ("a GNOME Shell shortcut", "Isle's Calendar shortcut"), or null; `ownKey` is the
 * key being set, which may keep its own. */
function shortcutTakenBy(accelerator, settings, ownKey) {
    const [keyval, modifiers] = parsedAccelerator(accelerator);
    const same = list => list.some(other => {
        const [otherKey, otherModifiers] = parsedAccelerator(other);
        return otherKey === keyval && otherModifiers === modifiers;
    });
    const source = Gio.SettingsSchemaSource.get_default();
    for (const [id, what] of GNOME_SHORTCUTS) {
        const schema = source.lookup(id, true);
        if (!schema)
            continue;
        const gnome = new Gio.Settings({settings_schema: schema});
        const used = schema.list_keys().some(name =>
            schema.get_key(name).get_value_type().dup_string() === 'as' && same(gnome.get_strv(name)));
        if (used)
            return `used by ${what}`;
    }
    // The user's own shortcuts (Settings → Keyboard → Custom Shortcuts), each at a path of its own.
    const media = source.lookup('org.gnome.settings-daemon.plugins.media-keys', true);
    const custom = source.lookup('org.gnome.settings-daemon.plugins.media-keys.custom-keybinding', true);
    if (media && custom) {
        for (const path of new Gio.Settings({settings_schema: media}).get_strv('custom-keybindings')) {
            const own = new Gio.Settings({settings_schema: custom, path});
            const binding = own.get_string('binding');
            if (binding && same([binding]))
                return `your shortcut “${own.get_string('name')}”`;
        }
    }
    for (const [other, title] of SHORTCUT_PAGES.map(([name, title]) => [`shortcut-${name}`, title])) {
        if (other !== ownKey && same(settings.get_strv(other)))
            return `Isle’s ${title} shortcut`;
    }
    return null;
}

/** Waits for a key combination with a modifier, then hands it to `done`; Esc cancels, Backspace clears it. With
 * `superV`, Super+V too: GNOME takes it before any window sees it, so Isle hands it over (shortcutRecorder.js). */
function recordShortcut(window, done, {superV = false} = {}) {
    // A small sheet, as tall as what it says (no scrolling): the keyboard on a tile, what to do, and the two keys
    // that do something else.
    const dialog = new Adw.Window({transient_for: window, modal: true, resizable: false, title: 'Shortcut', default_width: 340});
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin_start: 28, margin_end: 28,
        margin_top: 4, margin_bottom: 24, halign: Gtk.Align.CENTER});
    const tile = new Gtk.Image({icon_name: 'input-keyboard-symbolic', pixel_size: 32,
        css_classes: ['card'], width_request: 64, height_request: 64, halign: Gtk.Align.CENTER, margin_bottom: 10});
    box.append(tile);
    box.append(new Gtk.Label({label: 'Press the new shortcut', css_classes: ['title-3']}));
    box.append(new Gtk.Label({label: 'With Super, Ctrl or Alt', css_classes: ['dim-label'], margin_bottom: 14}));
    const keys = new Gtk.Box({spacing: 18, halign: Gtk.Align.CENTER});
    for (const [key, what] of [['Esc', 'Cancel'], ['Backspace', 'Remove']]) {
        const pair = new Gtk.Box({spacing: 8});
        // A key as a shortcut's are drawn, named as on the key: its name on a small raised card.
        const cap = new Gtk.Box({css_classes: ['card'], valign: Gtk.Align.CENTER});
        cap.append(new Gtk.Label({label: key, css_classes: ['caption-heading'], margin_start: 8, margin_end: 8,
            margin_top: 3, margin_bottom: 3}));
        pair.append(cap);
        pair.append(new Gtk.Label({label: what, css_classes: ['dim-label'], valign: Gtk.Align.CENTER}));
        keys.append(pair);
    }
    box.append(keys);
    const view = new Adw.ToolbarView({content: box});
    view.add_top_bar(new Adw.HeaderBar({show_title: false}));
    dialog.set_content(view);
    const presses = new Gtk.EventControllerKey();
    presses.connect('key-pressed', (_presses, keyval, keycode, state) => {
        const modifiers = state & Gtk.accelerator_get_default_mod_mask();
        if (!modifiers && keyval === Gdk.KEY_Escape) {
            dialog.close();
        } else if (!modifiers && keyval === Gdk.KEY_BackSpace) {
            done('');
            dialog.close();
        } else if (modifiers & (Gdk.ModifierType.SUPER_MASK | Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK) &&
            Gtk.accelerator_valid(keyval, modifiers)) {
            // Shift alone would take a capital letter from every app.
            done(Gtk.accelerator_name_with_keycode(null, keyval, keycode, modifiers));
            dialog.close();
        }
        return Gdk.EVENT_STOP;
    });
    dialog.add_controller(presses);
    if (superV) {
        const stop = listenForSuperV(() => {
            done('<Super>v');
            dialog.close();
        });
        dialog.connect('destroy', stop);
    }
    dialog.present();
}

/** Asks, then clears everything but pinned items from the clipboard history. */
function confirmClear(window) {
    confirm(window, {
        heading: 'Clear clipboard history?',
        body: 'Everything you copied is removed. Pinned items stay.',
        action: 'Clear',
    }, () => Gio.DBus.session.call(DAEMON, DAEMON_PATH, CLIPBOARD_INTERFACE, 'Clear', null, null,
        Gio.DBusCallFlags.NONE, -1, null, null));
}

/** Asks `heading` (with `body`) and runs `onYes` if the user picks `action`, a destructive one. */
function confirm(window, {heading, body, action}, onYes) {
    // AlertDialog since libadwaita 1.5 (GNOME 46); MessageDialog is its deprecated forerunner.
    const dialog = Adw.AlertDialog ? new Adw.AlertDialog({heading, body})
        : new Adw.MessageDialog({transient_for: window, heading, body});
    dialog.add_response('cancel', 'Cancel');
    dialog.add_response('yes', action);
    dialog.set_response_appearance('yes', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.connect('response', (_dialog, response) => {
        if (response === 'yes')
            onYes();
    });
    if (Adw.AlertDialog)
        dialog.present(window);
    else
        dialog.present();
}

/** Where updating is explained, and the command that updates a one-line install. */
const UPDATE_HELP = 'https://github.com/stefan-hacks/gnome-island/blob/main/docs/install.md#updating';
const INSTALL_COMMAND = 'curl -fsSL https://raw.githubusercontent.com/stefan-hacks/gnome-island/main/get.sh | bash';
const RELEASES = 'https://github.com/stefan-hacks/gnome-island/releases/latest';
/** Installs version `$1` with that release's own get.sh (no sudo), appending to the log `$2`: first who runs
 * it ("isle-update-pid <pid> <boot id>"), last "isle-update-done <exit status>". */
const UPDATE_SCRIPT = 'exec >>"$2" 2>&1 </dev/null; ' +
    'echo "isle-update-pid $$ $(cat /proc/sys/kernel/random/boot_id 2>/dev/null)"; set -o pipefail; ' +
    'curl -fsSL --retry 2 "https://raw.githubusercontent.com/stefan-hacks/gnome-island/v$1/get.sh" | ISLE_VERSION="$1" bash; ' +
    'echo "isle-update-done $?"';
/** The update's log; its first line names the version ("isle-update 1.5.0"). */
const UPDATE_LOG = GLib.build_filenamev([GLib.get_user_cache_dir(), 'isle', 'update.log']);
/** Longest a started update may take to say who runs it before it counts as never started. */
const UPDATE_START_US = 60 * 1000000;
/** What the installer's output may say about its session; the rest of Settings' own environment is not passed. */
const UPDATE_ENV = ['PATH', 'HOME', 'LANG', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XDG_DATA_DIRS',
    'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP'];

/** Whether version `a` ("1.3.0") is newer than `b`, number by number (as isled's updates.rs). */
function isNewer(a, b) {
    const parts = v => v.split('.').map(part => parseInt(part, 10) || 0);
    const [x, y] = [parts(a), parts(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if ((x[i] ?? 0) !== (y[i] ?? 0))
            return (x[i] ?? 0) > (y[i] ?? 0);
    }
    return false;
}

/** "today", "yesterday" or the date, for when isled last asked GitHub. */
function checkedWhen(ms) {
    const then = GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
    const now = GLib.DateTime.new_now_local();
    const days = now.get_day_of_year() - then.get_day_of_year() + 365 * (now.get_year() - then.get_year());
    return days <= 0 ? 'today' : days === 1 ? 'yesterday' : then.format('%e %b').trim();
}

/** The version in `dir`'s metadata.json, and when it was put there (µs): after an update, the new one,
 * while the old still runs. */
function versionIn(dir) {
    try {
        const file = Gio.File.new_for_path(GLib.build_filenamev([dir, 'metadata.json']));
        const version = JSON.parse(new TextDecoder().decode(file.load_contents(null)[1]))['version-name'] ?? '';
        const at = file.query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null).get_modification_date_time().to_unix_usec();
        return {version, at};
    } catch {
        return {version: '', at: 0};
    }
}

/** Why the installer stopped, in plain words: from its own "Isle: …" line or a program's error, a known
 * reason; anything else is said as a try again (the details stay in the installer's log). */
function updateFailure(output) {
    const escapes = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
    // Not Isle's markers, nor the steps ("==> Downloading").
    const lines = output.split('\n').map(line => line.replace(escapes, '').trim())
        .filter(line => line && !/^isle-update(-pid|-done)? /.test(line) && !line.startsWith('==>'));
    const all = lines.join('\n');
    const reasons = [
        // curl: no such host, refused, timed out, TLS or the connection dropped.
        [/could not reach GitHub|^curl: \((6|7|28|35|56)\)/m, 'Isle couldn’t reach GitHub; check the internet connection'],
        [/GitHub limits how often/, 'GitHub limits how often it is asked; try again in an hour'],
        [/GitHub answered|^curl: \(22\)/m, 'GitHub had a problem just now; try again in a while'],
        [/no release .*was found/, 'That version isn’t on GitHub yet; try again later'],
        [/damaged|checksum|unexpected layout|download failed/, 'The download didn’t come through whole; try again'],
        [/made for GNOME Shell (\d+ to \d+)/, 'This version of Isle doesn’t support this GNOME yet; nothing was changed'],
        [/No space left on device|Disk quota exceeded/, 'The disk is full; free some space and try again'],
        [/Permission denied|Read-only file system/, 'Isle couldn’t write its files; try again'],
        [/please install (\S+) first/, null],
        // Failures another try won't fix as it is: no build for this kind of computer, or one install at a time.
        [/no ready-built Isle for/, 'There’s no ready-made Isle for this computer; build it from source instead'],
        [/another install of Isle is running/, 'Another install of Isle is running; wait for it, then try again'],
        // Settings' own line when the installer couldn't be started at all.
        [/the update didn.t start/, 'The update didn’t start; try again'],
    ];
    for (const [pattern, words] of reasons) {
        const found = pattern.exec(all);
        if (found)
            return words ?? `Install ${found[1]}, then try again`;
    }
    return lines.length ? 'The update didn’t finish; try again' : 'the installer stopped';
}

/** The last update per its log, {version, text, done: exit status or null, running}, or null. Running: its
 * installer is alive in this boot, or it just started and hasn't named its pid yet. */
function readUpdateLog() {
    try {
        const file = Gio.File.new_for_path(UPDATE_LOG);
        const text = new TextDecoder().decode(file.load_contents(null)[1]);
        const version = /^isle-update (\S+)/.exec(text)?.[1];
        if (!version)
            return null;
        const done = /^isle-update-done (\d+)$/m.exec(text);
        const [, pid, boot] = /^isle-update-pid (\d+) ?(\S*)$/m.exec(text) ?? [];
        const at = file.query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null).get_modification_date_time().to_unix_usec();
        let running = false;
        if (!done && pid) {
            const [, thisBoot] = GLib.file_get_contents('/proc/sys/kernel/random/boot_id');
            const cmdline = `/proc/${pid}/cmdline`;
            running = boot === new TextDecoder().decode(thisBoot).trim() && GLib.file_test(cmdline, GLib.FileTest.EXISTS) &&
                new TextDecoder().decode(GLib.file_get_contents(cmdline)[1]).includes('isle-installer');
        } else if (!done) {
            running = GLib.get_real_time() - at < UPDATE_START_US;
        }
        return {version, text, done: done ? Number(done[1]) : null, running, at};
    } catch {
        return null;
    }
}

/** Runs the installer for `version` on its own, as a unit of the user's systemd (else a process of its own),
 * so closing Settings doesn't stop it half way; its output goes to UPDATE_LOG. */
function startUpdate(version) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(UPDATE_LOG), 0o700);
    GLib.file_set_contents(UPDATE_LOG, `isle-update ${version}\n`);
    const script = ['bash', '-c', UPDATE_SCRIPT, 'isle-installer', version, UPDATE_LOG];
    const run = argv => Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
    if (GLib.find_program_in_path('systemd-run')) {
        const env = UPDATE_ENV.filter(name => GLib.getenv(name)).map(name => `--setenv=${name}=${GLib.getenv(name)}`);
        // systemd reads "$$" in a command as a "$": written twice, the shell gets its own pid.
        const escaped = script.map(arg => arg.split('$$').join('$$$$'));
        const unit = run(['systemd-run', '--user', '--collect', '--quiet', `--unit=isle-update-${GLib.get_real_time()}`,
            ...env, ...escaped]);
        // No user systemd (some containers, other inits): run it directly.
        unit.wait_check_async(null, (proc, result) => {
            try {
                proc.wait_check_finish(result);
            } catch {
                run(script);
            }
        });
    } else {
        run(script);
    }
}

/** Logs out as GNOME's own menu does, asking first; GNOME Shell loads the new Isle at the next login. */
function logOut() {
    Gio.DBus.session.call('org.gnome.SessionManager', '/org/gnome/SessionManager', 'org.gnome.SessionManager',
        'Logout', new GLib.Variant('(u)', [0]), null, Gio.DBusCallFlags.NONE, -1, null, (bus, result) => {
            try {
                bus.call_finish(result);
            } catch {
                GLib.spawn_async(null, ['gnome-session-quit', '--logout'], null, GLib.SpawnFlags.SEARCH_PATH, null);
            }
        });
}

/** The About page's update status and the switch to ask GitHub, following what isled last found (its
 * updates.json). A one-line install updates in a click; a package says how its kind updates. */
function updateRows(settings, window, version, dir) {
    const packaged = dir.startsWith('/usr/');
    // Its words come from the installer's output and GitHub too: shown as they are, never as markup.
    const status = new Adw.ActionRow({use_markup: false});
    const icon = new Gtk.Image({valign: Gtk.Align.CENTER});
    const spinner = new Gtk.Spinner({valign: Gtk.Align.CENTER, spinning: true, visible: false});
    status.add_prefix(icon);
    status.add_prefix(spinner);
    const button = (label, css) => new Gtk.Button({label, valign: Gtk.Align.CENTER, css_classes: css, visible: false});
    const how = button('How', ['flat']);
    how.connect('clicked', () => new Gtk.UriLauncher({uri: UPDATE_HELP}).launch(window, null, null));
    const copy = button('Copy command', []);
    copy.tooltip_text = INSTALL_COMMAND;
    copy.connect('clicked', () => {
        window.get_display().get_clipboard().set(INSTALL_COMMAND);
        copy.label = 'Copied';
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            copy.label = 'Copy command';
            return GLib.SOURCE_REMOVE;
        });
    });
    const download = button('Download', []);
    download.connect('clicked', () => new Gtk.UriLauncher({uri: RELEASES}).launch(window, null, null));
    const update = button('Update', ['suggested-action']);
    const logOutButton = button('Log Out', ['suggested-action']);
    logOutButton.connect('clicked', () => logOut());
    for (const suffix of [how, copy, download, update, logOutButton])
        status.add_suffix(suffix);
    const check = switchRow(settings, 'check-updates', 'Check for new versions', 'Asks GitHub once a day; nothing else is sent');

    const file = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(), 'isle', 'updates.json']));
    let updating = false;
    /** The timer looking at a running update again (see `sync`). */
    let watching = 0;
    const show = (iconName, css, title, subtitle, buttons = []) => {
        icon.icon_name = iconName;
        icon.css_classes = css;
        icon.visible = !updating;
        spinner.visible = updating;
        status.title = title;
        status.subtitle = subtitle;
        for (const suffix of [how, copy, download, update, logOutButton])
            suffix.visible = buttons.includes(suffix);
    };
    const readChecked = () => {
        try {
            return JSON.parse(new TextDecoder().decode(file.load_contents(null)[1]));
        } catch {
            return null;
        }
    };
    const sync = () => {
        const checked = readChecked();
        const on = settings.get_boolean('check-updates');
        const {version: installed, at: installedAt} = versionIn(dir);
        const newer = on && Boolean(checked?.latest) && isNewer(checked.latest, version);
        // The last update, also one started before Settings was closed and opened again.
        const last = readUpdateLog();
        updating = Boolean(last?.running);
        // Failed or cut off (a logout or restart ended it). Not when its version is in place (the extension
        // goes in whole, after the programs: what stopped came after) or any install came since (a terminal).
        const failed = last && !last.running && last.done !== 0 && !packaged && last.version === checked?.latest &&
            installed !== last.version && !(installedAt > last.at);
        // While it runs, looked at again now and then: an installer ended by a logout says nothing more.
        if (updating && !watching) {
            watching = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
                sync();
                if (updating)
                    return GLib.SOURCE_CONTINUE;
                watching = 0;
                return GLib.SOURCE_REMOVE;
            });
        }
        if (updating) {
            show(null, [], `Updating to Isle ${last.version}…`, 'Downloading and installing; Settings can be closed');
        } else if (failed) {
            // Before "installed": one that stopped half way may have put part of it in place.
            update.label = 'Try Again';
            const why = (last.done === null ? 'it was cut off before it finished' : updateFailure(last.text)).replace(/\.+$/, '');
            show('dialog-warning-symbolic', ['warning'], 'Couldn’t update',
                `${why[0].toUpperCase()}${why.slice(1)}. Or paste the command in a terminal`, [copy, update]);
        } else if (installed && isNewer(installed, version)) {
            // Installed, here or from a terminal: the shell runs the old one until the next login.
            show('object-select-symbolic', ['success'], `Isle ${installed} is installed`,
                'Log out and back in to finish', [logOutButton]);
        } else if (!on) {
            show('software-update-available-symbolic', ['dim-label'], 'Not checking for new versions',
                'Turn it on below to hear when one is out');
        } else if (newer && packaged) {
            const arch = GLib.file_test('/etc/arch-release', GLib.FileTest.EXISTS);
            show('software-update-available-symbolic', ['accent'], `Isle ${checked.latest} is out`, arch
                ? 'Update it the way you installed it from the AUR, then log out and back in'
                : `Download its .${GLib.file_test('/etc/debian_version', GLib.FileTest.EXISTS) ? 'deb' : 'rpm'} and open it to install, then log out and back in`,
            arch ? [how] : [how, download]);
        } else if (newer) {
            update.label = 'Update';
            show('software-update-available-symbolic', ['accent'], `Isle ${checked.latest} is out`,
                'Your tasks, events and settings stay', [update]);
        } else if (checked?.at_ms && checked.latest) {
            // Only once GitHub answered: a look that failed stamps the time too, with no version.
            show('object-select-symbolic', ['success'], 'You’re up to date', `Checked ${checkedWhen(checked.at_ms)}`);
        } else {
            show('software-update-available-symbolic', ['dim-label'], 'Not checked yet', 'Isle asks GitHub once a day');
        }
    };
    update.connect('clicked', () => {
        const latest = readChecked()?.latest;
        // Never two at once: one may still run from before Settings was opened again.
        if (!latest || updating || readUpdateLog()?.running)
            return;
        try {
            startUpdate(latest);
        } catch (e) {
            console.warn(`Isle: could not start the update: ${e.message}`);
            GLib.file_set_contents(UPDATE_LOG, `isle-update ${latest}\nIsle: the update didn’t start\nisle-update-done 1\n`);
        }
        sync();
    });
    // isled writes updates.json after each look (switched on, or once a day), the installer its log as it
    // goes: the row follows while open.
    const monitors = [file, Gio.File.new_for_path(UPDATE_LOG)].map(watched => {
        const monitor = watched.monitor_file(Gio.FileMonitorFlags.NONE, null);
        monitor.connect('changed', () => sync());
        return monitor;
    });
    const changed = settings.connect('changed::check-updates', () => sync());
    window.connect('close-request', () => {
        monitors.forEach(monitor => monitor.cancel());
        settings.disconnect(changed);
        if (watching)
            GLib.Source.remove(watching);
        watching = 0;
        return false;
    });
    sync();
    return [status, check];
}

/** Runs `isled --report` and puts what it says on the clipboard, saying so on `row`. */
function copyReport(window, row) {
    const isled = findProgram('isled');
    if (!isled) {
        row.subtitle = 'Isle isn’t fully installed; install it again, then try this';
        return;
    }
    const process = Gio.Subprocess.new([isled, '--report'], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
    process.communicate_utf8_async(null, null, (_process, result) => {
        try {
            const [, output] = process.communicate_utf8_finish(result);
            window.get_display().get_clipboard().set(output);
            row.subtitle = 'Copied: paste it into the report on GitHub';
        } catch (e) {
            console.warn(`Isle: could not make the report: ${e.message}`);
            row.subtitle = 'Couldn’t make the report; try again';
        }
    });
}

/** Lists the ignored apps, each with a remove button, and a search to add one. */
function fillIgnoredApps(group, settings) {
    const key = 'clipboard-ignored-apps';
    const apps = Gio.AppInfo.get_all()
        .filter(app => app.should_show() && app.get_id())
        .sort((a, b) => a.get_display_name().localeCompare(b.get_display_name()));
    let rows = [];

    const add = new Adw.ComboRow({
        title: 'Add an app',
        model: Gtk.StringList.new(['Choose…', ...apps.map(app => app.get_display_name())]),
        // Search needs to know what text to match.
        expression: new Gtk.PropertyExpression(Gtk.StringObject, null, 'string'),
        enable_search: true,
    });
    add.connect('notify::selected', () => {
        const app = apps[add.selected - 1];
        if (!app)
            return;
        const ids = settings.get_strv(key);
        if (!ids.includes(app.get_id()))
            settings.set_strv(key, [...ids, app.get_id()]);
        add.selected = 0;
    });

    const refresh = () => {
        rows.forEach(row => group.remove(row));
        // Only apps on this computer; the built-in list names others too.
        rows = settings.get_strv(key).map(id => [id, DesktopAppInfo.new(id)]).filter(([, app]) => app).map(([id, app]) => {
            const row = new Adw.ActionRow({title: app.get_display_name()});
            if (app.get_icon())
                row.add_prefix(new Gtk.Image({gicon: app.get_icon(), pixel_size: 24}));
            const remove = new Gtk.Button({icon_name: 'list-remove-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat']});
            remove.set_tooltip_text('Keep copies from this app again');
            remove.connect('clicked', () => settings.set_strv(key, settings.get_strv(key).filter(other => other !== id)));
            row.add_suffix(remove);
            return row;
        });
        // Keep "Add an app" last.
        group.remove(add);
        rows.forEach(row => group.add(row));
        group.add(add);
    };
    group.add(add);
    const changed = settings.connect(`changed::${key}`, refresh);
    group.connect('destroy', () => settings.disconnect(changed));
    refresh();
}

/** Whether `command` is on the PATH, as `which` would find it. */
function findProgram(command) {
    try {
        return GLib.find_program_in_path(command) !== null;
    } catch {
        return false;
    }
}
