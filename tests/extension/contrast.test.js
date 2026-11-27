import test from 'node:test';
import assert from 'node:assert/strict';
import {contrast, legibleOn, luminance} from '../../gnome-extension/src/contrast.js';

const DARK = [0.118, 0.118, 0.118];
const LIGHT = [0.965, 0.965, 0.965];
// libadwaita's accent_bg_color for each accent GNOME offers.
const ACCENTS = ['3584e4', '2190a4', '3a944a', 'c88800', 'ed5b00', 'e62d2d', 'd56199', '9141ac', '6f8396']
    .map(hex => [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255));

test('black and white are 21:1', () => {
    assert.ok(Math.abs(contrast([0, 0, 0], [1, 1, 1]) - 21) < 0.01);
    assert.equal(luminance([0, 0, 0]), 0);
});

test('every GNOME accent is legible as text on the dark and the light island', () => {
    for (const accent of ACCENTS) {
        assert.ok(contrast(legibleOn(accent, DARK), DARK) >= 4.5);
        assert.ok(contrast(legibleOn(accent, LIGHT), LIGHT) >= 4.5);
    }
});

test('an accent that already reads is left as it is', () => {
    assert.deepEqual(legibleOn([1, 1, 1], DARK), [1, 1, 1]);
});
