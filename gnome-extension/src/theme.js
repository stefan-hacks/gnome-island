// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 stefan-hacks

// The island's look: GNOME's own dark or light grey, following the system's appearance setting. What Cairo paints in the island's
// colour asks here; CSS does the rest. Settings loads it too: no shell imports.

import {legibleOn} from './contrast.js';

const LOOKS = {
    // GNOME dark grey: the panel and menus of GNOME's default dark style, so the island blends in.
    gnome: {fill: [0.118, 0.118, 0.118, 1], solid: [0.118, 0.118, 0.118], edge: null, blur: null},
};

// Light GNOME: Adwaita light background for the panel and menus.
const GNOME_LIGHT = {fill: [0.965, 0.965, 0.965, 1], solid: [0.965, 0.965, 0.965]};

let _current = 'gnome';
/** Whether the GNOME scheme is dark ('prefer-dark') or light (anything else). */
let gnomeScheme = 'prefer-dark';

/** Sets the look by its Settings name (only gnome is left). */
export function setTheme(name) {
    _current = name === 'gnome' ? 'gnome' : 'gnome';
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

/** What is drawn over the island's fill (lines, strokes, rings): white on the dark island, near-black on the light. */
export function ink() {
    return gnomeDark() ? [1, 1, 1] : [0.118, 0.118, 0.118];
}

/**
 * A signal colour (green, red, orange…, or white for a neutral alert) as RGB for the island. On the light island
 * it is darkened until it shows against the fill (3:1, as icons and lines need); the dark one keeps it as it is.
 */
export function semantic(rgb) {
    return gnomeDark() ? rgb : legibleOn(rgb, GNOME_LIGHT.solid, 3);
}

/** How what is behind the island is blurred and toned, or null for not at all. */
export function blur() {
    return look().blur;
}
