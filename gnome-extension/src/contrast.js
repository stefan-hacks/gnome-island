// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 stefan-hacks

// WCAG contrast, for keeping GNOME's accent legible as text on the island in light and dark. No shell imports.

/** The relative luminance (WCAG) of [r, g, b] in 0..1. */
export function luminance([r, g, b]) {
    const lin = c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** The contrast ratio (WCAG) of two colours, 1 to 21. */
export function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

/**
 * `color` moved toward white (on a dark ground) or black (on a light one) until it reads at `ratio` against
 * `ground`: GNOME's accent used as text or a thin line, which the accent as a fill (with its own foreground)
 * does not need.
 */
export function legibleOn(color, ground, ratio = 4.5) {
    const toward = luminance(ground) < 0.5 ? 1 : 0;
    let out = color;
    for (let step = 0; step <= 20 && contrast(out, ground) < ratio; step++)
        out = color.map(c => c + (toward - c) * (step + 1) / 20);
    return out;
}
