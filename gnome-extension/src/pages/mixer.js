// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 stefan-hacks

// A volume slider and a mute button for each app that is playing sound, through the same mixer GNOME's own volume
// uses. The tab shows only while an app is playing; the desktop's own sounds are left out.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';

import {VERTICAL} from '../compat.js';
import {byName, fromFraction, isAppStream, percentText, toFraction} from '../mixerRules.js';
import {Slider, icon, iconButton, label, setButtonIcon} from '../widgets.js';
import {Page} from './page.js';

/** A stream's own volume change is not echoed back to its slider for this long (ms), so a drag is not fought. */
const OWN_CHANGE_MS = 300;

/** One app: its icon and name, a slider with its percentage, and mute. */
class MixerRow {
    constructor(stream, mixer) {
        this.stream = stream;
        this._mixer = mixer;
        this._own = 0;
        this.actor = new St.BoxLayout({style_class: 'isle-mixer-row', x_expand: true});
        this._icon = new St.Icon({gicon: icon(stream.icon_name || 'audio-x-generic-symbolic'), icon_size: 18,
            style_class: 'isle-mixer-icon', y_align: Clutter.ActorAlign.CENTER});
        this._name = label(stream.name || stream.description, 'isle-mixer-name');
        this._name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._slider = new Slider({scrollStep: 0.05});
        this._percent = label('', 'isle-mixer-percent');
        this._mute = iconButton('audio-volume-high-symbolic', 'isle-button-flat isle-mixer-mute',
            () => this.stream.change_is_muted(!this.stream.is_muted), {size: 16, accessibleName: 'Mute'});
        const info = new St.BoxLayout({...VERTICAL, style_class: 'isle-mixer-info', y_align: Clutter.ActorAlign.CENTER});
        info.add_child(this._name);
        info.add_child(this._slider);
        this.actor.add_child(this._icon);
        this.actor.add_child(info);
        this.actor.add_child(this._percent);
        this.actor.add_child(this._mute);
        info.x_expand = true;

        this._slider.connect('value-changed', (_slider, value) => {
            this._own = Date.now();
            const max = this._mixer.get_vol_max_norm();
            this.stream.volume = fromFraction(value, max);
            this.stream.push_volume();
            this._percent.text = percentText(value);
        });
        this._ids = ['notify::volume', 'notify::is-muted'].map(signal => this.stream.connect(signal, () => this.update()));
        this.update();
    }

    update() {
        const max = this._mixer.get_vol_max_norm();
        const fraction = toFraction(this.stream.volume, max);
        if (Date.now() - this._own > OWN_CHANGE_MS) {
            this._slider.value = fraction;
            this._percent.text = percentText(fraction);
        }
        const muted = this.stream.is_muted;
        setButtonIcon(this._mute, muted ? 'audio-volume-muted-symbolic' : 'audio-volume-high-symbolic');
        this.actor.opacity = muted ? 150 : 255;
    }

    destroy() {
        this._ids.forEach(id => this.stream.disconnect(id));
        this.actor.destroy();
    }
}

export const MixerPage = GObject.registerClass(
class MixerPage extends Page {
    _init(daemon, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-mixer-page',
            layout_manager: new Clutter.BoxLayout({orientation: Clutter.Orientation.VERTICAL}),
            height,
        });
        this.name = 'mixer';
        this._mixer = getMixerControl();
        /** Rows by the stream's id. */
        this._rows = new Map();

        this._list = new St.BoxLayout({...VERTICAL, style_class: 'isle-mixer-list', x_expand: true});
        const scroll = new St.ScrollView({
            style_class: 'isle-mixer-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
        });
        scroll.set_child(this._list);
        this.add_child(scroll);

        this._ids = ['stream-added', 'stream-removed'].map(signal => this._mixer.connect(signal, () => this._sync()));
        this.connect('destroy', () => this._onDestroy());
        this._sync();
    }

    _onDestroy() {
        this._ids.forEach(id => this._mixer.disconnect(id));
        for (const row of this._rows.values())
            row.destroy();
        this._rows.clear();
    }

    /** Only while an app is playing, and not left out in Settings. */
    get available() {
        return !this.hidden && this._rows.size > 0;
    }

    _sync() {
        const had = this._rows.size > 0;
        let streams = [];
        try {
            streams = (this._mixer.get_sink_inputs() ?? [])
                .map(stream => ({
                    stream,
                    id: stream.id,
                    name: stream.name || stream.description || '',
                    appId: stream.application_id ?? '',
                    isEvent: Boolean(stream.is_event_stream),
                }))
                .filter(isAppStream)
                .sort(byName);
        } catch (e) {
            console.warn(`Isle: mixer: could not list the streams: ${e.message}`);
        }
        const ids = new Set(streams.map(entry => entry.id));
        for (const [id, row] of this._rows) {
            if (!ids.has(id)) {
                row.destroy();
                this._rows.delete(id);
            }
        }
        streams.forEach((entry, index) => {
            let row = this._rows.get(entry.id);
            if (!row) {
                row = new MixerRow(entry.stream, this._mixer);
                this._rows.set(entry.id, row);
                this._list.insert_child_at_index(row.actor, index);
            } else if (this._list.get_child_at_index(index) !== row.actor) {
                this._list.set_child_at_index(row.actor, index);
            }
        });
        if ((this._rows.size > 0) !== had)
            this.emit('availability-changed');
    }
});
