/*
 * GENERATED FILE — do not edit directly.
 *
 * Canonical source of policy logic:
 * openhab/examples/avalonq-dryrun-policy-core.js
 *
 * This inline action body is for the REST-managed live openHAB rule.
 */

/*
 * Canonical shared policy source for the Avalon Q irradiance-aware dry-run model.
 *
 * This file is the single source of truth for the dry-run policy logic.
 *
 * Consumers:
 * - avalonq-irradiance-dry-run.js (file-based JSRule wrapper)
 * - avalonq-irradiance-dry-run-action.js (generated inline action body for the
 *   REST-managed openHAB rule)
 */

const { items } = require('openhab');

const CFG = {
  irradianceItem: 'AmbientWeatherWS2902A_SolarRadiation',
  ambientTempItem: 'AmbientWeatherWS2902A_WeatherDataWs2902a_Temperature',
  pvActualItem: 'PV_Power',
  socFallbackItem: 'BatterySoC_Calculated',
  socPreferredItem: '',
  chargingItem: 'BatteryChargingStatus',
  chargerStatusItem: 'ChargerStatus',
  dcVoltageItem: 'DCData_Voltage',

  prefix: 'AvalonQ_Miner1_',

  // Array and thermal model assumptions.
  arrayNameplateWatts: 4200,
  mpptCapWatts: 3120,
  noctC: 45,
  tempCoeffPerC: 0.004,
  fixedLossFactor: 0.90,
  baselineHouseLoadWatts: 300,

  // Keep dry-run charger gating aligned with the live control policy.
  allowMiningWithoutCharger: false,

  // Dry-run mode thresholds use available watts after baseline house load.
  standardAvailableWatts: 1500,
  superAvailableWatts: 1900,
  ecoAvailableWatts: 800,
  ecoTrendingAvailableWatts: 500,
  standardMinSoc: 80,
  superMinSoc: 90,
  ecoMinSoc: 60,
  ecoTrendingMinSoc: 75,
  dumpLoadMinSoc: 90,

  standardSlope15mFloor: -50,
  superSlope15mFloor: 0,
  standbySlope15mThreshold: -150,
  standbySlopeSustainMinutes: 10,

  standbyLowSoc: 50,
  standbyHardLowSoc: 40,

  // Rolling windows.
  irradianceAvgWindowMinutes: 5,
  slopeShortWindowMinutes: 3,
  slopeLongWindowMinutes: 15,
  metricsWindowHours: 24,

  // Super mode is enabled for the 20A mining branch. Avalon Super draws
  // ~1674 W; branch capacity is 2400 W raw (1920 W NEC-derated), leaving
  // ~220 W of slack for the Bitaxe and margin.
  allowSuperMode: true,
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
  if (!name) return fallback;
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

function fahrenheitToCelsiusIfNeeded(temp) {
  if (!Number.isFinite(temp)) return temp;
  if (temp > 45) return (temp - 32) * 5.0 / 9.0;
  return temp;
}

function computeWindowAverage(samples, minutes) {
  const cutoff = nowMs() - (minutes * 60 * 1000);
  const filtered = samples.filter(s => s.ts >= cutoff);
  if (!filtered.length) return NaN;
  const sum = filtered.reduce((acc, s) => acc + s.value, 0);
  return sum / filtered.length;
}

function computeWindowSlope(samples, minutes) {
  const cutoff = nowMs() - (minutes * 60 * 1000);
  const filtered = samples.filter(s => s.ts >= cutoff);
  if (filtered.length < 2) return 0;

  const n = filtered.length;
  const meanX = filtered.reduce((acc, s) => acc + s.ts, 0) / n;
  const meanY = filtered.reduce((acc, s) => acc + s.value, 0) / n;

  let num = 0;
  let den = 0;
  for (const s of filtered) {
    const dx = s.ts - meanX;
    const dy = s.value - meanY;
    num += dx * dy;
    den += dx * dx;
  }
  if (den <= 0) return 0;

  const slopePerMs = num / den;
  return slopePerMs * 60000.0;
}

function updateIrradianceSeries(irradiance) {
  const key = 'avalonqIrradianceSeries';
  const ts = nowMs();
  const prev = cache.private.get(key) || [];
  const samples = prev.concat([{ ts, value: irradiance }]).filter(s => s.ts >= ts - (CFG.metricsWindowHours * 3600 * 1000));
  cache.private.put(key, samples);
  return samples;
}

function updateNegativeSlopeSustain(slope15m) {
  const key = 'avalonqNegativeSlopeStart';
  const ts = nowMs();
  const prev = cache.private.get(key);

  if (slope15m <= CFG.standbySlope15mThreshold) {
    if (!prev) {
      cache.private.put(key, ts);
      return 0;
    }
    return (ts - prev) / 60000.0;
  }

  if (prev) cache.private.remove(key);
  return 0;
}

function computeCellTempEstimateC(ambientC, irradianceWm2) {
  return ambientC + (((CFG.noctC - 20) / 800.0) * irradianceWm2);
}

function computeExpectedPvWatts(irradiance5mAvg, cellTempC) {
  const tempFactor = Math.max(0.5, 1 - (CFG.tempCoeffPerC * (cellTempC - 25)));
  const raw = CFG.arrayNameplateWatts * (irradiance5mAvg / 1000.0) * CFG.fixedLossFactor * tempFactor;
  return clamp(raw, 0, CFG.mpptCapWatts);
}

function getEffectiveSoc() {
  const preferred = getNumericState(CFG.socPreferredItem, NaN);
  if (Number.isFinite(preferred)) return preferred;
  return getNumericState(CFG.socFallbackItem, NaN);
}

function updateModeHistory(mode) {
  const key = 'avalonqModeHistory';
  const ts = nowMs();
  const cutoff = ts - (CFG.metricsWindowHours * 3600 * 1000);
  let history = cache.private.get(key) || [];
  history = history.filter(e => e.ts >= cutoff);

  const last = history.length ? history[history.length - 1] : null;
  if (!last || last.mode !== mode) {
    history.push({ ts, mode });
  }
  cache.private.put(key, history);
  return history;
}

function computeModeMetrics(history, currentMode) {
  const now = nowMs();
  const windowStart = now - (CFG.metricsWindowHours * 3600 * 1000);
  const modes = ['Eco', 'Standard', 'Super', 'Standby'];
  const totals = { Eco: 0, Standard: 0, Super: 0, Standby: 0 };

  if (!history.length) {
    return { changeCount: 0, dwellMinutes: 0, pct: totals };
  }

  const entries = history.slice();
  if (entries[0].ts > windowStart) {
    entries.unshift({ ts: windowStart, mode: entries[0].mode });
  }

  for (let i = 0; i < entries.length; i += 1) {
    const cur = entries[i];
    const end = (i + 1 < entries.length) ? entries[i + 1].ts : now;
    const durMs = Math.max(0, end - cur.ts);
    if (modes.includes(cur.mode)) {
      totals[cur.mode] += durMs;
    }
  }

  const totalMs = CFG.metricsWindowHours * 3600 * 1000;
  const pct = {
    Eco: (totals.Eco / totalMs) * 100,
    Standard: (totals.Standard / totalMs) * 100,
    Super: (totals.Super / totalMs) * 100,
    Standby: (totals.Standby / totalMs) * 100,
  };

  const changeCount = Math.max(0, history.length - 1);
  const last = history[history.length - 1];
  const dwellMinutes = currentMode === last.mode ? ((now - last.ts) / 60000.0) : 0;

  return { changeCount, dwellMinutes, pct };
}

function decideMode(ctx) {
  const {
    soc,
    charging,
    availableWatts,
    slope15m,
    slope15mSustainMinutes,
  } = ctx;

  // "Charger effectively active" tolerates the brief BatteryChargingStatus
  // flickers the XW+ produces when holding Float on a full bank. High SoC or
  // any active charger stage (Bulk/Absorption/Float) counts as charging even
  // if the instantaneous current momentarily dips to zero. Without this, the
  // dry-run mode flips Standby/Standard on every pulse and the thrash alert
  // fires for the wrong reason.
  const activeStages = ['Bulk', 'Absorption', 'Float'];
  const stageActive = typeof ctx.chargerStage === 'string' && activeStages.includes(ctx.chargerStage);
  const highSoc = Number.isFinite(soc) && soc >= 95;
  const chargerEffective = charging || stageActive || highSoc;
  if (!chargerEffective && !CFG.allowMiningWithoutCharger) {
    return { mode: 'Standby', reason: 'charger_inactive' };
  }
  if (soc <= CFG.standbyHardLowSoc) {
    return { mode: 'Standby', reason: 'soc_hard_low' };
  }
  if (soc < CFG.standbyLowSoc) {
    return { mode: 'Standby', reason: 'soc_low' };
  }
  if (slope15m <= CFG.standbySlope15mThreshold && slope15mSustainMinutes >= CFG.standbySlopeSustainMinutes) {
    return { mode: 'Standby', reason: 'irradiance_drop_sustained' };
  }
  // Peak-solar Super mode (requires 20A mining branch + allowSuperMode). Only
  // fires when irradiance is stable or rising so a cloud edge does not strand
  // the Avalon at full load. `chargerEffective` is used instead of the raw
  // charging flag for the same flicker-tolerance reason.
  if (
    CFG.allowSuperMode &&
    chargerEffective &&
    availableWatts > CFG.superAvailableWatts &&
    soc > CFG.superMinSoc &&
    slope15m > CFG.superSlope15mFloor
  ) {
    return { mode: 'Super', reason: 'peak_solar' };
  }
  // Strong-solar Standard is checked before the high-SoC shortcut so a full
  // battery does not cap the dump load at Eco when PV is actively being
  // curtailed. The Schneider XW6848-21 has 6.8 kW of continuous capacity, so
  // running Standard on top of normal house load is well within envelope.
  if (
    availableWatts > CFG.standardAvailableWatts &&
    soc > CFG.standardMinSoc &&
    slope15m > CFG.standardSlope15mFloor
  ) {
    return { mode: 'Standard', reason: 'strong_solar' };
  }
  if (soc >= CFG.dumpLoadMinSoc) {
    return { mode: 'Eco', reason: 'high_soc_dump_load' };
  }
  if (availableWatts > CFG.ecoAvailableWatts && soc > CFG.ecoMinSoc) {
    return { mode: 'Eco', reason: 'moderate_solar' };
  }
  if (availableWatts > CFG.ecoTrendingAvailableWatts && soc > CFG.ecoTrendingMinSoc && slope15m > 0) {
    return { mode: 'Eco', reason: 'solar_trending_up' };
  }
  return { mode: 'Standby', reason: 'insufficient_margin' };
}

function runDryPolicy() {
  const irradianceRaw = getNumericState(CFG.irradianceItem);
  const irradiance = Number.isFinite(irradianceRaw) ? Math.max(0, irradianceRaw) : irradianceRaw;
  const ambientRaw = getNumericState(CFG.ambientTempItem);
  const ambientC = fahrenheitToCelsiusIfNeeded(ambientRaw);
  const pvActual = getNumericState(CFG.pvActualItem, 0);
  const soc = getEffectiveSoc();
  const charging = getBoolState(CFG.chargingItem, false);
  const chargerStatus = (() => {
    try { return String(items.getItem(CFG.chargerStatusItem).state); } catch (e) { return ''; }
  })();
  const dcVoltage = getNumericState(CFG.dcVoltageItem);

  if (!Number.isFinite(irradiance) || !Number.isFinite(soc) || !Number.isFinite(ambientC)) {
    post(itemName('DryRun_Status'), 'missing_inputs');
    return;
  }

  const samples = updateIrradianceSeries(irradiance);
  const avg5m = computeWindowAverage(samples, CFG.irradianceAvgWindowMinutes);
  const slope3m = computeWindowSlope(samples, CFG.slopeShortWindowMinutes);
  const slope15m = computeWindowSlope(samples, CFG.slopeLongWindowMinutes);
  const slope15mSustainMinutes = updateNegativeSlopeSustain(slope15m);

  const cellTempC = computeCellTempEstimateC(ambientC, avg5m);
  const expectedPvWatts = computeExpectedPvWatts(avg5m, cellTempC);
  const availableWatts = Math.max(0, expectedPvWatts - CFG.baselineHouseLoadWatts);
  const curtailmentRatio = expectedPvWatts > 0 ? (pvActual / expectedPvWatts) : 0;

  const decision = decideMode({
    soc,
    charging,
    chargerStage: chargerStatus,
    availableWatts,
    slope15m,
    slope15mSustainMinutes,
  });

  const history = updateModeHistory(decision.mode);
  const metrics = computeModeMetrics(history, decision.mode);

  post(itemName('SoC_Effective'), soc.toFixed(2));
  post(itemName('SolarIrradiance'), irradiance);
  post(itemName('SolarIrradiance_5minAvg'), avg5m.toFixed(2));
  post(itemName('SolarIrradiance_Slope'), slope15m.toFixed(2));
  post(itemName('SolarIrradiance_Slope_3min'), slope3m.toFixed(2));
  post(itemName('SolarIrradiance_Slope_15min'), slope15m.toFixed(2));
  post(itemName('Panel_CellTemp_Estimate'), `${cellTempC.toFixed(2)} °C`);
  post(itemName('PV_Expected_Watts'), Math.round(expectedPvWatts));
  post(itemName('PV_Actual_Watts'), Math.round(pvActual));
  post(itemName('PV_Curtailment_Ratio'), curtailmentRatio.toFixed(2));
  post(itemName('DryRun_ModeChanges_24h'), metrics.changeCount);
  post(itemName('DryRun_DwellTime_Current'), `${metrics.dwellMinutes.toFixed(1)} min`);
  post(itemName('DryRun_Eco_Pct_24h'), metrics.pct.Eco.toFixed(1));
  post(itemName('DryRun_Standard_Pct_24h'), metrics.pct.Standard.toFixed(1));
  post(itemName('DryRun_Super_Pct_24h'), metrics.pct.Super.toFixed(1));
  post(itemName('DryRun_Standby_Pct_24h'), metrics.pct.Standby.toFixed(1));

  const detail = [
    `mode=${decision.mode}`,
    `reason=${decision.reason}`,
    `irr=${irradiance.toFixed(1)}`,
    `avg5=${avg5m.toFixed(1)}`,
    `s3=${slope3m.toFixed(1)}`,
    `s15=${slope15m.toFixed(1)}`,
    `s15hold=${slope15mSustainMinutes.toFixed(1)}m`,
    `tcell=${cellTempC.toFixed(1)}C`,
    `expected=${Math.round(expectedPvWatts)}`,
    `actual=${Math.round(pvActual)}`,
    `curt=${curtailmentRatio.toFixed(2)}`,
    `avail=${Math.round(availableWatts)}`,
    `soc=${soc.toFixed(1)}`,
    `chg=${charging}`,
    `stage=${chargerStatus}`,
    `v=${Number.isFinite(dcVoltage) ? dcVoltage.toFixed(2) : 'n/a'}`,
    `chg24=${metrics.changeCount}`,
    `dwell=${metrics.dwellMinutes.toFixed(1)}m`,
  ].join(',');

  post(itemName('DryRun_ModeDecision'), detail);
  post(itemName('DryRun_Status'), 'enabled-dry-run-no-command-output');
  post(itemName('LoadDecision'), `dryrun:${detail}`);

  console.info(`AvalonQ dry-run decision: ${detail}`);
}


runDryPolicy();
