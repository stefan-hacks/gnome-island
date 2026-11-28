// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 stefan-hacks

// The weather for the city set in Settings: now, and the days ahead. It asks Open-Meteo (no key) only while the page
// is on screen and what it has is over ten minutes old; nothing runs in the background. The city's name is the only
// thing sent. Its icons are the theme's symbolic ones, so they take the island's text colour in light and dark.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {VERTICAL} from '../compat.js';
import {createHttp} from '../lyricsHttp.js';
import {DAYS, dayLabel, degrees, describeCode, forecastUrl, geocodeUrl, parseForecast, parsePlace, stale, unitsOf}
    from '../weatherRules.js';
import {icon, label} from '../widgets.js';
import {Page} from './page.js';

/** What to ask for, in words, when there is nothing to show. */
const MESSAGES = {
    empty: ['No city set', 'Choose one in Settings → Island → Weather.'],
    loading: ['Loading the weather…', ''],
    notfound: ['City not found', 'Check its name in Settings → Island → Weather.'],
    error: ['The weather could not be loaded', 'Check the connection; it tries again when you open this page.'],
};

export const WeatherPage = GObject.registerClass(
class WeatherPage extends Page {
    /** `height` is the expanded island's page height. */
    _init(daemon, settings, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-weather-page',
            layout_manager: new Clutter.BoxLayout({orientation: Clutter.Orientation.VERTICAL}),
            height,
        });
        this.name = 'weather';
        this._settings = settings;
        this._http = null;
        this._state = 'empty';
        this._data = null;
        this._place = null;
        this._placeCity = '';
        this._key = '';
        this._fetchedAt = 0;
        this._loading = false;

        this._body = new St.BoxLayout({style_class: 'isle-weather', x_expand: true, y_expand: true});
        this.add_child(this._body);

        this._changed = ['weather-city', 'weather-units'].map(key =>
            settings.connect(`changed::${key}`, () => this.active && this._load(true)));
        this.connect('destroy', () => this._onDestroy());
        this._render();
    }

    onActivate() {
        this._load();
    }

    _onDestroy() {
        this._changed.forEach(id => this._settings.disconnect(id));
        this._http?.destroy();
        this._http = null;
    }

    _wanted() {
        return {city: this._settings.get_string('weather-city').trim(), units: this._settings.get_string('weather-units')};
    }

    /** Asks again if the city or units changed, what it has is old, or `force`; keeps showing the old forecast meanwhile. */
    async _load(force = false) {
        const {city, units} = this._wanted();
        if (!city) {
            this._data = null;
            this._state = 'empty';
            this._render();
            return;
        }
        const key = `${city}|${units}`;
        if (!force && this._data && this._key === key && !stale(this._fetchedAt, Date.now()))
            return;
        if (this._loading)
            return;
        this._loading = true;
        if (!this._data || this._key !== key) {
            this._data = null;
            this._state = 'loading';
            this._render();
        }
        try {
            this._http ??= createHttp();
            if (!this._place || this._placeCity !== city) {
                const found = await this._http.getText(geocodeUrl(city));
                if (this._destroyed)
                    return;
                const place = found.status === 200 ? parsePlace(JSON.parse(found.text)) : null;
                if (!place) {
                    this._state = found.status === 200 ? 'notfound' : 'error';
                    this._data = null;
                    return;
                }
                this._place = place;
                this._placeCity = city;
            }
            const answer = await this._http.getText(forecastUrl(this._place, units));
            if (this._destroyed)
                return;
            const data = answer.status === 200 ? parseForecast(JSON.parse(answer.text)) : null;
            if (!data)
                throw new Error(`the forecast answered ${answer.status}`);
            this._data = data;
            this._key = key;
            this._fetchedAt = Date.now();
            this._state = 'ok';
        } catch (e) {
            if (this._destroyed)
                return;
            console.warn(`Isle: weather: ${e.message}`);
            // An old forecast of this city stays; none, an error.
            this._state = this._data && this._key === key ? 'ok' : 'error';
        } finally {
            this._loading = false;
            if (!this._destroyed)
                this._render();
        }
        // The city changed while it was asking.
        const wanted = this._wanted();
        if (`${wanted.city}|${wanted.units}` !== key)
            this._load();
    }

    _render() {
        this._body.destroy_all_children();
        if (this._state !== 'ok' || !this._data) {
            this._renderMessage(...MESSAGES[this._state] ?? MESSAGES.error);
            return;
        }
        const units = unitsOf(this._wanted().units);
        const {now, days} = this._data;
        const {label: words, icon: iconName} = describeCode(now.code, now.isDay);

        const current = new St.BoxLayout({...VERTICAL, style_class: 'isle-weather-now', y_align: Clutter.ActorAlign.CENTER});
        const top = new St.BoxLayout({style_class: 'isle-weather-top', y_align: Clutter.ActorAlign.CENTER});
        top.add_child(new St.Icon({gicon: icon(iconName), icon_size: 36, style_class: 'isle-weather-icon'}));
        top.add_child(label(`${degrees(now.temp)}`, 'isle-weather-temp'));
        current.add_child(top);
        current.add_child(label(words, 'isle-weather-label'));
        const parts = [];
        if (now.feels !== null)
            parts.push(`Feels ${degrees(now.feels)}`);
        if (now.wind !== null)
            parts.push(`${now.wind} ${units.wind}`);
        if (now.humidity !== null)
            parts.push(`${now.humidity}%`);
        current.add_child(label(parts.join(' · '), 'isle-weather-detail'));
        const place = this._place ? [this._place.name, this._place.region].filter(Boolean).join(', ') : '';
        const placeLabel = label(place, 'isle-weather-place');
        placeLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        current.add_child(placeLabel);
        this._body.add_child(current);

        const row = new St.BoxLayout({style_class: 'isle-weather-days', x_expand: true, y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.END});
        for (const day of days.slice(0, DAYS)) {
            const column = new St.BoxLayout({...VERTICAL, style_class: 'isle-weather-day', x_align: Clutter.ActorAlign.CENTER});
            column.add_child(label(dayLabel(day.date, days[0].date), 'isle-weather-dayname', {x_align: Clutter.ActorAlign.CENTER}));
            column.add_child(new St.Icon({gicon: icon(describeCode(day.code, true).icon), icon_size: 18,
                style_class: 'isle-weather-icon', x_align: Clutter.ActorAlign.CENTER}));
            column.add_child(label(degrees(day.high), 'isle-weather-high', {x_align: Clutter.ActorAlign.CENTER}));
            column.add_child(label(degrees(day.low), 'isle-weather-low', {x_align: Clutter.ActorAlign.CENTER}));
            column.add_child(label(day.rain === null ? '' : `${day.rain}%`, 'isle-weather-rain', {x_align: Clutter.ActorAlign.CENTER}));
            row.add_child(column);
        }
        this._body.add_child(row);
    }

    _renderMessage(title, detail) {
        const box = new St.BoxLayout({...VERTICAL, style_class: 'isle-empty', x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        box.add_child(new St.Icon({gicon: icon('weather-clear-symbolic'), icon_size: 24, style_class: 'isle-weather-icon',
            x_align: Clutter.ActorAlign.CENTER}));
        box.add_child(label(title, 'isle-weather-label', {x_align: Clutter.ActorAlign.CENTER}));
        if (detail)
            box.add_child(label(detail, 'isle-weather-detail', {x_align: Clutter.ActorAlign.CENTER}));
        this._body.add_child(box);
    }
});
