// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 stefan-hacks

// The system colours in dark mode, as RGB 0..1; the stylesheet uses the same hex values.

import Gio from 'gi://Gio';

// "rrggbb" as [r, g, b] in 0..1.
const rgb = hex => [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);

export const WHITE = [1, 1, 1];
export const GREEN = rgb('30d158');
export const RED = rgb('ff453a');
export const BLUE = rgb('0a84ff');
export const ORANGE = rgb('ff9f0a');
export const INDIGO = rgb('5e5ce6');

/** GNOME accent colour names → hex (the accent_bg_color of libadwaita), for GNOME 47 and later. */
const ACCENT_MAP = {
    blue: '3584e4', teal: '2190a4', green: '3a944a', yellow: 'c88800',
    orange: 'ed5b00', red: 'e62d2d', pink: 'd56199', purple: '9141ac',
    slate: '6f8396',
};

let _interface = null;
let _hasAccent = false;

/** The desktop's settings, made once; null where there is no accent colour (GNOME 46 and earlier). */
function interfaceSettings() {
    if (_interface !== null)
        return _interface || null;
    _interface = false;
    try {
        const schema = Gio.SettingsSchemaSource.get_default()?.lookup('org.gnome.desktop.interface', true);
        // Asking for a key that is not there would end the shell, so look first.
        if (schema?.has_key('accent-color')) {
            _interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
            _hasAccent = true;
        }
    } catch {
        _interface = false;
    }
    return _interface || null;
}

/** The user's chosen GNOME accent colour as [r, g, b], read as it is now, or BLUE where there is none. */
export function accent() {
    const settings = interfaceSettings();
    if (!_hasAccent || !settings)
        return BLUE;
    return rgb(ACCENT_MAP[settings.get_string('accent-color')] ?? ACCENT_MAP.blue);
}

/** Calls `callback` whenever the user picks another accent colour; returns what to give to `unwatchAccent`. */
export function watchAccent(callback) {
    const settings = interfaceSettings();
    if (!_hasAccent || !settings)
        return null;
    return settings.connect('changed::accent-color', callback);
}

/** Stops what `watchAccent` started. */
export function unwatchAccent(id) {
    if (id !== null && id !== undefined && _interface)
        _interface.disconnect(id);
}
