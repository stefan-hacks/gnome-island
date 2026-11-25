// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 stefan-hacks

// Wallpaper color extraction and curated-bundle matching.
// Uses GdkPixbuf to sample the desktop wallpaper, then compares its
// overall character against each bundle's `characteristics` fingerprint.

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {getBundles} from './themeBundles.js';

/** How many pixels to skip between samples (higher = faster, coarser). */
const SAMPLE_STEP = 8;
/** Minimum brightness to count a pixel (skip near-black). */
const MIN_LUMINANCE = 0.03;
/** Maximum brightness to count a pixel (skip near-white). */
const MAX_LUMINANCE = 0.97;
/** Minimum saturation to count a pixel for chroma/hue (skip greys). */
const MIN_SATURATION = 0.08;

/** Convert RGB 0..255 to HSL: {h:0..360, s:0..1, l:0..1}. */
function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min)
        return {h: 0, s: 0, l};
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    switch (max) {
    case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
    case g: h = ((b - r) / d + 2); break;
    default: h = ((r - g) / d + 4); break;
    }
    return {h: h * 60, s, l};
}

/** Extract a colour fingerprint from `pixbuf`. Returns null on failure. */
function extractFingerprint(pixbuf) {
    const width = pixbuf.get_width();
    const height = pixbuf.get_height();
    const rowstride = pixbuf.get_rowstride();
    const nChannels = pixbuf.get_n_channels();
    const pixels = pixbuf.get_pixels();
    const hasAlpha = pixbuf.get_has_alpha();

    let totalR = 0, totalG = 0, totalB = 0;
    let count = 0;
    let hueCount = 0;
    let hueSin = 0, hueCos = 0;
    let satSum = 0, lumSum = 0;
    let _warmR = 0, _warmG = 0, _warmB = 0, warmCount = 0;
    let _coolR = 0, _coolG = 0, _coolB = 0, coolCount = 0;

    for (let y = 0; y < height; y += SAMPLE_STEP) {
        const rowStart = y * rowstride;
        for (let x = 0; x < width; x += SAMPLE_STEP) {
            const i = rowStart + x * nChannels;
            if (hasAlpha && pixels[i + 3] < 128)
                continue; // skip transparent
            const r = pixels[i];
            const g = pixels[i + 1];
            const b = pixels[i + 2];
            const {h, s, l} = rgbToHsl(r, g, b);

            if (l < MIN_LUMINANCE || l > MAX_LUMINANCE)
                continue;

            totalR += r;
            totalG += g;
            totalB += b;
            count++;
            satSum += s;
            lumSum += l;

            if (s >= MIN_SATURATION) {
                const rad = h * Math.PI / 180;
                hueSin += Math.sin(rad);
                hueCos += Math.cos(rad);
                hueCount++;
            }

            // Warm vs cool bias: red-orange-yellow vs blue-cyan
            if (s >= MIN_SATURATION) {
                if (h >= 0 && h < 60 || h >= 330) {
                    _warmR += r; _warmG += g; _warmB += b; warmCount++;
                } else if (h >= 180 && h < 270) {
                    _coolR += r; _coolG += g; _coolB += b; coolCount++;
                }
            }
        }
    }

    if (count === 0)
        return null;

    const avgR = totalR / count;
    const avgG = totalG / count;
    const avgB = totalB / count;
    const avgHsl = rgbToHsl(avgR, avgG, avgB);

    const avgHue = hueCount > 0
        ? (Math.atan2(hueSin / hueCount, hueCos / hueCount) * 180 / Math.PI + 360) % 360
        : avgHsl.h;

    // Warmth: +1 means strongly warm (reds/oranges), -1 means strongly cool (blues)
    let warmth = 0;
    if (warmCount + coolCount > 0) {
        warmth = (warmCount - coolCount) / (warmCount + coolCount);
    }
    // Also factor in actual average hue
    if (avgHue >= 0 && avgHue < 60 || avgHue >= 330)
        warmth = warmth * 0.5 + 0.5;
    else if (avgHue >= 180 && avgHue < 240)
        warmth = warmth * 0.5 - 0.5;

    const saturation = satSum / count;
    const lightness = lumSum / count;

    // Determine chroma category
    let chroma;
    if (saturation < 0.15)
        chroma = 'grey';
    else if (lightness > 0.6 && saturation < 0.4)
        chroma = 'pastel';
    else if (warmth > 0.2 && saturation < 0.35)
        chroma = 'earth';
    else if (saturation > 0.6)
        chroma = 'neon';
    else if (warmth > 0.2)
        chroma = 'warm';
    else
        chroma = 'cool';

    return {
        warmth: Math.max(-1, Math.min(1, warmth)),
        saturation: Math.max(0, Math.min(1, saturation)),
        lightness: Math.max(0, Math.min(1, lightness)),
        chroma,
        accentHue: avgHue,
        avgR, avgG, avgB,
    };
}

/** Load the GNOME desktop wallpaper and extract its colour fingerprint. */
export function extractWallpaperFingerprint() {
    const background = new Gio.Settings({schema: 'org.gnome.desktop.background'});
    const uri = background.get_string('picture-uri');
    const darkUri = background.get_string('picture-uri-dark');
    const useDark = GLib.getenv('GTK_THEME')?.includes('dark') ?? true;
    const path = GLib.filename_from_uri(useDark && darkUri ? darkUri : uri)?.[0] ?? '';
    if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS))
        return null;
    try {
        const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_size(path, 256, 256);
        if (!pixbuf)
            return null;
        const result = extractFingerprint(pixbuf);
        // pixbuf memory managed by GObject, no explicit free needed in GJS
        return result;
    } catch (e) {
        log(`isle: wallpaper extraction failed: ${e.message}`);
        return null;
    }
}

/** Compute Euclidean distance between two fingerprints, weighted. */
function fingerprintDistance(a, b) {
    const dw = (a.warmth - b.warmth) * 1.5;
    const ds = (a.saturation - b.saturation) * 1.0;
    const dl = (a.lightness - b.lightness) * 2.0;
    const dh = hueDistance(a.accentHue, b.accentHue) / 180 * 1.0;
    // Chroma mismatch penalty
    const dc = a.chroma !== b.chroma ? 0.3 : 0;
    return Math.sqrt(dw * dw + ds * ds + dl * dl + dh * dh + dc * dc);
}

/** Shortest distance around the hue circle. */
function hueDistance(a, b) {
    const d = Math.abs(a - b);
    return Math.min(d, 360 - d);
}

/** Find the bundle whose characteristics best match the wallpaper fingerprint. */
export function matchBundle(fingerprint) {
    if (!fingerprint)
        return null;
    const bundles = getBundles();
    let best = null;
    let bestDist = Infinity;
    for (const bundle of bundles) {
        const dist = fingerprintDistance(fingerprint, bundle.characteristics);
        if (dist < bestDist) {
            bestDist = dist;
            best = bundle;
        }
    }
    return best;
}

/** Full pipeline: extract wallpaper fingerprint and return the best matching bundle. */
export function matchWallpaper() {
    const fingerprint = extractWallpaperFingerprint();
    return matchBundle(fingerprint);
}
