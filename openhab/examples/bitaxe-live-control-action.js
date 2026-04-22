/*
 * Live Bitaxe Gamma profile controller.
 *
 * Reads the dry-run policy's decided profile from `Bitaxe_Gamma1_DryRun_Profile`
 * (plus `DryRun_TargetFrequency` / `DryRun_TargetVoltage`) and pushes it to the
 * device via PATCH /api/system. Gated on `Bitaxe_Gamma1_LoadManagement_Enable`.
 *
 * This script is used as the inline ScriptAction body of a REST-managed rule
 * (`hex_bitaxe_live_profile`). Triggers:
 *   - ItemStateChangeTrigger: Bitaxe_Gamma1_DryRun_Profile
 *   - ItemStateChangeTrigger: Bitaxe_Gamma1_LoadManagement_Enable
 *
 * Uses openHAB's HttpUtil which, unlike `actions.HTTP`, exposes PATCH.
 */

const { items } = require('openhab');
const URI = Java.type('java.net.URI');
const HttpClient = Java.type('java.net.http.HttpClient');
const HttpRequest = Java.type('java.net.http.HttpRequest');
const BodyPublishers = Java.type('java.net.http.HttpRequest$BodyPublishers');
const BodyHandlers = Java.type('java.net.http.HttpResponse$BodyHandlers');
const Duration = Java.type('java.time.Duration');

const CFG = {
  host: '192.168.1.39',
  port: 80,
  prefix: 'Bitaxe_Gamma1_',
  timeoutMs: 5000,
  // Hard safety bounds for the PATCH body. Even if the dry-run target drifts
  // outside these, the controller will refuse. These bracket the BM1370's
  // community-tested envelope.
  freqMinMhz: 400,
  freqMaxMhz: 600,
  voltMinMv: 1090,
  voltMaxMv: 1320,
  // Standby -> Min mapping: drops the device to its lowest active profile
  // rather than cutting the relay. Voltage-protection handles the relay path
  // for genuine low-bank emergencies.
  standbyFrequency: 400,
  standbyVoltage: 1100,
};

function itemName(suffix) { return `${CFG.prefix}${suffix}`; }

function getStringState(name, fb = '') {
  try { return String(items.getItem(name).state); } catch (e) { return fb; }
}
function getNumericState(name, fb = NaN) {
  const raw = getStringState(name);
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fb;
}
function getBoolState(name, fb = false) {
  const raw = getStringState(name).toUpperCase();
  if (raw === 'ON') return true;
  if (raw === 'OFF') return false;
  return fb;
}
function post(name, value) {
  try { items.getItem(name).postUpdate(String(value)); } catch (e) {}
}

function httpPatch(url, body) {
  // Pool/stratum settings are operator-managed. Refuse any PATCH body that
  // mentions them so a future caller cannot rewrite mining credentials here.
  if (/stratum/i.test(body)) {
    throw new Error('refusing to PATCH stratum/pool settings from automation');
  }
  // `java.net.http.HttpClient` (JDK 11+) is the only stdlib path that accepts
  // PATCH. openHAB's `HttpUtil` and `actions.HTTP` both reject it. The ESP
  // HTTP server on AxeOS only speaks HTTP/1.1 and chokes on the default
  // HTTP/2 upgrade ("Bad request syntax"), so pin the version.
  const client = HttpClient.newBuilder()
    .version(HttpClient.Version.HTTP_1_1)
    .connectTimeout(Duration.ofMillis(CFG.timeoutMs))
    .build();
  const request = HttpRequest.newBuilder()
    .uri(URI.create(url))
    .timeout(Duration.ofMillis(CFG.timeoutMs))
    .header('Content-Type', 'application/json')
    .expectContinue(false)
    .method('PATCH', BodyPublishers.ofString(body))
    .build();
  const response = client.send(request, BodyHandlers.ofString());
  const code = response.statusCode();
  if (code < 200 || code >= 300) {
    const respBody = String(response.body());
    throw new Error(`PATCH ${url} returned ${code}: ${respBody.substring(0, 200)}`);
  }
  return String(response.body());
}

function applyPair(frequency, coreVoltage) {
  const f = Math.trunc(Number(frequency));
  const v = Math.trunc(Number(coreVoltage));
  if (!Number.isFinite(f) || f < CFG.freqMinMhz || f > CFG.freqMaxMhz) {
    throw new Error(`frequency ${f} MHz out of safe bounds [${CFG.freqMinMhz},${CFG.freqMaxMhz}]`);
  }
  if (!Number.isFinite(v) || v < CFG.voltMinMv || v > CFG.voltMaxMv) {
    throw new Error(`voltage ${v} mV out of safe bounds [${CFG.voltMinMv},${CFG.voltMaxMv}]`);
  }
  const body = JSON.stringify({ overclockEnabled: 1, frequency: f, coreVoltage: v });
  const url = `http://${CFG.host}:${CFG.port}/api/system`;
  console.info(`Bitaxe live: PATCH ${f} MHz / ${v} mV`);
  httpPatch(url, body);
  return { f, v };
}

function main() {
  if (!getBoolState(itemName('LoadManagement_Enable'), false)) {
    post(itemName('LoadDecision'), 'live_controller_disabled');
    return;
  }
  const profile = getStringState(itemName('DryRun_Profile'), '');
  if (!profile || profile === 'NULL') {
    post(itemName('LoadDecision'), 'live_controller_no_decision');
    return;
  }

  try {
    let freq, volt;
    if (profile === 'Standby') {
      freq = CFG.standbyFrequency;
      volt = CFG.standbyVoltage;
    } else {
      freq = getNumericState(itemName('DryRun_TargetFrequency'), NaN);
      volt = getNumericState(itemName('DryRun_TargetVoltage'), NaN);
    }
    const applied = applyPair(freq, volt);
    post(itemName('Profile'), profile);
    post(itemName('LoadDecision'), `live_applied:${profile}@${applied.f}mhz/${applied.v}mv`);
  } catch (e) {
    console.warn(`Bitaxe live controller error: ${e}`);
    post(itemName('LoadDecision'), `live_error:${e}`);
  }
}

main();
