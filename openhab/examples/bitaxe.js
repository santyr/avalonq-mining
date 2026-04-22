/*
 * Example openHAB JS Scripting rule set for a Bitaxe Gamma (BM1370, AxeOS).
 *
 * The Bitaxe exposes plain HTTP on port 80 with no authentication. It is the
 * fine-grain dump load complement to the coarse Avalon Q. See:
 *   docs/bitaxe-integration-plan.md
 *
 * This script is designed for the Items in:
 *   openhab/examples/bitaxe.items
 *
 * Polling-only by default. All command paths are gated behind
 * `Bitaxe_Gamma1_LoadManagement_Enable` for automated use, and the manual
 * setpoints are guarded by `CFG.allowOverclock` for the frequency/voltage
 * setters.
 *
 * Pool credentials are intentionally out of scope. This script will refuse
 * to PATCH stratum settings even if asked.
 *
 * Requires the openhab-js helper library.
 */

const { rules, triggers, items } = require('openhab');
const URI = Java.type('java.net.URI');
const HttpClient = Java.type('java.net.http.HttpClient');
const HttpRequest = Java.type('java.net.http.HttpRequest');
const BodyPublishers = Java.type('java.net.http.HttpRequest$BodyPublishers');
const BodyHandlers = Java.type('java.net.http.HttpResponse$BodyHandlers');
const Duration = Java.type('java.time.Duration');

// -----------------------------------------------------------------------------
// CONFIGURATION
// -----------------------------------------------------------------------------

const CFG = {
  // LAN IP for the Bitaxe Gamma on the Earthship network. mDNS (`bitaxe.local`)
  // works too but hard-coding the IP avoids surprises if mDNS resolution is
  // intermittent on the network.
  host: '192.168.1.39',
  port: 80,
  prefix: 'Bitaxe_Gamma1_',

  fastPollCron: '0/15 * * * * ?',
  slowPollCron: '0 0/5 * * * ?',
  connectTimeoutMs: 5000,
  readTimeoutMs: 5000,

  // External load-management integration.
  // The Bitaxe physical AC power relay is the existing `Miner_Power` item.
  // It pre-dates this Bitaxe integration. Reusing it keeps the relay path
  // single-sourced; do not declare a parallel relay item.
  batterySocItem: 'BatterySoC_Calculated',
  chargerActiveItem: 'BatteryChargingStatus',
  powerRelayItem: 'Miner_Power',

  usePowerRelay: true,
  powerOffWhenStopped: false,

  // Frequency/voltage are paired — over-frequency without enough voltage
  // generates hardware errors. See decideProfile() in the dry-run policy.
  // Defaults below are conservative; the runtime authoritative source is
  // `/api/system/asic`'s `frequencyOptions` and `voltageOptions`, validated
  // by setFrequencyVoltage() before any PATCH.
  allowOverclock: true,

  // SoC policy mirrored from Avalon to keep behavior coherent across both
  // dump loads. See docs/bitaxe-integration-plan.md.
  socStopThreshold: 35,
  socMinProfileThreshold: 50,
  socStockProfileThreshold: 65,
  socMaxProfileThreshold: 85,

  requireChargerForWake: true,
  allowMiningWithoutCharger: false,
};

// Default profile table. Authoritative runtime source is `/api/system/asic`.
// `setFrequencyVoltage()` rejects any pair not present in the cached options.
const DEFAULT_PROFILES = [
  { name: 'Min',   frequency: 400, coreVoltage: 1100, watts: 13 },
  { name: 'Low',   frequency: 450, coreVoltage: 1150, watts: 15 },
  { name: 'Stock', frequency: 490, coreVoltage: 1200, watts: 18 },
  { name: 'Mid',   frequency: 525, coreVoltage: 1200, watts: 20 },
  { name: 'High',  frequency: 550, coreVoltage: 1250, watts: 22 },
  { name: 'Max',   frequency: 575, coreVoltage: 1300, watts: 25 },
];

// -----------------------------------------------------------------------------
// ITEM HELPERS
// -----------------------------------------------------------------------------

function itemName(suffix) {
  return `${CFG.prefix}${suffix}`;
}

function safePostUpdate(name, value) {
  try {
    items.getItem(name).postUpdate(String(value));
  } catch (e) {
    console.warn(`Bitaxe: postUpdate failed for ${name}: ${e}`);
  }
}

