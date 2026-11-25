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

/** GNOME accent colour names → hex (libadwaita), for reading the user's chosen accent in GNOME 47+. */
const ACCENT_MAP = {
    blue: '3584e4', teal: '21917a', green: '3a944a', yellow: 'c88800',
    orange: 'ed5b00', red: 'e62d2d', pink: 'd56199', purple: '9141ac',
    slate: '6f8396', bark: '7a634b',
};

/** The user's chosen GNOME accent colour as [r, g, b], or BLUE if not available. */
export function accent() {
    try {
        const settings = new Gio.Settings({schema: 'org.gnome.desktop.interface'});
        const name = settings.get_string('accent-color');
        return rgb(ACCENT_MAP[name] ?? '3584e4');
    } catch {
        return BLUE;
    }
}
