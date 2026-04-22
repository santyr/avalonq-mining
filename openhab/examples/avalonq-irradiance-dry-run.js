/*
 * Avalon Q irradiance-aware dry-run control rule for openHAB.
 *
 * Purpose:
 * - consume live weather irradiance, PV output, and battery SoC
 * - compute smoothed irradiance and irradiance slope
 * - estimate available solar for discretionary load
 * - decide the intended Avalon mode (Standby / Eco / Standard)
 * - log and update Avalon dry-run items only
 * - never send miner commands in this file
 *
 * Current site assumptions:
 * - 15A circuit, so automatic control is capped at Standard
 * - no trustworthy panel-temperature item exists yet
 * - expected PV uses irradiance-only first-pass math
 */

const { rules, triggers, items } = require('openhab');

const CFG = {
  irradianceItem: 'AmbientWeatherWS2902A_SolarRadiation',
  pvActualItem: 'PV_Power',
  socItem: 'BatterySoC_Calculated',
  chargingItem: 'BatteryChargingStatus',
  chargerStatusItem: 'ChargerStatus',
  dcVoltageItem: 'DCData_Voltage',

  prefix: 'AvalonQ_Miner1_',

  // Array and system assumptions for first-pass expected PV model.
  arrayNameplateWatts: 4200,
  mpptCapWatts: 3120,
  baselineHouseLoadWatts: 300,

  // Dry-run mode thresholds.
  standardExpectedPvWatts: 1800,
  ecoExpectedPvWatts: 1100,
  ecoTrendingExpectedPvWatts: 800,
  standardMinSoc: 80,
  ecoMinSoc: 60,
  ecoTrendingMinSoc: 75,
  dumpLoadMinSoc: 90,

  standardSlopeFloor: -50,
  standbySlopeThreshold: -150,
  standbySlopeSustainMinutes: 10,

  standbyLowSoc: 50,
  standbyHardLowSoc: 40,

  // Approximate five-minute smoothing using time-aware EMA.
  smoothingWindowSeconds: 300,

  // Safety note only; no switching occurs here.
  allowSuperMode: false,
};

function itemName(suffix) {
  return `${CFG.prefix}${suffix}`;
}

function post(name, value) {
  try {
    items.getItem(name).postUpdate(String(value));
  } catch (e) {
    console.warn(`AvalonQ dry-run postUpdate failed for ${name}: ${e}`);
  }
}

