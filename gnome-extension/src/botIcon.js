// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 stefan-hacks
// Bot/AI features removed in this fork.

import St from 'gi://St';
import GObject from 'gi://GObject';

export const BotIcon = GObject.registerClass(
class BotIcon extends St.Widget {
    _init(size) {
        super._init({width: size, height: size});
    }
    set look(v) {}
    set form(v) {}
    set badge(v) {}
    play(v) {}
    resize(art, bot) {}
});
