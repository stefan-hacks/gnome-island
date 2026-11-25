// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 stefan-hacks

// The island's look: Isle's own black, or glass over what is behind it. What Cairo paints in the island's
// colour asks here; CSS does the rest. Settings loads it too: no shell imports.

let _autoThemeColors = null;
export function setAutoThemeColors(fn) {
    _autoThemeColors = fn;
}

// What is behind is blurred and toned in one pass (glass.js): its lightness mapped to lo + span × l^gamma, its
// colour kept × saturation (`small` on a closed island or an alert, `large` open), a sheen and a glow added.
const LOOKS = {
    // GNOME dark grey: the panel and menus of GNOME's default dark style, so the island blends in.
    gnome: {fill: [0.118, 0.118, 0.118, 1], solid: [0.118, 0.118, 0.118], edge: null, blur: null},
};

// Light GNOME: Adwaita light background for the panel and menus.
const GNOME_LIGHT = {fill: [0.965, 0.965, 0.965, 1], solid: [0.965, 0.965, 0.965]};

let _current = 'gnome';
let autoActive = false;
/** Whether the GNOME scheme is dark ('prefer-dark') or light (anything else). */
let gnomeScheme = 'prefer-dark';

/** Sets the look by its Settings name (gnome or auto). */
export function setTheme(name) {
    _current = name === 'gnome' ? 'gnome' : 'gnome';
}

/** Enable or disable auto-theme override. When active, auto-theme colours take precedence. */
export function setAutoTheme(active) {
    autoActive = active;
}

/** Sets the GNOME colour scheme so the 'gnome' theme adapts: 'prefer-dark' or anything else for light. */
export function setGnomeScheme(scheme) {
    gnomeScheme = scheme;
    const dark = gnomeScheme === 'prefer-dark';
    LOOKS.gnome.fill = dark ? [0.118, 0.118, 0.118, 1] : [...GNOME_LIGHT.fill];
    LOOKS.gnome.solid = dark ? [0.118, 0.118, 0.118] : [...GNOME_LIGHT.solid];
}

/** Whether the current 'gnome' theme is in dark mode. */
export function gnomeDark() {
    return gnomeScheme === 'prefer-dark';
}

/** The look in use. */
const look = () => {
    if (autoActive) {
        const auto = _autoThemeColors ? _autoThemeColors() : null;
        if (auto)
            return {fill: auto.fill, solid: auto.solid, edge: null, blur: null};
    }
    return LOOKS.gnome;
};

/** Whether the island shows what is behind it (always false now). */
export function translucent() {
    return false;
}

/** The island's colour as RGBA in 0..1. */
export function fill() {
    return look().fill;
}

/** An opaque colour as dark as the island looks, as RGB: for rings and corners painted over it. */
export function solid() {
    return look().solid;
}

/** The rim of light round the island, or null. */
export function edge() {
    return look().edge;
}

/** A signal colour (green, red, orange…) as RGB for the island. */
export function semantic(rgb) {
    return rgb;
}

/** How what is behind the island is blurred and toned, or null for not at all. */
export function blur() {
    return look().blur;
}