function getNumericState(name, fallback = NaN) {
  try {
    const raw = String(items.getItem(name).state);
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch (e) {
    return fallback;
  }
}

function getBoolState(name, fallback = false) {
  try {
    const raw = String(items.getItem(name).state).toUpperCase();
    if (raw === 'ON' || raw === 'TRUE') return true;
    if (raw === 'OFF' || raw === 'FALSE') return false;
    return fallback;
  } catch (e) {
    return fallback;
  }
}

function nowMs() {
  return Date.now();
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function updateSmoothingAndSlope(irradiance) {
  const key = 'avalonqIrradianceState';
  const prev = cache.private.get(key);
  const ts = nowMs();

  let avg = irradiance;
  let slope = 0;

  if (prev && typeof prev === 'object') {
    const dtSeconds = Math.max(1, (ts - prev.ts) / 1000.0);

    // Time-aware EMA with approximately a 5-minute smoothing horizon.
    const alpha = clamp(dtSeconds / CFG.smoothingWindowSeconds, 0.01, 1.0);
    avg = (alpha * irradiance) + ((1 - alpha) * prev.avg);

    const dtMinutes = dtSeconds / 60.0;
    slope = (irradiance - prev.raw) / Math.max(dtMinutes, 1 / 60.0);
  }

  cache.private.put(key, { ts, raw: irradiance, avg, slope });
  return { avg, slope };
}

function updateSlopeSustain(slope) {
  const key = 'avalonqNegativeSlopeStart';
  const ts = nowMs();
  const prev = cache.private.get(key);

  if (slope <= CFG.standbySlopeThreshold) {
    if (!prev) {
      cache.private.put(key, ts);
      return 0;
    }
    return (ts - prev) / 60000.0;
  }

  if (prev) cache.private.remove(key);
  return 0;
}

function computeExpectedPvWatts(irradianceWm2) {
  const raw = CFG.arrayNameplateWatts * (irradianceWm2 / 1000.0);
  return clamp(raw, 0, CFG.mpptCapWatts);
}

function decideMode(ctx) {
  const {
    soc,
    expectedPvWatts,
    availableWatts,
    slope,
    slopeSustainMinutes,
  } = ctx;

  if (soc <= CFG.standbyHardLowSoc) {
    return { mode: 'Standby', reason: 'soc_hard_low' };
  }

  if (soc < CFG.standbyLowSoc) {
    return { mode: 'Standby', reason: 'soc_low' };
  }

  if (slope <= CFG.standbySlopeThreshold && slopeSustainMinutes >= CFG.standbySlopeSustainMinutes) {
    return { mode: 'Standby', reason: 'irradiance_drop_sustained' };
  }

  if (soc >= CFG.dumpLoadMinSoc) {
    return { mode: 'Eco', reason: 'high_soc_dump_load' };
  }

  if (
    expectedPvWatts > CFG.standardExpectedPvWatts &&
    availableWatts > 1000 &&
    soc > CFG.standardMinSoc &&
    slope > CFG.standardSlopeFloor
  ) {
    return { mode: 'Standard', reason: 'strong_solar' };
  }

  if (expectedPvWatts > CFG.ecoExpectedPvWatts && soc > CFG.ecoMinSoc) {
    return { mode: 'Eco', reason: 'moderate_solar' };
  }

  if (expectedPvWatts > CFG.ecoTrendingExpectedPvWatts && soc > CFG.ecoTrendingMinSoc && slope > 0) {
    return { mode: 'Eco', reason: 'solar_trending_up' };
  }

  return { mode: 'Standby', reason: 'insufficient_margin' };
}

function runDryPolicy() {
  const irradiance = getNumericState(CFG.irradianceItem);
  const pvActual = getNumericState(CFG.pvActualItem, 0);
  const soc = getNumericState(CFG.socItem);
  const charging = getBoolState(CFG.chargingItem, false);
  const chargerStatus = (() => {
    try { return String(items.getItem(CFG.chargerStatusItem).state); } catch (e) { return ''; }
  })();
  const dcVoltage = getNumericState(CFG.dcVoltageItem);

  if (!Number.isFinite(irradiance) || !Number.isFinite(soc)) {
    post(itemName('DryRun_Status'), 'missing_inputs');
    return;
  }

  const { avg, slope } = updateSmoothingAndSlope(irradiance);
  const slopeSustainMinutes = updateSlopeSustain(slope);

  const expectedPvWatts = computeExpectedPvWatts(avg);
  const availableWatts = Math.max(0, expectedPvWatts - CFG.baselineHouseLoadWatts);
  const curtailmentRatio = expectedPvWatts > 0 ? (pvActual / expectedPvWatts) : 0;

  const decision = decideMode({
    soc,
    expectedPvWatts,
    availableWatts,
    slope,
    slopeSustainMinutes,
  });

  post(itemName('SolarIrradiance'), irradiance);
  post(itemName('SolarIrradiance_5minAvg'), avg.toFixed(2));
  post(itemName('SolarIrradiance_Slope'), slope.toFixed(2));
  post(itemName('PV_Expected_Watts'), Math.round(expectedPvWatts));
  post(itemName('PV_Actual_Watts'), Math.round(pvActual));
  post(itemName('PV_Curtailment_Ratio'), curtailmentRatio.toFixed(2));

  const detail = [
    `mode=${decision.mode}`,
    `reason=${decision.reason}`,
    `irr=${irradiance.toFixed(1)}`,
    `avg=${avg.toFixed(1)}`,
    `slope=${slope.toFixed(1)}`,
    `sustain=${slopeSustainMinutes.toFixed(1)}m`,
    `expected=${Math.round(expectedPvWatts)}`,
    `actual=${Math.round(pvActual)}`,
    `avail=${Math.round(availableWatts)}`,
    `soc=${soc.toFixed(1)}`,
    `chg=${charging}`,
    `stage=${chargerStatus}`,
    `v=${Number.isFinite(dcVoltage) ? dcVoltage.toFixed(2) : 'n/a'}`,
  ].join(',');

  post(itemName('DryRun_ModeDecision'), detail);
  post(itemName('DryRun_Status'), 'active-dry-run-logic-disabled-for-now');
  post(itemName('LoadDecision'), `dryrun:${detail}`);

  console.info(`AvalonQ dry-run decision: ${detail}`);
}

rules.JSRule({
  name: 'AvalonQ Irradiance Dry Run',
  description: 'Dry-run only. Computes intended Avalon mode from irradiance, PV output, and SoC without sending miner commands.',
  triggers: [
    triggers.ItemStateChangeTrigger(CFG.irradianceItem),
    triggers.ItemStateChangeTrigger(CFG.pvActualItem),
    triggers.ItemStateChangeTrigger(CFG.socItem),
    triggers.ItemStateChangeTrigger(CFG.chargingItem),
    triggers.GenericCronTrigger('0 */5 * * * ?'),
  ],
  execute: () => {
    try {
      runDryPolicy();
    } catch (e) {
      console.warn(`AvalonQ irradiance dry-run failed: ${e}`);
      post(itemName('DryRun_Status'), `error:${e}`);
    }
  },
});
