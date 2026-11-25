// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 stefan-hacks

// The System page: CPU, memory, network, storage, temperature, fan, voltage,
// battery and GPU sensors.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {VERTICAL, px} from '../compat.js';
import {Vitals} from '../vitals.js';
import {icon, label} from '../widgets.js';
import {Page} from './page.js';

/** Update interval while the page is active, in ms. */
const UPDATE_MS = 2000;

/** Thresholds for color-coding values. */
const THRESHOLDS = {
    cpu: {warn: 0.70, crit: 0.90},
    memory: {warn: 0.80, crit: 0.95},
    swap: {warn: 0.50, crit: 0.80},
    storage: {warn: 0.85, crit: 0.95},
    temp: {warn: 80, crit: 95},    // °C
    battery: {warn: 0.20, crit: 0.10},
    gpu: {warn: 0.80, crit: 0.95},
};

/** Returns a CSS class for a numeric value based on thresholds. */
function thresholdClass(value, {warn, crit}) {
    if (value >= crit)
        return 'isle-vitals-critical';
    if (value >= warn)
        return 'isle-vitals-warn';
    return 'isle-vitals-normal';
}

/** A row of the system page: icon, label, value, and an optional sub-value. */
function vitalsRow({iconName, title, subtitle = null, styleClass = ''}) {
    const row = new St.BoxLayout({style_class: `isle-vitals-row ${styleClass}`, x_expand: true});
    const glyph = new St.Icon({gicon: icon(iconName), icon_size: 16, y_align: Clutter.ActorAlign.CENTER, style_class: 'isle-vitals-icon'});
    row.add_child(glyph);

    const texts = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    texts.add_child(label(title, 'isle-vitals-title'));
    if (subtitle)
        texts.add_child(label(subtitle, 'isle-vitals-subtitle'));
    row.add_child(texts);

    const val = label('—', 'isle-vitals-value', {y_align: Clutter.ActorAlign.CENTER});
    row.add_child(val);
    return {actor: row, valueLabel: val};
}

