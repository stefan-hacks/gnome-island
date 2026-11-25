// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 stefan-hacks

// The island's look, as Settings offers it and theme.js draws it.

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

import * as Theme from '../../gnome-extension/src/theme.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../gnome-extension');

test('the schema offers GNOME by default', () => {
    const schema = readFileSync(resolve(root, 'schemas/org.gnome.shell.extensions.isle.gschema.xml'), 'utf8');
    const key = schema.match(/<key name="island-theme"[\s\S]*?<\/key>/)[0];
    assert.deepEqual([...key.matchAll(/<choice value="([^"]+)"\/>/g)].map(m => m[1]), ['gnome']);
    assert.match(key, /<default>'gnome'<\/default>/);
});

test('gnome is GNOME dark grey; any name it does not know falls back to gnome', () => {
    Theme.setTheme('gnome');
    assert.equal(Theme.translucent(), false);
    assert.equal(Theme.blur(), null);
    assert.deepEqual(Theme.fill(), [0.118, 0.118, 0.118, 1]);
    for (const name of ['', 'glass', 'black', 'unknown']) {
        Theme.setTheme(name);
        assert.equal(Theme.translucent(), false);
        assert.equal(Theme.blur(), null);
        assert.deepEqual(Theme.fill(), [0.118, 0.118, 0.118, 1]);
    }
});

test('gnome theme switches between dark and light with setGnomeScheme', () => {
    Theme.setTheme('gnome');
    Theme.setGnomeScheme('prefer-dark');
    assert.deepEqual(Theme.fill(), [0.118, 0.118, 0.118, 1]);
    assert.deepEqual(Theme.solid(), [0.118, 0.118, 0.118]);
    assert.equal(Theme.gnomeDark(), true);

    Theme.setGnomeScheme('default');
    assert.deepEqual(Theme.fill(), [0.965, 0.965, 0.965, 1]);
    assert.deepEqual(Theme.solid(), [0.965, 0.965, 0.965]);
    assert.equal(Theme.gnomeDark(), false);

    Theme.setGnomeScheme('prefer-light');
    assert.deepEqual(Theme.fill(), [0.965, 0.965, 0.965, 1]);
    assert.equal(Theme.gnomeDark(), false);
});
