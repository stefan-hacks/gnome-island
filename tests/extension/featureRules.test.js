import test from 'node:test';
import assert from 'node:assert/strict';
import {DAYS, dayLabel, degrees, describeCode, forecastUrl, geocodeUrl, parseForecast, parsePlace, stale, unitsOf}
    from '../../gnome-extension/src/weatherRules.js';
import {byName, fromFraction, isAppStream, percentText, toFraction} from '../../gnome-extension/src/mixerRules.js';
import {describeSpace, formatSize, isMountable, isRemovable} from '../../gnome-extension/src/driveRules.js';

test('weather codes have words and a day or night icon, and an unknown code still draws', () => {
    assert.deepEqual(describeCode(0, true), {label: 'Clear', icon: 'weather-clear-symbolic'});
    assert.equal(describeCode(0, false).icon, 'weather-clear-night-symbolic');
    assert.equal(describeCode(63).label, 'Rain');
    assert.equal(describeCode(12345).label, 'Unknown');
});

test('units are metric unless imperial is asked for', () => {
    assert.equal(unitsOf('imperial').temp, '°F');
    assert.equal(unitsOf('anything').temp, '°C');
    assert.match(forecastUrl({latitude: 52.1, longitude: -0.5}, 'imperial'), /temperature_unit=fahrenheit/);
    assert.match(forecastUrl({latitude: 52.1, longitude: -0.5}, 'metric'), /forecast_days=5/);
});

test('a city becomes a geocoding address, and an empty one none', () => {
    assert.equal(geocodeUrl('  '), null);
    assert.match(geocodeUrl('Kempston, Bedford'), /name=Kempston%2C%20Bedford/);
});

test('a place is read from the answer, or null when there is none', () => {
    assert.equal(parsePlace({}), null);
    assert.equal(parsePlace({results: [{name: 'X'}]}), null);
    assert.deepEqual(parsePlace({results: [{name: 'Bedford', latitude: 52.1, longitude: -0.46, admin1: 'England',
        country: 'United Kingdom'}]}), {latitude: 52.1, longitude: -0.46, name: 'Bedford', region: 'England, United Kingdom'});
});

test('a forecast is rounded, and one without current weather is null', () => {
    assert.equal(parseForecast({}), null);
    const forecast = parseForecast({
        current: {temperature_2m: 11.6, apparent_temperature: 9.4, relative_humidity_2m: 81, wind_speed_10m: 14.2,
            weather_code: 61, is_day: 0},
        daily: {time: ['2026-11-28', '2026-11-29'], weather_code: [61, 3], temperature_2m_max: [12.4, 10.5],
            temperature_2m_min: [6.2, 4.9], precipitation_probability_max: [70, null]},
    });
    assert.deepEqual(forecast.now, {temp: 12, feels: 9, humidity: 81, wind: 14, code: 61, isDay: false});
    assert.equal(forecast.days.length, 2);
    assert.deepEqual(forecast.days[1], {date: '2026-11-29', code: 3, high: 11, low: 5, rain: null});
    assert.ok(DAYS >= 2);
});

test('days are named, today first', () => {
    assert.equal(dayLabel('2026-11-28', '2026-11-28'), 'Today');
    assert.equal(dayLabel('2026-11-29', '2026-11-28'), 'Sun');
    assert.equal(dayLabel('garbage', '2026-11-28'), 'garbage');
    assert.equal(degrees(12), '12°');
    assert.equal(degrees(null), '–');
});

test('a forecast goes stale after ten minutes', () => {
    assert.equal(stale(0, 1000), true);
    assert.equal(stale(1000, 1000 + 5 * 60 * 1000), false);
    assert.equal(stale(1000, 1000 + 11 * 60 * 1000), true);
});

test('volumes are fractions of the mixer\'s 100%, clamped', () => {
    assert.equal(toFraction(32768, 65536), 0.5);
    assert.equal(toFraction(100000, 65536), 1);
    assert.equal(toFraction(100000, 65536, 1.5), 1.5);
    assert.equal(toFraction(5, 0), 0);
    assert.equal(fromFraction(0.5, 65536), 32768);
    assert.equal(fromFraction(2, 100), 100);
    assert.equal(percentText(0.634), '63%');
});

test('only apps playing sound are listed, in name order', () => {
    assert.equal(isAppStream({name: 'Firefox', appId: 'firefox'}), true);
    assert.equal(isAppStream({name: ' ', appId: 'x'}), false);
    assert.equal(isAppStream({name: 'Sound', appId: 'org.gnome.VolumeControl'}), false);
    assert.equal(isAppStream({name: 'Bell', isEvent: true}), false);
    const sorted = [{name: 'b', id: 2}, {name: 'a', id: 9}, {name: 'b', id: 1}].sort(byName);
    assert.deepEqual(sorted.map(s => `${s.name}${s.id}`), ['a9', 'b1', 'b2']);
});

test('removable media is listed, the computer\'s own disks and shares are not', () => {
    assert.equal(isRemovable({hasDrive: true, driveRemovable: true}), true);
    assert.equal(isRemovable({hasDrive: true, canEject: true}), true);
    assert.equal(isRemovable({hasDrive: true, driveRemovable: false}), false);
    assert.equal(isRemovable({hasDrive: false, driveRemovable: true}), false);
    assert.equal(isRemovable({hasDrive: true, driveRemovable: true, shadowed: true}), false);
    assert.equal(isMountable({hasMount: false, hasDrive: true, driveRemovable: true, canMount: true}), true);
    assert.equal(isMountable({hasMount: true, hasDrive: true, driveRemovable: true, canMount: true}), false);
});

test('sizes and space are written as Files does', () => {
    assert.equal(formatSize(0), '0 B');
    assert.equal(formatSize(32_000_000_000), '32.0 GB');
    assert.equal(formatSize(256_000_000_000), '256 GB');
    assert.equal(formatSize(-1), '');
    assert.deepEqual(describeSpace(32_000_000_000, 8_000_000_000), {text: '8.0 GB free of 32.0 GB', used: 0.75});
    assert.equal(describeSpace(0, 0), null);
    assert.equal(describeSpace(NaN, 1), null);
});
