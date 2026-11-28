// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 stefan-hacks

// The drives page's rules, with no shell imports: which mounts and volumes are removable media worth listing, and
// how their space is written.

/**
 * Whether a mount is removable media to list: a USB stick, an SD card, an external disk. Not the computer's own
 * disks, not a network share, and not one that another mount shadows.
 */
export function isRemovable({shadowed, hasDrive, driveRemovable, mediaRemovable, canEject}) {
    if (shadowed || !hasDrive)
        return false;
    return Boolean(driveRemovable || mediaRemovable || canEject);
}

/** Whether a volume that is not mounted can be offered for mounting: removable, and mountable. */
export function isMountable({hasMount, hasDrive, driveRemovable, mediaRemovable, canMount}) {
    return !hasMount && hasDrive && Boolean(driveRemovable || mediaRemovable) && Boolean(canMount);
}

/** A size in bytes as "14.9 GB" (decimal, as GNOME's Files writes it). */
export function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0)
        return '';
    const units = ['B', 'kB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit++;
    }
    const text = unit === 0 || value >= 100 ? Math.round(value).toString() : value.toFixed(1);
    return `${text} ${units[unit]}`;
}

/** The space line and how full the drive is: {text: "12.3 GB free of 32 GB", used: 0..1}; null when unknown. */
export function describeSpace(size, free) {
    if (!Number.isFinite(size) || !Number.isFinite(free) || size <= 0)
        return null;
    const used = Math.min(Math.max((size - free) / size, 0), 1);
    return {text: `${formatSize(free)} free of ${formatSize(size)}`, used};
}
