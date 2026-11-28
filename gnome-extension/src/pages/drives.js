// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 stefan-hacks

// Removable drives (USB sticks, SD cards, external disks): each with its space, a button to open it in Files and one
// to eject it safely; one that is plugged in but not mounted has Mount. The tab shows only while there is one. It
// follows GNOME's own volume monitor, so it lists what Files lists.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {VERTICAL} from '../compat.js';
import {describeSpace, isMountable, isRemovable} from '../driveRules.js';
import {iconButton, label, pillButton} from '../widgets.js';
import {Page} from './page.js';

/** How long an error stays in place of the space line (ms). */
const NOTE_MS = 5000;

/** The first line of an error, for the row. */
function why(error) {
    return (error?.message ?? String(error)).split('\n')[0];
}

/** One drive: its icon, name and space, and what can be done with it. */
class DriveRow {
    /** `entry` is {mount} or {volume}; `onChange` asks the page to look again. */
    constructor(entry, cancellable, onChange) {
        this._cancellable = cancellable;
        this._onChange = onChange;
        this._note = 0;
        const mount = entry.mount ?? null;
        const volume = entry.volume ?? null;
        const thing = mount ?? volume;
        this.actor = new St.BoxLayout({style_class: 'isle-drive-row', x_expand: true});
        const gicon = thing.get_symbolic_icon?.() ?? thing.get_icon();
        this.actor.add_child(new St.Icon({gicon, icon_size: 22, style_class: 'isle-drive-icon', y_align: Clutter.ActorAlign.CENTER}));

        const info = new St.BoxLayout({...VERTICAL, style_class: 'isle-drive-info', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const name = label(thing.get_name(), 'isle-drive-name');
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._space = label(volume ? 'Not mounted' : '', 'isle-drive-space');
        this._track = new St.Widget({style_class: 'isle-drive-track', x_expand: true, visible: false});
        this._fill = new St.Widget({style_class: 'isle-drive-fill'});
        this._track.add_child(this._fill);
        this._track.connect('notify::width', () => this._size());
        info.add_child(name);
        info.add_child(this._space);
        info.add_child(this._track);
        this.actor.add_child(info);

        const buttons = new St.BoxLayout({style_class: 'isle-drive-buttons', y_align: Clutter.ActorAlign.CENTER});
        if (mount) {
            buttons.add_child(iconButton('folder-open-symbolic', 'isle-button-flat isle-drive-button', () => this._open(mount),
                {size: 16, accessibleName: 'Open in Files'}));
            buttons.add_child(iconButton('media-eject-symbolic', 'isle-button-flat isle-drive-button', () => this._eject(mount),
                {size: 16, accessibleName: 'Eject'}));
            this._measure(mount);
        } else {
            buttons.add_child(pillButton('Mount', 'isle-pill-small isle-drive-mount', () => this._mount(volume)));
        }
        this.actor.add_child(buttons);
    }

    _size() {
        this._fill.width = Math.round(this._track.width * (this._used ?? 0));
    }

    /** The space, asked of the filesystem; nothing is shown for one that cannot say (a read error, say). */
    _measure(mount) {
        mount.get_root().query_filesystem_info_async('filesystem::size,filesystem::free', 0, this._cancellable, (file, result) => {
            try {
                const info = file.query_filesystem_info_finish(result);
                const space = describeSpace(info.get_attribute_uint64('filesystem::size'), info.get_attribute_uint64('filesystem::free'));
                if (!space)
                    return;
                this._used = space.used;
                this._text = space.text;
                if (!this._note)
                    this._space.text = space.text;
                this._track.visible = true;
                this._size();
            } catch {
                // The drive went, or cannot say: the row stays without a space line.
            }
        });
    }

    /** Shows `text` where the space is, for a few seconds. */
    _say(text) {
        this._space.text = text;
        if (this._note)
            GLib.source_remove(this._note);
        this._note = GLib.timeout_add(GLib.PRIORITY_DEFAULT, NOTE_MS, () => {
            this._note = 0;
            this._space.text = this._text ?? '';
            return GLib.SOURCE_REMOVE;
        });
    }

    _open(mount) {
        try {
            Gio.AppInfo.launch_default_for_uri(mount.get_root().get_uri(), global.create_app_launch_context(0, -1));
        } catch (e) {
            this._say(why(e));
        }
    }

    _eject(mount) {
        const operation = new Gio.MountOperation();
        const done = (finish, source, result) => {
            try {
                finish.call(source, result);
            } catch (e) {
                this._say(why(e));
            }
            this._onChange();
        };
        if (mount.can_eject())
            mount.eject_with_operation(Gio.MountUnmountFlags.NONE, operation, this._cancellable, (m, r) => done(m.eject_with_operation_finish, m, r));
        else
            mount.unmount_with_operation(Gio.MountUnmountFlags.NONE, operation, this._cancellable, (m, r) => done(m.unmount_with_operation_finish, m, r));
    }

    _mount(volume) {
        volume.mount(Gio.MountMountFlags.NONE, new Gio.MountOperation(), this._cancellable, (v, result) => {
            try {
                v.mount_finish(result);
            } catch (e) {
                this._say(why(e));
            }
            this._onChange();
        });
    }

    destroy() {
        if (this._note)
            GLib.source_remove(this._note);
        this._note = 0;
        this.actor.destroy();
    }
}

export const DrivesPage = GObject.registerClass(
class DrivesPage extends Page {
    _init(daemon, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-drives-page',
            layout_manager: new Clutter.BoxLayout({orientation: Clutter.Orientation.VERTICAL}),
            height,
        });
        this.name = 'drives';
        this._monitor = Gio.VolumeMonitor.get();
        this._cancellable = new Gio.Cancellable();
        this._rows = [];

        this._list = new St.BoxLayout({...VERTICAL, style_class: 'isle-drives-list', x_expand: true});
        const scroll = new St.ScrollView({
            style_class: 'isle-drives-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
        });
        scroll.set_child(this._list);
        this.add_child(scroll);

        this._ids = ['mount-added', 'mount-removed', 'mount-changed', 'volume-added', 'volume-removed', 'volume-changed',
            'drive-connected', 'drive-disconnected', 'drive-changed']
            .map(signal => this._monitor.connect(signal, () => this._schedule()));
        this.connect('destroy', () => this._onDestroy());
        this._sync();
    }

    _onDestroy() {
        this._cancellable.cancel();
        this._ids.forEach(id => this._monitor.disconnect(id));
        this._rows.forEach(row => row.destroy());
        this._rows = [];
    }

    /** Only while there is a removable drive, and not left out in Settings. */
    get available() {
        return !this.hidden && this._rows.length > 0;
    }

    /** Looks again soon: one plug-in sends several signals. */
    _schedule() {
        this.later('sync', 150, () => this._sync(), {keep: true});
    }

    _sync() {
        const had = this._rows.length > 0;
        const entries = [];
        for (const mount of this._monitor.get_mounts()) {
            const drive = mount.get_drive();
            if (isRemovable({
                shadowed: mount.is_shadowed(),
                hasDrive: Boolean(drive),
                driveRemovable: drive?.is_removable(),
                mediaRemovable: drive?.is_media_removable(),
                canEject: mount.can_eject() || Boolean(drive?.can_eject()),
            }))
                entries.push({mount});
        }
        for (const volume of this._monitor.get_volumes()) {
            const drive = volume.get_drive();
            if (isMountable({
                hasMount: Boolean(volume.get_mount()),
                hasDrive: Boolean(drive),
                driveRemovable: drive?.is_removable(),
                mediaRemovable: drive?.is_media_removable(),
                canMount: volume.can_mount(),
            }))
                entries.push({volume});
        }
        this._rows.forEach(row => row.destroy());
        this._rows = entries.map(entry => {
            const row = new DriveRow(entry, this._cancellable, () => this._schedule());
            this._list.add_child(row.actor);
            return row;
        });
        if ((this._rows.length > 0) !== had)
            this.emit('availability-changed');
    }
});
