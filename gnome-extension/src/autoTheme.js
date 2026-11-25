// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 stefan-hacks

// Auto-theme orchestrator: extracts wallpaper colours, matches to the closest curated bundle,
// and applies it to the island, GNOME Shell, GTK3/4, Flatpak apps, and kitty.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {getBundle} from './themeBundles.js';
import {matchWallpaper} from './wallpaperMatcher.js';
import {applyKittyTheme} from './kittyTheme.js';
import {installGtkCss, uninstallGtkCss, installFlatpakOverride, uninstallFlatpakOverride} from './gtkCss.js';

let _settings = null;
let _backgroundSettings = null;
let _interfaceSettings = null;
let _wallpaperChangedId = 0;
let _themeEnabledId = 0;
let _themeGtkId = 0;
let _themeKittyId = 0;
let _themeShellId = 0;
let _themeRefreshId = 0;
let _currentBundle = null;
let _pendingApply = 0;

/** Called from controller.js on extension enable. */
export function init(settings) {
    _settings = settings;
    _backgroundSettings = new Gio.Settings({schema: 'org.gnome.desktop.background'});
    _interfaceSettings = new Gio.Settings({schema: 'org.gnome.desktop.interface'});

    _themeEnabledId = settings.connect('changed::auto-theme-enabled', () => _onToggle());
    _themeGtkId = settings.connect('changed::auto-theme-gtk', () => _onToggle());
    _themeKittyId = settings.connect('changed::auto-theme-kitty', () => _onToggle());
    _themeShellId = settings.connect('changed::auto-theme-shell', () => _onToggle());
    _themeRefreshId = settings.connect('changed::auto-theme-refresh', () => _onToggle());

    _onToggle();
}

/** Called from controller.js on extension disable. */
export function destroy() {
    _clearTimeout();
    if (_wallpaperChangedId) {
        _backgroundSettings?.disconnect(_wallpaperChangedId);
        _wallpaperChangedId = 0;
    }
    for (const id of [_themeEnabledId, _themeGtkId, _themeKittyId, _themeShellId, _themeRefreshId]) {
        if (id)
            _settings?.disconnect(id);
    }
    _themeEnabledId = _themeGtkId = _themeKittyId = _themeShellId = _themeRefreshId = 0;
    _settings = null;
    _backgroundSettings = null;
    _interfaceSettings = null;
    _currentBundle = null;
}

/** Re-run when any auto-theme switch changes. */
function _onToggle() {
    const enabled = _settings.get_boolean('auto-theme-enabled');
    _clearTimeout();

    if (_wallpaperChangedId) {
        _backgroundSettings.disconnect(_wallpaperChangedId);
        _wallpaperChangedId = 0;
    }

    if (!enabled) {
        _unapply();
        return;
    }

    // Listen for wallpaper changes
    if (_settings.get_boolean('auto-theme-refresh')) {
        _wallpaperChangedId = _backgroundSettings.connect('changed::picture-uri', () => _scheduleApply());
    }

    _scheduleApply();
}

/** Debounce apply so multiple changes don't stack. */
function _scheduleApply() {
    _clearTimeout();
    _pendingApply = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        _pendingApply = 0;
        applyAutoTheme();
        return GLib.SOURCE_REMOVE;
    });
}

function _clearTimeout() {
    if (_pendingApply) {
        GLib.source_remove(_pendingApply);
        _pendingApply = 0;
    }
}

/** Apply the auto-theme now. Returns the matched bundle or null. */
export function applyAutoTheme() {
    if (!_settings || !_settings.get_boolean('auto-theme-enabled'))
        return null;

    const bundle = matchWallpaper();
    if (!bundle) {
        log('isle: auto-theme: no wallpaper bundle matched');
        return null;
    }

    _currentBundle = bundle;
    _settings.set_string('auto-theme-current-bundle', bundle.name);

    // Apply to island / GNOME Shell
    if (_settings.get_boolean('auto-theme-shell')) {
        _applyShell(bundle);
    }

    // Apply to GTK
    if (_settings.get_boolean('auto-theme-gtk')) {
        installGtkCss(bundle);
        installFlatpakOverride(bundle);
    } else {
        uninstallGtkCss();
        uninstallFlatpakOverride();
    }

    // Apply to kitty
    if (_settings.get_boolean('auto-theme-kitty')) {
        applyKittyTheme(bundle.kitty);
    }

    log(`isle: auto-theme applied: ${bundle.name} (kitty: ${bundle.kitty})`);
    return bundle;
}

/** Remove auto-theme effects. */
function _unapply() {
    uninstallGtkCss();
    uninstallFlatpakOverride();
    _currentBundle = null;
    _settings?.set_string('auto-theme-current-bundle', '');
}

/** Apply the bundle to GNOME Shell / island appearance. */
function _applyShell(bundle) {
    if (!bundle?.colors)
        return;

    const c = bundle.colors;

    // Set GNOME accent colour
    if (bundle.gnomeAccent) {
        try {
            _interfaceSettings.set_string('accent-color', bundle.gnomeAccent);
        } catch (e) {
            // accent-color may not exist on older GNOME
        }
    }

    // Emit signal for theme.js to pick up new colours
    // We store the current bundle colours in a global that theme.js reads
    _autoThemeColors = {
        fill: hexToRgba(c.background),
        solid: hexToRgb(c.surface),
        accent: hexToRgba(c.accent),
        text: hexToRgba(c.text),
        light: c.lightness >= 0.5,
    };
}

/** The current auto-theme colours for theme.js, or null. */
let _autoThemeColors = null;
export function autoThemeColors() {
    return _autoThemeColors;
}

/** Convert #RRGGBB to [r, g, b, a] in 0..1. */
function hexToRgba(hex, a = 1) {
    return [
        parseInt(hex.slice(1, 3), 16) / 255,
        parseInt(hex.slice(3, 5), 16) / 255,
        parseInt(hex.slice(5, 7), 16) / 255,
        a,
    ];
}

/** Convert #RRGGBB to [r, g, b] in 0..1. */
function hexToRgb(hex) {
    return [
        parseInt(hex.slice(1, 3), 16) / 255,
        parseInt(hex.slice(3, 5), 16) / 255,
        parseInt(hex.slice(5, 7), 16) / 255,
    ];
}

/** Return the currently active bundle, if any. */
export function currentBundle() {
    return _currentBundle;
}

/** Re-apply from stored settings (e.g. after a shell restart). */
export function restoreFromSettings(settings) {
    const name = settings.get_string('auto-theme-current-bundle');
    if (!name)
        return null;
    const bundle = getBundle(name) || null;
    if (bundle)
        _currentBundle = bundle;
    return bundle;
}