export const SystemPage = GObject.registerClass(
class SystemPage extends Page {
    /** `height` is the expanded island's page height. */
    _init(daemon, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-system',
            layout_manager: new Clutter.BinLayout(),
            height,
            reactive: true,
        });
        this.name = 'system';
        this._vitals = new Vitals();
        this._rows = new Map();
        this._netRows = new Map();
        this._tempRows = new Map();
        this._fanRows = new Map();
        this._voltRows = new Map();

        const scroll = new St.ScrollView({
            style_class: 'isle-system-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
        });

        this._content = new St.BoxLayout({...VERTICAL, style_class: 'isle-system-content', x_expand: true});
        scroll.add_child(this._content);
        this.add_child(scroll);

        this._buildSections();
        this._vitals.connect('updated', () => this._onUpdate());
    }

    _buildSections() {
        // CPU
        this._cpuRow = vitalsRow({iconName: 'isle-processor-symbolic', title: 'CPU'});
        this._content.add_child(this._cpuRow.actor);

        // Memory
        this._memRow = vitalsRow({iconName: 'isle-memory-symbolic', title: 'Memory'});
        this._content.add_child(this._memRow.actor);

        // Swap
        this._swapRow = vitalsRow({iconName: 'drive-harddisk-symbolic', title: 'Swap'});
        this._content.add_child(this._swapRow.actor);

        // Load / Uptime
        this._loadRow = vitalsRow({iconName: 'system-run-symbolic', title: 'Load'});
        this._content.add_child(this._loadRow.actor);

        // Storage
        this._storageRow = vitalsRow({iconName: 'drive-harddisk-symbolic', title: 'Storage'});
        this._content.add_child(this._storageRow.actor);

        // Battery (if present)
        this._batteryRow = vitalsRow({iconName: 'battery-symbolic', title: 'Battery'});
        this._content.add_child(this._batteryRow.actor);

        // GPU (if present)
        this._gpuRow = vitalsRow({iconName: 'video-display-symbolic', title: 'GPU'});
        this._content.add_child(this._gpuRow.actor);

        // Network header
        this._netHeader = label('Network', 'isle-system-section');
        this._content.add_child(this._netHeader);
        this._netContainer = new St.BoxLayout({...VERTICAL, x_expand: true});
        this._content.add_child(this._netContainer);

        // Temperature header
        this._tempHeader = label('Temperature', 'isle-system-section');
        this._content.add_child(this._tempHeader);
        this._tempContainer = new St.BoxLayout({...VERTICAL, x_expand: true});
        this._content.add_child(this._tempContainer);

        // Fans header
        this._fanHeader = label('Fans', 'isle-system-section');
        this._content.add_child(this._fanHeader);
        this._fanContainer = new St.BoxLayout({...VERTICAL, x_expand: true});
        this._content.add_child(this._fanContainer);

        // Voltages header
        this._voltHeader = label('Voltage', 'isle-system-section');
        this._content.add_child(this._voltHeader);
        this._voltContainer = new St.BoxLayout({...VERTICAL, x_expand: true});
        this._content.add_child(this._voltContainer);
    }

    onActivate() {
        this._vitals.update();
        this._scheduleUpdate();
    }

    onDeactivate() {
        this.cancel('update');
    }

    _scheduleUpdate() {
        this._later('update', UPDATE_MS, () => {
            this._vitals.update();
            this._scheduleUpdate();
        });
    }

    _onUpdate() {
        const d = this._vitals.data;

        // CPU
        const cpuText = d.cpu.usage !== null
            ? `${this._vitals.formatCpuUsage()} · ${this._vitals.formatCpuFreq()}`
            : '—';
        this._cpuRow.valueLabel.text = cpuText;
        if (d.cpu.usage !== null)
            this._cpuRow.valueLabel.style_class = `isle-vitals-value ${thresholdClass(d.cpu.usage, THRESHOLDS.cpu)}`;
        // Per-core usage as subtitle
        const perCore = d.cpu.perCore;
        if (perCore.length > 0) {
            const coreText = perCore.map(c => `${Math.round(c.usage * 100)}%`).join('  ');
            // Update or create subtitle
            let sub = this._cpuRow.actor.get_children()[1]?.get_children()[1]; // texts box second child
            if (!sub || sub.style_class !== 'isle-vitals-subtitle') {
                const textsBox = this._cpuRow.actor.get_children()[1];
                if (textsBox && textsBox.get_children().length < 2) {
                    sub = label(coreText, 'isle-vitals-subtitle');
                    textsBox.add_child(sub);
                } else if (sub) {
                    sub.text = coreText;
                    sub.visible = true;
                }
            } else {
                sub.text = coreText;
                sub.visible = true;
            }
        } else {
            let sub = this._cpuRow.actor.get_children()[1]?.get_children()[1];
            if (sub)
                sub.visible = false;
        }

        // Memory
        const memText = d.memory.usage !== null
            ? `${this._vitals.formatMemoryUsage()} · ${this._vitals.formatMemoryUsed()} / ${this._vitals.formatMemoryTotal()}`
            : '—';
        this._memRow.valueLabel.text = memText;
        if (d.memory.usage !== null)
            this._memRow.valueLabel.style_class = `isle-vitals-value ${thresholdClass(d.memory.usage, THRESHOLDS.memory)}`;

        // Swap
        const swapText = d.memory.swapUsage !== null
            ? `${this._vitals.formatSwapUsage()} · ${formatBytes(d.memory.swapUsed)} / ${formatBytes(d.memory.swapTotal)}`
            : '—';
        this._swapRow.valueLabel.text = swapText;
        if (d.memory.swapUsage !== null)
            this._swapRow.valueLabel.style_class = `isle-vitals-value ${thresholdClass(d.memory.swapUsage, THRESHOLDS.swap)}`;

        // Load
        const loadText = d.system.load1 !== null
            ? `${this._vitals.formatLoad1()} · ${this._vitals.formatUptime()}`
            : '—';
        this._loadRow.valueLabel.text = loadText;

        // Storage
        const storageText = d.storage.usage !== null
            ? `${this._vitals.formatStorageUsage()} · ${this._vitals.formatStorageUsed()} / ${formatBytes(d.storage.total)}`
            : '—';
        this._storageRow.valueLabel.text = storageText;
        if (d.storage.usage !== null)
            this._storageRow.valueLabel.style_class = `isle-vitals-value ${thresholdClass(d.storage.usage, THRESHOLDS.storage)}`;

        // Battery
        const batteryText = this._vitals.formatBattery();
        this._batteryRow.valueLabel.text = batteryText;
        this._batteryRow.actor.visible = d.battery.percent !== null;
        if (d.battery.percent !== null) {
            const frac = d.battery.percent / 100;
            this._batteryRow.valueLabel.style_class = `isle-vitals-value ${thresholdClass(1 - frac, THRESHOLDS.battery)}`;
        }

        // GPU
        const gpuText = d.gpu.usage !== null
            ? `${this._vitals.formatGpuUsage()} · ${this._vitals.formatGpuTemp()} · ${this._vitals.formatGpuMemory()}`
            : '—';
        this._gpuRow.valueLabel.text = gpuText;
        this._gpuRow.actor.visible = d.gpu.usage !== null || d.gpu.temp !== null;
        if (d.gpu.usage !== null)
            this._gpuRow.valueLabel.style_class = `isle-vitals-value ${thresholdClass(d.gpu.usage, THRESHOLDS.gpu)}`;

        // Network
        const nets = this._vitals.networks;
        this._netHeader.visible = nets.length > 0;
        this._netContainer.visible = nets.length > 0;
        for (const [name, row] of this._netRows) {
            if (!nets.find(n => n.name === name)) {
                row.actor.destroy();
                this._netRows.delete(name);
            }
        }
        for (const net of nets) {
            const fmt = this._vitals.formatNetwork(net.name);
            let row = this._netRows.get(net.name);
            if (!row) {
                row = vitalsRow({iconName: 'isle-network-symbolic', title: net.name});
                this._netContainer.add_child(row.actor);
                this._netRows.set(net.name, row);
            }
            row.valueLabel.text = `↓ ${fmt.down}  ↑ ${fmt.up}`;
        }

        // Temperatures
        const temps = this._vitals.temps;
        this._tempHeader.visible = temps.length > 0;
        this._tempContainer.visible = temps.length > 0;
        for (const [name, row] of this._tempRows) {
            if (!temps.find(t => t.name === name)) {
                row.actor.destroy();
                this._tempRows.delete(name);
            }
        }
        for (const t of temps) {
            let row = this._tempRows.get(t.name);
            if (!row) {
                row = vitalsRow({iconName: 'isle-thermometer-symbolic', title: t.name});
                this._tempContainer.add_child(row.actor);
                this._tempRows.set(t.name, row);
            }
            row.valueLabel.text = formatTemp(t.value);
            const c = t.value / 1000;
            row.valueLabel.style_class = `isle-vitals-value ${thresholdClass(c, THRESHOLDS.temp)}`;
        }

        // Fans
        const fans = this._vitals.fans;
        this._fanHeader.visible = fans.length > 0;
        this._fanContainer.visible = fans.length > 0;
        for (const [name, row] of this._fanRows) {
            if (!fans.find(f => f.name === name)) {
                row.actor.destroy();
                this._fanRows.delete(name);
            }
        }
        for (const f of fans) {
            let row = this._fanRows.get(f.name);
            if (!row) {
                row = vitalsRow({iconName: 'isle-fan-symbolic', title: f.name});
                this._fanContainer.add_child(row.actor);
                this._fanRows.set(f.name, row);
            }
            row.valueLabel.text = `${f.value} RPM`;
        }

        // Voltages
        const volts = this._vitals.volts;
        this._voltHeader.visible = volts.length > 0;
        this._voltContainer.visible = volts.length > 0;
        for (const [name, row] of this._voltRows) {
            if (!volts.find(v => v.name === name)) {
                row.actor.destroy();
                this._voltRows.delete(name);
            }
        }
        for (const v of volts) {
            let row = this._voltRows.get(v.name);
            if (!row) {
                row = vitalsRow({iconName: 'isle-power-symbolic', title: v.name});
                this._voltContainer.add_child(row.actor);
                this._voltRows.set(v.name, row);
            }
            row.valueLabel.text = `${(v.value / 1000).toFixed(3)} V`;
        }

        this.emit('cold');
    }

    get available() {
        return true;
    }
});

/** Formats bytes as human-readable (e.g. "1.5 GiB"). */
function formatBytes(bytes, {decimals = 1} = {}) {
    if (!bytes || bytes === 0)
        return '0 B';
    const k = 1024;
    const sizes = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const idx = Math.min(i, sizes.length - 1);
    return `${(bytes / Math.pow(k, idx)).toFixed(decimals)} ${sizes[idx]}`;
}

/** Formats a temperature in millidegrees C. */
function formatTemp(millidegrees) {
    return `${Math.round(millidegrees / 1000)}°C`;
}