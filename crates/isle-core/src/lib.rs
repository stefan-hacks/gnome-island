// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 stefan-hacks

//! Platform-independent core of Isle: no D-Bus, GTK or network, so every rule that decides
//! what the island shows can be unit tested in isolation.

pub mod app_usage;
pub mod battery;
pub mod calendar;
pub mod clipboard;
pub mod lrc;
pub mod pomodoro;
pub mod reminders;
pub mod shelf;
pub mod todo;
pub mod track;
