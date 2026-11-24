// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 stefan-hacks

// System vitals: CPU, memory, load, network, storage and temperature sensors.
// Reads from /proc and /sys; no dependencies beyond GLib/Gio.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

/** Reads a UTF-8 text file, returning its content or null. */
function readFile(path) {
    try {
        const [, bytes] = Gio.File.new_for_path(path).load_contents(null);
        return new TextDecoder().decode(bytes);
    } catch {
        return null;
    }
}

/** Reads a numeric value from a sysfs path, returning null on failure. */
function readNumber(path) {
    const text = readFile(path);
    if (text === null)
        return null;
    const n = parseInt(text.trim(), 10);
    return isNaN(n) ? null : n;
}

/** Splits text by newlines, filtering empty lines. */
function lines(text) {
    return text.split('\n').filter(line => line.trim());
}

/** Formats bytes as human-readable (e.g. "1.5 GiB"). */
function formatBytes(bytes, {si = false, decimals = 1} = {}) {
    if (bytes === 0 || bytes === null)
        return '0 B';
    const k = si ? 1000 : 1024;
    const sizes = si
        ? ['B', 'KB', 'MB', 'GB', 'TB']
        : ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const idx = Math.min(i, sizes.length - 1);
    return `${(bytes / Math.pow(k, idx)).toFixed(decimals)} ${sizes[idx]}`;
}

/** Formats a speed in bytes/s. */
function formatSpeed(bytesPerSec, {si = false, decimals = 1} = {}) {
    return `${formatBytes(bytesPerSec, {si, decimals})}/s`;
}

/** Formats a temperature in °C. */
function formatTemp(millidegrees, unit = 'celsius') {
    const c = millidegrees / 1000;
    if (unit === 'fahrenheit')
        return `${Math.round((c * 9 / 5) + 32)}°F`;
    return `${Math.round(c)}°C`;
}

/** Formats a percentage. */
function formatPercent(value, decimals = 0) {
    const pct = value * 100;
    if (decimals === 0)
        return `${Math.round(pct)}%`;
    return `${pct.toFixed(decimals)}%`;
}

/** Formats frequency in Hz → GHz/MHz. */
function formatFreq(hz) {
    if (hz >= 1e9)
        return `${(hz / 1e9).toFixed(2)} GHz`;
    if (hz >= 1e6)
        return `${(hz / 1e6).toFixed(0)} MHz`;
    return `${hz} Hz`;
}

