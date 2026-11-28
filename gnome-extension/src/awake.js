// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 stefan-hacks

// Keep awake: while on, the screen does not blank and the computer does not suspend from being idle. It asks
// GNOME's session for an inhibitor, which the session drops by itself if the shell goes, so nothing can be left on.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BUS_NAME = 'org.gnome.SessionManager';
const OBJECT_PATH = '/org/gnome/SessionManager';
/** Inhibit suspending (4) and the session going idle (8): the screen stays on and the computer awake. */
const SUSPEND_AND_IDLE = 4 | 8;

export class KeepAwake {
    constructor() {
        /** The inhibitor's cookie while on, else 0. */
        this._cookie = 0;
        this._busy = false;
        this._destroyed = false;
        /** Called as it turns on or off. */
        this.onChanged = null;
    }

    get active() {
        return this._cookie !== 0;
    }

    /** Turns it on, or off if it is on. Ignored while a request is still on its way. */
    toggle() {
        if (this._busy || this._destroyed)
            return;
        if (this._cookie)
            this._release();
        else
            this._acquire();
    }

    _call(method, parameters, replyType, callback) {
        this._busy = true;
        Gio.DBus.session.call(BUS_NAME, OBJECT_PATH, BUS_NAME, method, parameters, replyType,
            Gio.DBusCallFlags.NONE, 2000, null, (connection, result) => {
                this._busy = false;
                try {
                    callback(connection.call_finish(result));
                } catch (e) {
                    console.warn(`Isle: keep awake: ${method} failed: ${e.message}`);
                }
            });
    }

    _acquire() {
        this._call('Inhibit',
            new GLib.Variant('(susu)', ['gnome-island@stefan-hacks.github.com', 0, 'Kept awake from Isle', SUSPEND_AND_IDLE]),
            new GLib.VariantType('(u)'), reply => {
                const [cookie] = reply.deepUnpack();
                // Turned off meanwhile (the extension went): let it go again at once.
                if (this._destroyed) {
                    this._uninhibit(cookie);
                    return;
                }
                this._cookie = cookie;
                this.onChanged?.();
            });
    }

    _release() {
        const cookie = this._cookie;
        this._cookie = 0;
        this._uninhibit(cookie);
        this.onChanged?.();
    }

    _uninhibit(cookie) {
        Gio.DBus.session.call(BUS_NAME, OBJECT_PATH, BUS_NAME, 'Uninhibit', new GLib.Variant('(u)', [cookie]), null,
            Gio.DBusCallFlags.NONE, 2000, null, (connection, result) => {
                try {
                    connection.call_finish(result);
                } catch (e) {
                    console.warn(`Isle: keep awake: Uninhibit failed: ${e.message}`);
                }
            });
    }

    /** Lets go when Isle is turned off. */
    destroy() {
        this._destroyed = true;
        if (this._cookie) {
            this._uninhibit(this._cookie);
            this._cookie = 0;
        }
        this.onChanged = null;
    }
}
