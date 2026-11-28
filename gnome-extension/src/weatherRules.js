// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 stefan-hacks

// The weather page's rules, with no shell imports: the web addresses asked (Open-Meteo, which needs no key), what
// the answers become, and the words and icons for the weather codes.

const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';

/** How many days the page shows, today first. */
export const DAYS = 5;

/** WMO weather codes: [label, icon by day, icon by night] (Adwaita's symbolic weather icons). */
const CODES = new Map([
    [0, ['Clear', 'weather-clear-symbolic', 'weather-clear-night-symbolic']],
    [1, ['Mainly clear', 'weather-clear-symbolic', 'weather-clear-night-symbolic']],
    [2, ['Partly cloudy', 'weather-few-clouds-symbolic', 'weather-few-clouds-night-symbolic']],
    [3, ['Overcast', 'weather-overcast-symbolic', 'weather-overcast-symbolic']],
    [45, ['Fog', 'weather-fog-symbolic', 'weather-fog-symbolic']],
    [48, ['Freezing fog', 'weather-fog-symbolic', 'weather-fog-symbolic']],
    [51, ['Light drizzle', 'weather-showers-scattered-symbolic', 'weather-showers-scattered-symbolic']],
    [53, ['Drizzle', 'weather-showers-scattered-symbolic', 'weather-showers-scattered-symbolic']],
    [55, ['Heavy drizzle', 'weather-showers-scattered-symbolic', 'weather-showers-scattered-symbolic']],
    [56, ['Freezing drizzle', 'weather-freezing-rain-symbolic', 'weather-freezing-rain-symbolic']],
    [57, ['Freezing drizzle', 'weather-freezing-rain-symbolic', 'weather-freezing-rain-symbolic']],
    [61, ['Light rain', 'weather-showers-symbolic', 'weather-showers-symbolic']],
    [63, ['Rain', 'weather-showers-symbolic', 'weather-showers-symbolic']],
    [65, ['Heavy rain', 'weather-showers-symbolic', 'weather-showers-symbolic']],
    [66, ['Freezing rain', 'weather-freezing-rain-symbolic', 'weather-freezing-rain-symbolic']],
    [67, ['Freezing rain', 'weather-freezing-rain-symbolic', 'weather-freezing-rain-symbolic']],
    [71, ['Light snow', 'weather-snow-symbolic', 'weather-snow-symbolic']],
    [73, ['Snow', 'weather-snow-symbolic', 'weather-snow-symbolic']],
    [75, ['Heavy snow', 'weather-snow-symbolic', 'weather-snow-symbolic']],
    [77, ['Snow grains', 'weather-snow-symbolic', 'weather-snow-symbolic']],
    [80, ['Light showers', 'weather-showers-scattered-symbolic', 'weather-showers-scattered-symbolic']],
    [81, ['Showers', 'weather-showers-symbolic', 'weather-showers-symbolic']],
    [82, ['Heavy showers', 'weather-showers-symbolic', 'weather-showers-symbolic']],
    [85, ['Snow showers', 'weather-snow-symbolic', 'weather-snow-symbolic']],
    [86, ['Heavy snow showers', 'weather-snow-symbolic', 'weather-snow-symbolic']],
    [95, ['Thunderstorm', 'weather-storm-symbolic', 'weather-storm-symbolic']],
    [96, ['Thunderstorm, hail', 'weather-storm-symbolic', 'weather-storm-symbolic']],
    [99, ['Thunderstorm, hail', 'weather-storm-symbolic', 'weather-storm-symbolic']],
]);

/** The words and icon for a weather code, by day or night; an unknown code is "Unknown" with the overcast icon. */
export function describeCode(code, isDay = true) {
    const [label, day, night] = CODES.get(code) ?? ['Unknown', 'weather-overcast-symbolic', 'weather-overcast-symbolic'];
    return {label, icon: isDay ? day : night};
}

/** The units' symbols: `metric` (°C, km/h) or `imperial` (°F, mph); anything else is metric. */
export function unitsOf(units) {
    return units === 'imperial' ? {temp: '°F', wind: 'mph', query: 'temperature_unit=fahrenheit&wind_speed_unit=mph'}
        : {temp: '°C', wind: 'km/h', query: 'temperature_unit=celsius&wind_speed_unit=kmh'};
}

/** The address that finds a city's coordinates; null for an empty name. */
export function geocodeUrl(city) {
    const name = (city ?? '').trim();
    if (!name)
        return null;
    return `${GEOCODE}?name=${encodeURIComponent(name)}&count=1&language=en&format=json`;
}

/** The place a geocoding answer names: {latitude, longitude, name, region}, or null when it found none. */
export function parsePlace(json) {
    const place = json?.results?.[0];
    if (!place || !Number.isFinite(place.latitude) || !Number.isFinite(place.longitude))
        return null;
    const region = [place.admin1, place.country].filter(part => part && part !== place.name).join(', ');
    return {latitude: place.latitude, longitude: place.longitude, name: place.name ?? '', region};
}

/** The address of the forecast for a place. */
export function forecastUrl({latitude, longitude}, units) {
    const current = 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m';
    const daily = 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max';
    return `${FORECAST}?latitude=${latitude}&longitude=${longitude}&current=${current}&daily=${daily}` +
        `&timezone=auto&forecast_days=${DAYS}&${unitsOf(units).query}`;
}

const whole = value => Number.isFinite(value) ? Math.round(value) : null;

/** A forecast answer as {now, days}, temperatures and winds to whole numbers; null when it has no current weather. */
export function parseForecast(json) {
    const current = json?.current;
    if (!current || !Number.isFinite(current.temperature_2m))
        return null;
    const daily = json.daily ?? {};
    const days = (daily.time ?? []).slice(0, DAYS).map((date, i) => ({
        date,
        code: daily.weather_code?.[i],
        high: whole(daily.temperature_2m_max?.[i]),
        low: whole(daily.temperature_2m_min?.[i]),
        rain: whole(daily.precipitation_probability_max?.[i]),
    }));
    return {
        now: {
            temp: whole(current.temperature_2m),
            feels: whole(current.apparent_temperature),
            humidity: whole(current.relative_humidity_2m),
            wind: whole(current.wind_speed_10m),
            code: current.weather_code,
            isDay: current.is_day !== 0,
        },
        days,
    };
}

/** "Today", else the weekday's short name, for a `YYYY-MM-DD` date; `today` is the page's own day, from the
 * forecast's first one. */
export function dayLabel(date, today, locale = 'en-GB') {
    if (date === today)
        return 'Today';
    const [y, m, d] = date.split('-').map(Number);
    if (!y || !m || !d)
        return date;
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(locale, {weekday: 'short', timeZone: 'UTC'});
}

/** A temperature as the page writes it: "12°", or "–" when unknown. */
export function degrees(value) {
    return value === null || value === undefined ? '–' : `${value}°`;
}

/** Whether a forecast is too old to show without asking again. */
export function stale(fetchedAt, now, maxAgeMs = 10 * 60 * 1000) {
    return !fetchedAt || now - fetchedAt > maxAgeMs;
}