export const Vitals = GObject.registerClass({
    GTypeName: 'Vitals',
    Signals: {
        'updated': {},
    },
}, class Vitals extends GObject.Object {
    _init() {
        super._init();
        this._data = {
            cpu: {usage: null, freq: null, freqMax: null, freqMin: null, cores: 0, perCore: []},
            memory: {usage: null, total: null, avail: null, used: null, swapTotal: null, swapUsed: null, swapUsage: null},
            system: {load1: null, load5: null, load15: null, uptime: null},
            network: [],
            storage: {total: null, used: null, usage: null, path: null},
            temps: [],
            fans: [],
            volts: [],
            battery: {percent: null, charging: null, time: null},
            gpu: {usage: null, temp: null, memory: null},
        };
        this._lastNet = new Map();
        this._lastCpuStat = null;
        this._coreCount = 0;
        this._networkIfaces = [];
        this._tempPaths = [];
        this._fanPaths = [];
        this._voltPaths = [];
        this._gpuType = null;
        this._discoverHardware();
    }

    // ── Discovery (run once) ──

    _discoverHardware() {
        // CPU cores
        try {
            const cpuinfo = readFile('/proc/cpuinfo');
            if (cpuinfo)
                this._coreCount = (cpuinfo.match(/^processor\s*:/gm) || []).length;
        } catch {}
        if (this._coreCount === 0)
            this._coreCount = 1;

        // Network interfaces (exclude loopback and virtual)
        const netDir = Gio.File.new_for_path('/sys/class/net');
        try {
            const iter = netDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            while (true) {
                const info = iter.next_file(null);
                if (!info)
                    break;
                const name = info.get_name();
                if (name === 'lo')
                    continue;
                // Skip virtual/tunnel interfaces
                const typePath = `/sys/class/net/${name}/type`;
                const type = readNumber(typePath);
                if (type !== 1) // ARPHRD_ETHER
                    continue;
                this._networkIfaces.push(name);
            }
        } catch {}

        // Temperature sensors: thermal zones
        const thermalDir = Gio.File.new_for_path('/sys/class/thermal');
        try {
            const iter = thermalDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            while (true) {
                const info = iter.next_file(null);
                if (!info)
                    break;
                const name = info.get_name();
                if (!name.startsWith('thermal_zone'))
                    continue;
                const typePath = `/sys/class/thermal/${name}/type`;
                const tempPath = `/sys/class/thermal/${name}/temp`;
                const type = readFile(typePath)?.trim() ?? name;
                this._tempPaths.push({name: type, path: tempPath});
            }
        } catch {}

        // Temperature sensors: hwmon (also fans and voltages)
        const hwmonDir = Gio.File.new_for_path('/sys/class/hwmon');
        try {
            const iter = hwmonDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            while (true) {
                const info = iter.next_file(null);
                if (!info)
                    break;
                const hwmon = info.get_name();
                const base = `/sys/class/hwmon/${hwmon}`;
                const nameFile = readFile(`${base}/name`)?.trim();
                if (!nameFile)
                    continue;
                const hdir = Gio.File.new_for_path(base);
                try {
                    const hiter = hdir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
                    while (true) {
                        const hinfo = hiter.next_file(null);
                        if (!hinfo)
                            break;
                        const fname = hinfo.get_name();

                        // Temperatures
                        const tm = fname.match(/^temp(\d+)_input$/);
                        if (tm) {
                            const label = readFile(`${base}/temp${tm[1]}_label`)?.trim();
                            const sensorName = label || `${nameFile} ${tm[1]}`;
                            this._tempPaths.push({name: sensorName, path: `${base}/${fname}`});
                        }

                        // Fans
                        const fm = fname.match(/^fan(\d+)_input$/);
                        if (fm) {
                            const label = readFile(`${base}/fan${fm[1]}_label`)?.trim();
                            const sensorName = label || `Fan ${fm[1]}`;
                            this._fanPaths.push({name: sensorName, path: `${base}/${fname}`});
                        }

                        // Voltages
                        const vm = fname.match(/^in(\d+)_input$/);
                        if (vm) {
                            const label = readFile(`${base}/in${vm[1]}_label`)?.trim();
                            const sensorName = label || `Voltage ${vm[1]}`;
                            this._voltPaths.push({name: sensorName, path: `${base}/${fname}`});
                        }
                    }
                } catch {}
            }
        } catch {}

        // GPU detection
        this._discoverGpu();

        // Storage: find root filesystem device
        this._storageDevice = null;
        try {
            const mounts = readFile('/proc/mounts');
            if (mounts) {
                for (const line of lines(mounts)) {
                    const parts = line.split(/\s+/);
                    if (parts.length >= 2 && parts[1] === '/') {
                        this._storageDevice = parts[0];
                        break;
                    }
                }
            }
        } catch {}
    }

    _discoverGpu() {
        // Try nvidia-smi first
        try {
            const [ok, , stderr] = GLib.spawn_sync(null, ['nvidia-smi', '-L'], null, GLib.SpawnFlags.SEARCH_PATH, null);
            if (ok && (!stderr || stderr.length === 0)) {
                this._gpuType = 'nvidia';
                return;
            }
        } catch {}

        // Try amdgpu
        const driDir = Gio.File.new_for_path('/sys/class/drm');
        try {
            const iter = driDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            while (true) {
                const info = iter.next_file(null);
                if (!info)
                    break;
                const card = info.get_name();
                if (card.startsWith('card') && !card.includes('-')) {
                    const devicePath = `/sys/class/drm/${card}/device`;
                    const vendor = readFile(`${devicePath}/vendor`)?.trim();
                    if (vendor === '0x1002') { // AMD
                        this._gpuType = 'amdgpu';
                        this._gpuDevice = devicePath;
                        return;
                    }
                }
            }
        } catch {}
    }

    // ── Update ──

    update() {
        this._readCpu();
        this._readMemory();
        this._readSystem();
        this._readNetwork();
        this._readStorage();
        this._readTemps();
        this._readFans();
        this._readVolts();
        this._readBattery();
        this._readGpu();
        this.emit('updated');
    }

    _readCpu() {
        const stat = readFile('/proc/stat');
        if (!stat)
            return;

        const cpuLine = lines(stat).find(line => line.startsWith('cpu '));
        if (!cpuLine)
            return;

        const parts = cpuLine.trim().split(/\s+/).slice(1).map(Number);
        if (parts.length < 4)
            return;

        const user = parts[0], nice = parts[1], system = parts[2], idle = parts[3];
        const iowait = parts[4] || 0, irq = parts[5] || 0, softirq = parts[6] || 0;
        const total = user + nice + system + irq + softirq + iowait;
        const totalAll = total + idle;

        if (this._lastCpuStat) {
            const dTotal = totalAll - this._lastCpuStat.total;
            const dIdle = idle - this._lastCpuStat.idle;
            if (dTotal > 0)
                this._data.cpu.usage = (dTotal - dIdle) / dTotal;
        }

        this._lastCpuStat = {total: totalAll, idle};

        // Per-core usage
        const coreStats = [];
        for (let c = 0; c < this._coreCount; c++) {
            const coreLine = lines(stat).find(line => line.startsWith(`cpu${c} `));
            if (!coreLine)
                continue;
            const cp = coreLine.trim().split(/\s+/).slice(1).map(Number);
            const cUser = cp[0], cNice = cp[1], cSys = cp[2], cIdle = cp[3];
            const cIowait = cp[4] || 0, cIrq = cp[5] || 0, cSoftirq = cp[6] || 0;
            const cTotal = cUser + cNice + cSys + cIrq + cSoftirq + cIowait;
            const cTotalAll = cTotal + cIdle;

            const last = this._lastCoreStats?.[c];
            let usage = null;
            if (last) {
                const dcTotal = cTotalAll - last.total;
                const dcIdle = cIdle - last.idle;
                if (dcTotal > 0)
                    usage = (dcTotal - dcIdle) / dcTotal;
            }
            coreStats.push({total: cTotalAll, idle: cIdle, usage});
        }
        this._lastCoreStats = coreStats;
        this._data.cpu.perCore = coreStats.map((s, i) => ({core: i, usage: s.usage})).filter(s => s.usage !== null);

        // Frequency: try cpufreq first, then cpuinfo
        let freqs = [];
        for (let c = 0; c < this._coreCount; c++) {
            const khz = readNumber(`/sys/devices/system/cpu/cpu${c}/cpufreq/scaling_cur_freq`);
            if (khz !== null) {
                freqs.push(khz * 1000);
            }
        }
        if (freqs.length === 0) {
            const cpuinfo = readFile('/proc/cpuinfo');
            if (cpuinfo) {
                for (const line of lines(cpuinfo)) {
                    const m = line.match(/^cpu MHz\s*:\s*([\d.]+)/);
                    if (m)
                        freqs.push(parseFloat(m[1]) * 1e6);
                }
            }
        }
        if (freqs.length > 0) {
            this._data.cpu.freq = freqs.reduce((a, b) => a + b, 0) / freqs.length;
            this._data.cpu.freqMax = Math.max(...freqs);
            this._data.cpu.freqMin = Math.min(...freqs);
        }
        this._data.cpu.cores = this._coreCount;
    }

    _readMemory() {
        const meminfo = readFile('/proc/meminfo');
        if (!meminfo)
            return;

        const parse = key => {
            const m = meminfo.match(new RegExp(`^${key}:\\s*(\\d+)`, 'm'));
            return m ? parseInt(m[1], 10) * 1024 : 0;
        };

        const total = parse('MemTotal');
        const avail = parse('MemAvailable') || parse('MemFree');
        const cached = parse('Cached');
        const free = parse('MemFree');
        const swapTotal = parse('SwapTotal');
        const swapFree = parse('SwapFree');
        const used = total - avail;

        this._data.memory.total = total;
        this._data.memory.avail = avail;
        this._data.memory.used = used;
        this._data.memory.cached = cached;
        this._data.memory.free = free;
        this._data.memory.usage = total > 0 ? used / total : 0;
        this._data.memory.swapTotal = swapTotal;
        this._data.memory.swapUsed = swapTotal - swapFree;
        this._data.memory.swapUsage = swapTotal > 0 ? (swapTotal - swapFree) / swapTotal : 0;
    }

    _readSystem() {
        const loadavg = readFile('/proc/loadavg');
        if (loadavg) {
            const parts = loadavg.trim().split(/\s+/);
            this._data.system.load1 = parseFloat(parts[0]) || null;
            this._data.system.load5 = parseFloat(parts[1]) || null;
            this._data.system.load15 = parseFloat(parts[2]) || null;
        }

        const uptime = readFile('/proc/uptime');
        if (uptime) {
            const secs = parseFloat(uptime.split(/\s+/)[0]);
            if (!isNaN(secs))
                this._data.system.uptime = secs;
        }
    }

    _readNetwork() {
        const now = GLib.get_monotonic_time() / 1e6;
        const results = [];

        for (const iface of this._networkIfaces) {
            const rxPath = `/sys/class/net/${iface}/statistics/rx_bytes`;
            const txPath = `/sys/class/net/${iface}/statistics/tx_bytes`;
            const rx = readNumber(rxPath);
            const tx = readNumber(txPath);

            if (rx === null || tx === null)
                continue;

            const key = iface;
            const last = this._lastNet.get(key);
            let down = 0, up = 0;

            if (last) {
                const dt = now - last.time;
                if (dt > 0) {
                    const drx = rx - last.rx;
                    const dtx = tx - last.tx;
                    if (drx >= 0)
                        down = Math.round(drx / dt);
                    if (dtx >= 0)
                        up = Math.round(dtx / dt);
                }
            }

            this._lastNet.set(key, {time: now, rx, tx});
            results.push({name: iface, up, down});
        }

        this._data.network = results;
    }

    _readStorage() {
        if (!this._storageDevice)
            return;

        try {
            const file = Gio.File.new_for_path('/');
            const info = file.query_filesystem_info(Gio.FILE_ATTRIBUTE_FILESYSTEM_SIZE + ',' +
                Gio.FILE_ATTRIBUTE_FILESYSTEM_FREE, null);
            if (!info)
                return;

            const total = info.get_attribute_as_string(Gio.FILE_ATTRIBUTE_FILESYSTEM_SIZE);
            const free = info.get_attribute_as_string(Gio.FILE_ATTRIBUTE_FILESYSTEM_FREE);
            const totalBytes = total ? parseInt(total, 10) : 0;
            const freeBytes = free ? parseInt(free, 10) : 0;
            const usedBytes = totalBytes - freeBytes;

            this._data.storage.total = totalBytes;
            this._data.storage.used = usedBytes;
            this._data.storage.usage = totalBytes > 0 ? usedBytes / totalBytes : 0;
            this._data.storage.path = this._storageDevice;
        } catch {}
    }

    _readTemps() {
        const results = [];
        for (const sensor of this._tempPaths) {
            const val = readNumber(sensor.path);
            if (val !== null)
                results.push({name: sensor.name, value: val});
        }
        this._data.temps = results;
    }

    _readFans() {
        const results = [];
        for (const sensor of this._fanPaths) {
            const val = readNumber(sensor.path);
            if (val !== null)
                results.push({name: sensor.name, value: val});
        }
        this._data.fans = results;
    }

    _readVolts() {
        const results = [];
        for (const sensor of this._voltPaths) {
            const val = readNumber(sensor.path);
            if (val !== null)
                results.push({name: sensor.name, value: val});
        }
        this._data.volts = results;
    }

    _readBattery() {
        const batDir = Gio.File.new_for_path('/sys/class/power_supply');
        try {
            const iter = batDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            while (true) {
                const info = iter.next_file(null);
                if (!info)
                    break;
                const name = info.get_name();
                const typePath = `/sys/class/power_supply/${name}/type`;
                const type = readFile(typePath)?.trim();
                if (type !== 'Battery')
                    continue;
                const capacity = readNumber(`/sys/class/power_supply/${name}/capacity`);
                const status = readFile(`/sys/class/power_supply/${name}/status`)?.trim();
                const timeToEmpty = readNumber(`/sys/class/power_supply/${name}/time_to_empty_now`);
                const timeToFull = readNumber(`/sys/class/power_supply/${name}/time_to_full_now`);

                this._data.battery.percent = capacity;
                this._data.battery.charging = status === 'Charging';
                this._data.battery.time = this._data.battery.charging ? timeToFull : timeToEmpty;
                return;
            }
        } catch {}
        this._data.battery = {percent: null, charging: null, time: null};
    }

    _readGpu() {
        if (this._gpuType === 'nvidia') {
            try {
                const [ok, stdout] = GLib.spawn_sync(null,
                    ['nvidia-smi', '--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total',
                        '--format=csv,noheader,nounits'],
                    null, GLib.SpawnFlags.SEARCH_PATH, null);
                if (!ok)
                    return;
                const out = typeof stdout === 'string' ? stdout : new TextDecoder().decode(stdout);
                const parts = out.trim().split(',').map(s => s.trim());
                if (parts.length >= 4) {
                    this._data.gpu.usage = parseInt(parts[0], 10) / 100;
                    this._data.gpu.temp = parseInt(parts[1], 10) * 1000; // store as millidegrees
                    this._data.gpu.memory = {
                        used: parseInt(parts[2], 10) * 1024 * 1024,
                        total: parseInt(parts[3], 10) * 1024 * 1024,
                    };
                }
            } catch {}
        } else if (this._gpuType === 'amdgpu' && this._gpuDevice) {
            const devicePath = this._gpuDevice;
            const usage = readNumber(`${devicePath}/gpu_busy_percent`);
            const memUsed = readNumber(`${devicePath}/mem_info_vram_used`);
            const memTotal = readNumber(`${devicePath}/mem_info_vram_total`);
            if (usage !== null)
                this._data.gpu.usage = usage / 100;
            if (memUsed !== null && memTotal !== null)
                this._data.gpu.memory = {used: memUsed, total: memTotal};
            // Temperature from hwmon
            const hwmonDir = `${devicePath}/hwmon`;
            try {
                const dir = Gio.File.new_for_path(hwmonDir);
                const iter = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
                while (true) {
                    const info = iter.next_file(null);
                    if (!info)
                        break;
                    const hwmon = info.get_name();
                    const temp = readNumber(`${hwmonDir}/${hwmon}/temp1_input`);
                    if (temp !== null) {
                        this._data.gpu.temp = temp;
                        break;
                    }
                }
            } catch {}
        }
    }

    // ── Accessors ──

    get data() {
        return this._data;
    }

    // ── Formatters ──

    formatCpuUsage() {
        return this._data.cpu.usage !== null ? formatPercent(this._data.cpu.usage, 0) : '—';
    }

    formatCpuFreq() {
        return this._data.cpu.freq !== null ? formatFreq(this._data.cpu.freq) : '—';
    }

    formatMemoryUsage() {
        return this._data.memory.usage !== null ? formatPercent(this._data.memory.usage, 0) : '—';
    }

    formatMemoryUsed() {
        return this._data.memory.used !== null ? formatBytes(this._data.memory.used, {decimals: 1}) : '—';
    }

    formatMemoryTotal() {
        return this._data.memory.total !== null ? formatBytes(this._data.memory.total, {decimals: 0}) : '—';
    }

    formatSwapUsage() {
        return this._data.memory.swapUsage !== null ? formatPercent(this._data.memory.swapUsage, 0) : '—';
    }

    formatLoad1() {
        return this._data.system.load1 !== null ? this._data.system.load1.toFixed(2) : '—';
    }

    formatUptime() {
        if (this._data.system.uptime === null)
            return '—';
        const s = Math.floor(this._data.system.uptime);
        const d = Math.floor(s / 86400);
        const h = Math.floor((s % 86400) / 3600);
        const m = Math.floor((s % 3600) / 60);
        if (d > 0)
            return `${d}d ${h}h ${m}m`;
        if (h > 0)
            return `${h}h ${m}m`;
        return `${m}m`;
    }

    formatStorageUsage() {
        return this._data.storage.usage !== null ? formatPercent(this._data.storage.usage, 0) : '—';
    }

    formatStorageUsed() {
        return this._data.storage.used !== null ? formatBytes(this._data.storage.used, {decimals: 1}) : '—';
    }

    formatNetwork(iface) {
        const net = this._data.network.find(n => n.name === iface);
        if (!net)
            return {up: '—', down: '—'};
        return {
            up: net.up > 0 ? formatSpeed(net.up) : '0 B/s',
            down: net.down > 0 ? formatSpeed(net.down) : '0 B/s',
        };
    }

    formatTemp(index = 0) {
        const t = this._data.temps[index];
        return t ? formatTemp(t.value) : '—';
    }

    get temps() {
        return this._data.temps;
    }

    get networks() {
        return this._data.network;
    }

    get fans() {
        return this._data.fans;
    }

    get volts() {
        return this._data.volts;
    }

    get battery() {
        return this._data.battery;
    }

    get gpu() {
        return this._data.gpu;
    }

    formatFan(index = 0) {
        const f = this._data.fans[index];
        return f ? `${f.value} RPM` : '—';
    }

    formatVolt(index = 0) {
        const v = this._data.volts[index];
        return v ? `${(v / 1000).toFixed(3)} V` : '—';
    }

    formatBattery() {
        const b = this._data.battery;
        if (b.percent === null)
            return '—';
        let text = `${b.percent}%`;
        if (b.charging !== null)
            text += b.charging ? ' ↑' : ' ↓';
        return text;
    }

    formatGpuUsage() {
        return this._data.gpu.usage !== null ? formatPercent(this._data.gpu.usage, 0) : '—';
    }

    formatGpuTemp() {
        return this._data.gpu.temp !== null ? formatTemp(this._data.gpu.temp) : '—';
    }

    formatGpuMemory() {
        const mem = this._data.gpu.memory;
        if (!mem || mem.total === null)
            return '—';
        return `${formatBytes(mem.used, {decimals: 0})} / ${formatBytes(mem.total, {decimals: 0})}`;
    }
});