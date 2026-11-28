// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 stefan-hacks

// The mixer page's rules, with no shell imports: a stream's volume against the mixer's, and which streams are
// apps playing sound (not the desktop's own sounds).

/** A volume as a fraction of `max` (the mixer's 100%), 0 or more; the slider shows up to `ceiling`. */
export function toFraction(volume, max, ceiling = 1) {
    if (!(max > 0) || !Number.isFinite(volume))
        return 0;
    return Math.min(Math.max(volume / max, 0), ceiling);
}

/** The volume for a slider fraction. */
export function fromFraction(fraction, max) {
    return Math.round(Math.min(Math.max(fraction, 0), 1) * max);
}

/** A stream's percentage as written, "63%". */
export function percentText(fraction) {
    return `${Math.round(Math.min(Math.max(fraction, 0), 1) * 100)}%`;
}

/** The desktop's own sounds are not apps: GNOME's event sounds and the volume control's feedback. */
const DESKTOP_SOUNDS = new Set(['org.gnome.VolumeControl', 'org.gnome.Shell', 'gnome-shell', 'event']);

/** Whether a sink input is an app to list: it has a name, and is not the desktop's own sound. */
export function isAppStream({name, appId, isEvent}) {
    if (isEvent)
        return false;
    if (!name?.trim())
        return false;
    return !DESKTOP_SOUNDS.has(appId ?? '') && !DESKTOP_SOUNDS.has(name);
}

/** Streams in the order the page lists them: by name, then by id so that two of one app keep their places. */
export function byName(a, b) {
    return a.name.localeCompare(b.name) || a.id - b.id;
}