function safeSendCommand(name, value) {
  try {
    items.getItem(name).sendCommand(String(value));
  } catch (e) {
    console.warn(`Bitaxe: sendCommand failed for ${name}: ${e}`);
  }
}

function getItemString(name, fallback = '') {
  try {
    const state = items.getItem(name).state;
    return state == null ? fallback : String(state);
  } catch (e) {
    return fallback;
  }
}

function getItemNumber(name, fallback = 0) {
  const raw = getItemString(name, '');
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function getItemBool(name, fallback = false) {
  const raw = getItemString(name, '').toUpperCase();
  if (raw === 'ON' || raw === 'TRUE') return true;
  if (raw === 'OFF' || raw === 'FALSE') return false;
  return fallback;
}

// -----------------------------------------------------------------------------
// HTTP HELPERS
// -----------------------------------------------------------------------------
//
// Uses java.net.http.HttpClient (JDK 11+). The older HttpURLConnection does
// not accept PATCH without reflection, and this API also handles timeouts
// and UTF-8 bodies cleanly without managing streams by hand.

const HTTP_CLIENT = HttpClient.newBuilder()
  .connectTimeout(Duration.ofMillis(CFG.connectTimeoutMs))
  .build();

function buildUri(path) {
  return URI.create(`http://${CFG.host}:${CFG.port}${path}`);
}

function sendHttp(requestBuilder, method, path) {
  const request = requestBuilder
    .uri(buildUri(path))
    .timeout(Duration.ofMillis(CFG.readTimeoutMs))
    .header('Accept', 'application/json')
    .build();
  const response = HTTP_CLIENT.send(request, BodyHandlers.ofString());
  const code = response.statusCode();
  if (code < 200 || code >= 300) {
    throw new Error(`HTTP ${method} ${path} returned ${code}`);
  }
  return String(response.body());
}

function httpGet(path) {
  return sendHttp(HttpRequest.newBuilder().GET(), 'GET', path);
}

function httpPatch(path, body) {
  // The Bitaxe is settings-write sensitive; refuse anything that looks like
  // a pool-config write so a future caller cannot accidentally rewrite mining
  // credentials from a rule.
  const payload = JSON.stringify(body);
  if (/stratum/i.test(payload)) {
    throw new Error('Refusing to PATCH stratum/pool settings from automation');
  }
  const builder = HttpRequest.newBuilder()
    .method('PATCH', BodyPublishers.ofString(payload))
    .header('Content-Type', 'application/json');
  return sendHttp(builder, 'PATCH', path);
}

function httpPost(path) {
  const builder = HttpRequest.newBuilder().POST(BodyPublishers.noBody());
  return sendHttp(builder, 'POST', path);
}

// -----------------------------------------------------------------------------
// PARSERS
// -----------------------------------------------------------------------------

function safeJsonParse(raw) {
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function pickNumber(o, key) {
  if (!o || o[key] == null) return null;
  const n = Number(o[key]);
  return Number.isFinite(n) ? n : null;
}

function pickString(o, key) {
  if (!o || o[key] == null) return null;
  return String(o[key]);
}

function pickBool(o, key) {
  if (!o || o[key] == null) return null;
  if (typeof o[key] === 'boolean') return o[key];
  const n = Number(o[key]);
  return n === 1;
}

function parseInfo(raw) {
  const o = safeJsonParse(raw) || {};
  return {
    power: pickNumber(o, 'power'),
    voltageInputMv: pickNumber(o, 'voltage'),
    currentMa: pickNumber(o, 'current'),
    asicTempC: pickNumber(o, 'temp'),
    vrTempC: pickNumber(o, 'vrTemp'),
    hashrate: pickNumber(o, 'hashRate'),
    hashrate1m: pickNumber(o, 'hashRate_1m'),
    hashrate10m: pickNumber(o, 'hashRate_10m'),
    hashrate1h: pickNumber(o, 'hashRate_1h'),
    expectedHashrate: pickNumber(o, 'expectedHashrate'),
    errorPct: pickNumber(o, 'errorPercentage'),
    coreVoltage: pickNumber(o, 'coreVoltage'),
    coreVoltageActual: pickNumber(o, 'coreVoltageActual'),
    frequency: pickNumber(o, 'frequency'),
    sharesAccepted: pickNumber(o, 'sharesAccepted'),
    sharesRejected: pickNumber(o, 'sharesRejected'),
    bestDiff: pickString(o, 'bestDiff'),
    bestSessionDiff: pickString(o, 'bestSessionDiff'),
    uptimeSeconds: pickNumber(o, 'uptimeSeconds'),
    version: pickString(o, 'version'),
    axeOSVersion: pickString(o, 'axeOSVersion'),
    boardVersion: pickString(o, 'boardVersion'),
    asicModel: pickString(o, 'ASICModel'),
    hostname: pickString(o, 'hostname'),
    ipv4: pickString(o, 'ipv4'),
    stratumURL: pickString(o, 'stratumURL'),
    stratumPort: pickNumber(o, 'stratumPort'),
    stratumUser: pickString(o, 'stratumUser'),
    fallbackStratumURL: pickString(o, 'fallbackStratumURL'),
    fallbackStratumPort: pickNumber(o, 'fallbackStratumPort'),
    fallbackStratumUser: pickString(o, 'fallbackStratumUser'),
    fanspeed: pickNumber(o, 'fanspeed'),
    fanrpm: pickNumber(o, 'fanrpm'),
    autofanspeed: pickBool(o, 'autofanspeed'),
    tempTarget: pickNumber(o, 'temptarget'),
    overheatMode: pickBool(o, 'overheat_mode'),
    overclockEnabled: pickBool(o, 'overclockEnabled'),
    raw,
  };
}

function parseAsic(raw) {
  const o = safeJsonParse(raw) || {};
  const freqs = Array.isArray(o.frequencyOptions) ? o.frequencyOptions.map(Number).filter(Number.isFinite) : [];
  const volts = Array.isArray(o.voltageOptions) ? o.voltageOptions.map(Number).filter(Number.isFinite) : [];
  return {
    asicModel: pickString(o, 'ASICModel'),
    deviceModel: pickString(o, 'deviceModel'),
    asicCount: pickNumber(o, 'asicCount'),
    defaultFrequency: pickNumber(o, 'defaultFrequency'),
    defaultVoltage: pickNumber(o, 'defaultVoltage'),
    frequencyOptions: freqs,
    voltageOptions: volts,
    raw,
  };
}

// -----------------------------------------------------------------------------
// POLLING
// -----------------------------------------------------------------------------

function updateAvailability(isOnline) {
  safePostUpdate(itemName('Availability'), isOnline ? 'online' : 'offline');
}

function postIfFinite(suffix, value) {
  if (Number.isFinite(value)) safePostUpdate(itemName(suffix), value);
}

function postIfFiniteUnit(suffix, value, unit) {
  // UoM items fall back to the system default unit when posted as a bare
  // number, so temperatures must be posted with an explicit unit suffix.
  if (Number.isFinite(value)) safePostUpdate(itemName(suffix), `${value} ${unit}`);
}

function postIfString(suffix, value) {
  if (value != null && value !== '') safePostUpdate(itemName(suffix), value);
}

function updateFromInfo(info) {
  postIfFiniteUnit('Power', info.power, 'W');
  postIfFinite('VoltageInput_mV', info.voltageInputMv);
  postIfFinite('Current_mA', info.currentMa);
  postIfFiniteUnit('ASIC_Temp', info.asicTempC, '°C');
  postIfFiniteUnit('VR_Temp', info.vrTempC, '°C');
  postIfFinite('Hashrate', info.hashrate);
  postIfFinite('Hashrate_1m', info.hashrate1m);
  postIfFinite('Hashrate_10m', info.hashrate10m);
  postIfFinite('Hashrate_1h', info.hashrate1h);
  postIfFinite('ExpectedHashrate', info.expectedHashrate);
  postIfFinite('ErrorPct', info.errorPct);
  postIfFinite('Frequency', info.frequency);
  postIfFinite('CoreVoltage', info.coreVoltage);
  postIfFinite('CoreVoltageActual', info.coreVoltageActual);
  postIfFinite('FanSpeed', info.fanspeed);
  postIfFinite('FanRPM', info.fanrpm);
  postIfFiniteUnit('TempTarget', info.tempTarget, '°C');
  postIfFinite('SharesAccepted', info.sharesAccepted);
  postIfFinite('SharesRejected', info.sharesRejected);
  postIfFinite('UptimeSeconds', info.uptimeSeconds);
  postIfString('BestDiff', info.bestDiff);
  postIfString('BestSessionDiff', info.bestSessionDiff);
  postIfString('Firmware', info.version);
  postIfString('AxeOSVersion', info.axeOSVersion);
  postIfString('BoardVersion', info.boardVersion);
  postIfString('ASICModel', info.asicModel);
  postIfString('Hostname', info.hostname);
  postIfString('IPv4', info.ipv4);
  postIfString('PoolURL', info.stratumURL);
  postIfFinite('PoolPort', info.stratumPort);
  postIfString('PoolUser', info.stratumUser);
  postIfString('FallbackPoolURL', info.fallbackStratumURL);
  postIfFinite('FallbackPoolPort', info.fallbackStratumPort);
  postIfString('FallbackPoolUser', info.fallbackStratumUser);
  if (info.autofanspeed != null) safePostUpdate(itemName('AutoFan_State'), info.autofanspeed ? 'ON' : 'OFF');
  if (info.overheatMode != null) safePostUpdate(itemName('OverheatMode'), info.overheatMode ? 'ON' : 'OFF');
  if (info.overclockEnabled != null) safePostUpdate(itemName('OverclockEnabled'), info.overclockEnabled ? 'ON' : 'OFF');
  safePostUpdate(itemName('RawSystemInfo'), info.raw || '');
}

function updateFromAsic(asic) {
  postIfString('ASICModel', asic.asicModel);
  safePostUpdate(itemName('RawSystemAsic'), asic.raw || '');
  cache.private.put('bitaxeAsicCapabilities', {
    frequencyOptions: asic.frequencyOptions,
    voltageOptions: asic.voltageOptions,
    defaultFrequency: asic.defaultFrequency,
    defaultVoltage: asic.defaultVoltage,
  });
}

function getCachedAsicCapabilities() {
  const cached = cache.private.get('bitaxeAsicCapabilities');
  if (cached && cached.frequencyOptions && cached.frequencyOptions.length) return cached;
  return {
    frequencyOptions: DEFAULT_PROFILES.map(p => p.frequency),
    voltageOptions: Array.from(new Set(DEFAULT_PROFILES.map(p => p.coreVoltage))),
    defaultFrequency: 490,
    defaultVoltage: 1200,
  };
}

function pollFast() {
  try {
    const raw = httpGet('/api/system/info');
    const info = parseInfo(raw);
    updateAvailability(true);
    updateFromInfo(info);
  } catch (e) {
    console.warn(`Bitaxe fast poll failed: ${e}`);
    updateAvailability(false);
  }
}

function pollSlow() {
  try {
    const raw = httpGet('/api/system/asic');
    const asic = parseAsic(raw);
    updateAvailability(true);
    updateFromAsic(asic);
  } catch (e) {
    console.warn(`Bitaxe slow poll failed: ${e}`);
  }
}

// -----------------------------------------------------------------------------
// COMMANDS
// -----------------------------------------------------------------------------

function setFrequencyVoltage(frequencyMhz, coreVoltageMv) {
  const f = Number(frequencyMhz);
  const v = Number(coreVoltageMv);
  if (!Number.isFinite(f) || !Number.isFinite(v)) {
    throw new Error(`Invalid frequency/voltage pair: ${frequencyMhz}/${coreVoltageMv}`);
  }
  const caps = getCachedAsicCapabilities();
  if (caps.frequencyOptions.length && caps.frequencyOptions.indexOf(f) === -1) {
    throw new Error(`Frequency ${f} MHz not in allowed options: ${caps.frequencyOptions.join(',')}`);
  }
  if (caps.voltageOptions.length && caps.voltageOptions.indexOf(v) === -1) {
    throw new Error(`Voltage ${v} mV not in allowed options: ${caps.voltageOptions.join(',')}`);
  }
  if (!CFG.allowOverclock) {
    throw new Error('Overclock is gated off; set CFG.allowOverclock=true to permit frequency/voltage writes');
  }
  console.info(`Bitaxe set frequency/voltage: ${f} MHz, ${v} mV`);
  return httpPatch('/api/system', { overclockEnabled: 1, frequency: f, coreVoltage: v });
}

function setProfileByName(name) {
  const profile = DEFAULT_PROFILES.find(p => p.name.toLowerCase() === String(name || '').toLowerCase());
  if (!profile) throw new Error(`Unknown profile: ${name}`);
  return setFrequencyVoltage(profile.frequency, profile.coreVoltage);
}

function setFanSpeed(percent) {
  const v = Number(percent);
  if (!Number.isFinite(v) || v < 0 || v > 100) {
    throw new Error(`Fan speed must be 0..100, got ${percent}`);
  }
  return httpPatch('/api/system', { autofanspeed: 0, fanspeed: Math.trunc(v) });
}

function setFanAuto(enabled) {
  return httpPatch('/api/system', { autofanspeed: enabled ? 1 : 0 });
}

function identify() {
  return httpPost('/api/system/identify');
}

function restart() {
  return httpPost('/api/system/restart');
}

// -----------------------------------------------------------------------------
// RULES
// -----------------------------------------------------------------------------

rules.JSRule({
  name: 'Bitaxe Fast Poll',
  description: 'Poll /api/system/info from the Bitaxe Gamma',
  triggers: [triggers.GenericCronTrigger(CFG.fastPollCron)],
  execute: () => pollFast(),
});

rules.JSRule({
  name: 'Bitaxe Slow Poll',
  description: 'Poll /api/system/asic from the Bitaxe Gamma',
  triggers: [triggers.GenericCronTrigger(CFG.slowPollCron)],
  execute: () => pollSlow(),
});

rules.JSRule({
  name: 'Bitaxe Manual Frequency Set',
  triggers: [triggers.ItemCommandTrigger(itemName('TargetFrequency_Set'))],
  execute: (event) => {
    try {
      const targetFreq = Number(String(event.receivedCommand));
      const targetVolt = getItemNumber(itemName('TargetVoltage_Set'),
        getCachedAsicCapabilities().defaultVoltage);
      setFrequencyVoltage(targetFreq, targetVolt);
      pollFast();
    } catch (e) {
      console.warn(`Bitaxe manual frequency command failed: ${e}`);
    }
  },
});

rules.JSRule({
  name: 'Bitaxe Manual Voltage Set',
  triggers: [triggers.ItemCommandTrigger(itemName('TargetVoltage_Set'))],
  execute: (event) => {
    try {
      const targetVolt = Number(String(event.receivedCommand));
      const targetFreq = getItemNumber(itemName('TargetFrequency_Set'),
        getCachedAsicCapabilities().defaultFrequency);
      setFrequencyVoltage(targetFreq, targetVolt);
      pollFast();
    } catch (e) {
      console.warn(`Bitaxe manual voltage command failed: ${e}`);
    }
  },
});

rules.JSRule({
  name: 'Bitaxe Profile Set',
  triggers: [triggers.ItemCommandTrigger(itemName('Profile_Set'))],
  execute: (event) => {
    try {
      setProfileByName(String(event.receivedCommand));
      safePostUpdate(itemName('Profile'), String(event.receivedCommand));
      pollFast();
    } catch (e) {
      console.warn(`Bitaxe profile command failed: ${e}`);
    }
  },
});

rules.JSRule({
  name: 'Bitaxe Fan Speed Command',
  triggers: [triggers.ItemCommandTrigger(itemName('FanSpeed_Set'))],
  execute: (event) => {
    try {
      setFanSpeed(Number(String(event.receivedCommand)));
      pollFast();
    } catch (e) {
      console.warn(`Bitaxe fan speed command failed: ${e}`);
    }
  },
});

rules.JSRule({
  name: 'Bitaxe Fan Auto Command',
  triggers: [triggers.ItemCommandTrigger(itemName('FanAuto_Set'))],
  execute: (event) => {
    try {
      const on = String(event.receivedCommand).toUpperCase() === 'ON';
      setFanAuto(on);
      pollFast();
    } catch (e) {
      console.warn(`Bitaxe fan auto command failed: ${e}`);
    }
  },
});

rules.JSRule({
  name: 'Bitaxe Identify Command',
  triggers: [triggers.ItemCommandTrigger(itemName('Identify'))],
  execute: (event) => {
    try {
      if (String(event.receivedCommand).toUpperCase() === 'ON') {
        identify();
        safeSendCommand(itemName('Identify'), 'OFF');
      }
    } catch (e) {
      console.warn(`Bitaxe identify command failed: ${e}`);
    }
  },
});

rules.JSRule({
  name: 'Bitaxe Restart Command',
  triggers: [triggers.ItemCommandTrigger(itemName('Restart'))],
  execute: (event) => {
    try {
      if (String(event.receivedCommand).toUpperCase() === 'ON') {
        restart();
        safeSendCommand(itemName('Restart'), 'OFF');
      }
    } catch (e) {
      console.warn(`Bitaxe restart command failed: ${e}`);
    }
  },
});

// Prime the cache shortly after script load.
setTimeout(() => {
  try {
    pollSlow();
    pollFast();
  } catch (e) {
    console.warn(`Bitaxe initial poll failed: ${e}`);
  }
}, 3000);
