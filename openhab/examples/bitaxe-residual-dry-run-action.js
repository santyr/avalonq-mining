/*
 * GENERATED FILE — do not edit directly.
 *
 * Canonical source of policy logic:
 * openhab/examples/bitaxe-residual-policy-core.js
 *
 * This inline action body is for the REST-managed live openHAB rule.
 * Regenerate by running the same transform as
 * scripts/generate_avalon_dryrun_action.py, or copy the core body here,
 * strip the `module.exports = { ... };` block, and append `runDryPolicy();`.
 */

/*
 * Canonical shared policy source for the Bitaxe Gamma residual-watts dry-run model.
 *
 * This file is the single source of truth for the dry-run policy logic.
 *
 * Consumers:
 * - bitaxe-residual-dry-run.js (file-based JSRule wrapper)
 * - bitaxe-residual-dry-run-action.js (generated inline action body for the
 *   REST-managed openHAB rule)
 *
 * The Bitaxe is the fine-grain dump-load complement to the Avalon Q. It trims
 * the residual wattage above or below the Avalon's current quantized mode
 * step. See docs/bitaxe-integration-plan.md.
 */

const { items } = require('openhab');

const CFG = {
  // Inputs read from existing Avalon dry-run items so this rule does not
  // duplicate the irradiance modelling.
  pvExpectedItem: 'AvalonQ_Miner1_PV_Expected_Watts',
  avalonModeDecisionItem: 'AvalonQ_Miner1_DryRun_ModeDecision',
  irradianceSlope15mItem: 'AvalonQ_Miner1_SolarIrradiance_Slope_15min',
  socEffectiveItem: 'AvalonQ_Miner1_SoC_Effective',
  socFallbackItem: 'BatterySoC_Calculated',
  chargingItem: 'BatteryChargingStatus',

  // Bitaxe live telemetry used for thermal guardrails. Tolerated as
  // missing/NaN before commissioning; see decideProfile().
  bitaxeTempItem: 'Bitaxe_Gamma1_ASIC_Temp',
  bitaxeVRTempItem: 'Bitaxe_Gamma1_VR_Temp',
  bitaxeOverheatItem: 'Bitaxe_Gamma1_OverheatMode',

  prefix: 'Bitaxe_Gamma1_',

  // Same baseline house load used in the Avalon policy core. Kept as a local
  // constant rather than imported to avoid a hard cross-file dependency.
  baselineHouseLoadWatts: 300,

  // Mirrors the Avalon policy: do not run miners while the charger is idle.
  allowMiningWithoutCharger: false,

  // AGM-REGIME SoC guardrails (conservative). The Fullriver DC400-6 bank is at
  // end-of-life — 4 of 16 cells dead, ~50-60% usable capacity. We only run
  // mining when the bank is well above mid-charge so the discretionary load
  // never compounds the bank's stress. See https://github.com/santyr/Solar_PV.
  //
  // Post-LFP-upgrade target values (after Discover AES install, Q2 2026):
  //   standbyHardLowSoc: 40, standbyLowSoc: 50, minProfileMinSoc: 50,
  //   stockProfileMinSoc: 65, highProfileMinSoc: 80, maxProfileMinSoc: 90
  standbyHardLowSoc: 70,
  standbyLowSoc: 80,
  minProfileMinSoc: 70,
  stockProfileMinSoc: 82,
  highProfileMinSoc: 92,
  maxProfileMinSoc: 96,

  // Sustained negative-irradiance gating (mirrors avalon).
  standbySlope15mThreshold: -150,
  standbySlopeSustainMinutes: 10,

  // Thermal guardrails, separate limits for ASIC and VR. At the downshift
  // threshold we drop one profile rank; at the standby threshold we force
  // Standby. VR typically runs ~10-15 °C hotter than ASIC under load — the
  // 575 MHz / 1300 mV pair on this BM1370 crossed 87 °C VR before the ASIC
  // reached the 80 °C ASIC trip, so the VR limits are the binding check.
  thermalDownshiftC: 68,
  thermalStandbyC: 78,
  vrDownshiftC: 80,
  vrStandbyC: 90,

  // Hysteresis. The Bitaxe has more profile steps than the Avalon, so naive
  // residual-band gating thrashes on irradiance noise. Two guards:
  // - minimum dwell time before any non-safety profile change
  // - residual-watts hysteresis band added on profile downgrades
  minDwellMinutes: 5,
  hysteresisWatts: 2,

  // Default ceiling profile for automated selection. Max is still in the
  // profile table so it can be commanded manually via `Bitaxe_Gamma1_Profile_Set`,
  // but the automated policy will not pick above `defaultCeiling` on its own.
  // Rationale: at this chip's operating point Max (550/1250) gains ~12%
  // hashrate for +35% power over Stock, runs VR hotter, and only absorbs an
  // extra 2 W of curtailment — not worth the thermal stress for steady state.
  defaultCeiling: 'High',

  metricsWindowHours: 24,
};

// Profile table. Values are restricted to pairs from the live device's
// `/api/system/asic` response (frequencyOptions + voltageOptions) so every
// entry is a vendor-blessed operating point. The 575 MHz / 1300 mV pair from
// the original defaults was removed after it drove VR temp past 87 °C on
// this chip at ambient. Max is now capped at 550 / 1250.
//
// Stock is pinned to the operator-tuned efficient pair (525 MHz / 1150 mV)
// which has run 0% error over thousands of shares at ~17 W. Per-profile
// minSoc values are AGM-regime conservative; lower them ~15 points across
// the board after the LFP upgrade lands.
const PROFILES = [
  { name: 'Min',   frequency: 400, coreVoltage: 1100, watts: 10, minSoc: 70 },
  { name: 'Low',   frequency: 490, coreVoltage: 1150, watts: 14, minSoc: 75 },
  { name: 'Stock', frequency: 525, coreVoltage: 1150, watts: 17, minSoc: 82 },
  { name: 'Mid',   frequency: 525, coreVoltage: 1200, watts: 19, minSoc: 88 },
  { name: 'High',  frequency: 550, coreVoltage: 1200, watts: 21, minSoc: 92 },
  { name: 'Max',   frequency: 550, coreVoltage: 1250, watts: 23, minSoc: 96 },
];

const PROFILE_NAMES = ['Standby'].concat(PROFILES.map(p => p.name));
const PROFILE_RANK = (name) => PROFILE_NAMES.indexOf(name);

function itemName(suffix) {
  return `${CFG.prefix}${suffix}`;
}

function post(name, value) {
  try {
    items.getItem(name).postUpdate(String(value));
  } catch (e) {
    console.warn(`Bitaxe dry-run postUpdate failed for ${name}: ${e}`);
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

function getStringState(name, fallback = '') {
  try {
    return String(items.getItem(name).state);
  } catch (e) {
    return fallback;
  }
}

function getCelsiusState(name, fallback = NaN) {
  // UoM `Number:Temperature` items can store the value in any temperature unit
  // depending on system defaults. Normalize to Celsius by inspecting the
  // suffix of the state string (parseFloat ignores trailing non-numeric
  // characters, so the number parses fine either way).
  try {
    const raw = String(items.getItem(name).state);
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return fallback;
    const trimmed = raw.replace(/\s+$/, '');
    const last = trimmed.charAt(trimmed.length - 1);
    if (last === 'F') return (n - 32) * 5 / 9;
    if (last === 'K') return n - 273.15;
    return n;
  } catch (e) {
    return fallback;
  }
}

function nowMs() { return Date.now(); }

function parseAvalonMode(detail) {
  // The Avalon dry-run writes a comma-separated detail string; the first
  // token is `mode=<Eco|Standard|Super|Standby>`.
  if (!detail) return 'Standby';
  const m = detail.match(/(?:^|,)mode=([A-Za-z]+)/);
  if (!m) return 'Standby';
  const mode = m[1];
  if (mode === 'Eco' || mode === 'Standard' || mode === 'Super' || mode === 'Standby') return mode;
  return 'Standby';
}

function avalonWattsForMode(mode) {
  if (mode === 'Super') return 1674;
  if (mode === 'Standard') return 1300;
  if (mode === 'Eco') return 800;
  return 0;
}

function getEffectiveSoc() {
  const preferred = getNumericState(CFG.socEffectiveItem, NaN);
  if (Number.isFinite(preferred)) return preferred;
  return getNumericState(CFG.socFallbackItem, NaN);
}

function updateNegativeSlopeSustain(slope15m) {
  const key = 'bitaxeNegativeSlopeStart';
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

function pickProfileByResidual(residualWatts, soc) {
  // Walk highest-to-lowest so we land on the highest profile that the
  // residual budget supports AND that the SoC permits, capped at the
  // policy's `defaultCeiling`. Profiles above the ceiling (e.g., Max) are
  // reachable only via manual `Bitaxe_Gamma1_Profile_Set` overrides.
  const ceilingIdx = PROFILES.findIndex(p => p.name === CFG.defaultCeiling);
  const startIdx = ceilingIdx >= 0 ? ceilingIdx : PROFILES.length - 1;
  for (let i = startIdx; i >= 0; i -= 1) {
    const p = PROFILES[i];
    if (residualWatts >= p.watts && soc >= p.minSoc) return p.name;
  }
  return 'Standby';
}

function applyHysteresis(targetProfile, lastProfile, residualWatts) {
  // Allow upgrades and Standby drops without hysteresis. For non-Standby
  // downgrades, require the residual to fall below the prior profile's watts
  // by at least hysteresisWatts before stepping down.
  if (lastProfile == null || lastProfile === '') return targetProfile;
  if (targetProfile === lastProfile) return targetProfile;
  if (targetProfile === 'Standby') return targetProfile;

  const prevRank = PROFILE_RANK(lastProfile);
  const targetRank = PROFILE_RANK(targetProfile);
  if (targetRank > prevRank) return targetProfile;

  const prevProfile = PROFILES.find(p => p.name === lastProfile);
  if (!prevProfile) return targetProfile;
  if (residualWatts >= prevProfile.watts - CFG.hysteresisWatts) return lastProfile;
  return targetProfile;
}

function applyDwell(targetProfile, lastProfile, lastChangeMs, currentMs) {
  // Standby is a safety state, not a stable operating mode. Free entry and
  // free exit — the dwell guard only prevents thrash between active profiles.
  if (targetProfile === 'Standby') return targetProfile;
  if (lastProfile === 'Standby') return targetProfile;
  if (lastProfile == null || lastChangeMs == null || currentMs == null) return targetProfile;
  if (targetProfile === lastProfile) return targetProfile;
  const dwellMin = (currentMs - lastChangeMs) / 60000.0;
  if (dwellMin < CFG.minDwellMinutes) return lastProfile;
  return targetProfile;
}

function applyThermal(targetProfile, asicTempC, vrTempC, overheatMode) {
  if (overheatMode === true) return 'Standby';
  // Standby conditions — if either sensor crosses the standby limit, drop
  // immediately regardless of hysteresis.
  if (Number.isFinite(asicTempC) && asicTempC >= CFG.thermalStandbyC) return 'Standby';
  if (Number.isFinite(vrTempC) && vrTempC >= CFG.vrStandbyC) return 'Standby';
  // Downshift conditions — step down a single rank. The VR path is more
  // aggressive because VR is the first to reach unsafe levels on the BM1370.
  const shouldDownshift =
    (Number.isFinite(asicTempC) && asicTempC >= CFG.thermalDownshiftC) ||
    (Number.isFinite(vrTempC) && vrTempC >= CFG.vrDownshiftC);
  if (shouldDownshift) {
    const rank = PROFILE_RANK(targetProfile);
    if (rank > 1) return PROFILE_NAMES[rank - 1];
  }
  return targetProfile;
}

function decideProfile(ctx) {
  const {
    soc,
    charging,
    residualWatts,
    slope15m,
    slope15mSustainMinutes,
    asicTempC,
    vrTempC,
    overheatMode,
    lastProfile,
    lastChangeMs,
    currentMs,
  } = ctx;

  // With a full bank in Float, `BatteryChargingStatus` can flicker as the XW+
  // cycles its charge controller. Tolerate those flickers when SoC is high so
  // we do not trip to Standby every time the charger blips. Low SoC still
  // enforces the strict gate because there is no solar/battery headroom to
  // justify running miners unless the charger is genuinely active.
  const chargerEffective = charging || (Number.isFinite(soc) && soc >= 95);
  if (!chargerEffective && !CFG.allowMiningWithoutCharger) {
    return { profile: 'Standby', reason: 'charger_inactive' };
  }
  if (!Number.isFinite(soc) || soc <= CFG.standbyHardLowSoc) {
    return { profile: 'Standby', reason: 'soc_hard_low' };
  }
  if (soc < CFG.standbyLowSoc) {
    return { profile: 'Standby', reason: 'soc_low' };
  }
  if (slope15m <= CFG.standbySlope15mThreshold && slope15mSustainMinutes >= CFG.standbySlopeSustainMinutes) {
    return { profile: 'Standby', reason: 'irradiance_drop_sustained' };
  }

  let target = pickProfileByResidual(residualWatts, soc);
  const reason = target === 'Standby' ? 'insufficient_residual' : 'residual_band';

  // Hysteresis + dwell run first so normal thrash-prevention applies within
  // the residual-chosen target. Thermal always runs last so it can override
  // both guards — safety beats anti-thrash.
  target = applyHysteresis(target, lastProfile, residualWatts);
  target = applyDwell(target, lastProfile, lastChangeMs, currentMs);
  target = applyThermal(target, asicTempC, vrTempC, overheatMode);

  return { profile: target, reason };
}

function profileSpec(name) {
  if (name === 'Standby') return { name: 'Standby', frequency: 0, coreVoltage: 0, watts: 0 };
  const p = PROFILES.find(x => x.name === name);
  return p || { name: 'Standby', frequency: 0, coreVoltage: 0, watts: 0 };
}

function updateProfileHistory(profile) {
  const key = 'bitaxeProfileHistory';
  const ts = nowMs();
  const cutoff = ts - (CFG.metricsWindowHours * 3600 * 1000);
  let history = cache.private.get(key) || [];
  history = history.filter(e => e.ts >= cutoff);
  const last = history.length ? history[history.length - 1] : null;
  if (!last || last.profile !== profile) {
    history.push({ ts, profile });
  }
  cache.private.put(key, history);
  return history;
}

function computeProfileMetrics(history, currentProfile) {
  const now = nowMs();
  const windowStart = now - (CFG.metricsWindowHours * 3600 * 1000);
  const totals = {};
  PROFILE_NAMES.forEach(n => { totals[n] = 0; });

  if (!history.length) {
    return { changeCount: 0, dwellMinutes: 0, pct: totals };
  }

  const entries = history.slice();
  if (entries[0].ts > windowStart) {
    entries.unshift({ ts: windowStart, profile: entries[0].profile });
  }

  for (let i = 0; i < entries.length; i += 1) {
    const cur = entries[i];
    const end = (i + 1 < entries.length) ? entries[i + 1].ts : now;
    const durMs = Math.max(0, end - cur.ts);
    if (totals[cur.profile] != null) totals[cur.profile] += durMs;
  }

  const totalMs = CFG.metricsWindowHours * 3600 * 1000;
  const pct = {};
  PROFILE_NAMES.forEach(n => { pct[n] = (totals[n] / totalMs) * 100; });

  const changeCount = Math.max(0, history.length - 1);
  const last = history[history.length - 1];
  const dwellMinutes = currentProfile === last.profile ? ((now - last.ts) / 60000.0) : 0;
  return { changeCount, dwellMinutes, pct };
}

function runDryPolicy() {
  const expectedPv = getNumericState(CFG.pvExpectedItem, NaN);
  const avalonModeDetail = getStringState(CFG.avalonModeDecisionItem, '');
  const avalonMode = parseAvalonMode(avalonModeDetail);
  const slope15m = getNumericState(CFG.irradianceSlope15mItem, 0);
  const soc = getEffectiveSoc();
  const charging = getBoolState(CFG.chargingItem, false);
  const asicTempC = getCelsiusState(CFG.bitaxeTempItem, NaN);
  const vrTempC = getCelsiusState(CFG.bitaxeVRTempItem, NaN);
  const overheatMode = getBoolState(CFG.bitaxeOverheatItem, false);

  if (!Number.isFinite(expectedPv) || !Number.isFinite(soc)) {
    post(itemName('DryRun_Status'), 'missing_inputs');
    return;
  }

  const availableWatts = Math.max(0, expectedPv - CFG.baselineHouseLoadWatts);
  const avalonWatts = avalonWattsForMode(avalonMode);
  const residualWatts = availableWatts - avalonWatts;
  const slope15mSustainMinutes = updateNegativeSlopeSustain(slope15m);

  const currentMs = nowMs();
  const lastDecision = cache.private.get('bitaxeLastDecision') || {};
  const decision = decideProfile({
    soc,
    charging,
    residualWatts,
    slope15m,
    slope15mSustainMinutes,
    asicTempC,
    vrTempC,
    overheatMode,
    lastProfile: lastDecision.profile || null,
    lastChangeMs: lastDecision.changedAtMs || null,
    currentMs,
  });

  const spec = profileSpec(decision.profile);
  const isChange = decision.profile !== (lastDecision.profile || null);
  const changedAtMs = isChange ? currentMs : (lastDecision.changedAtMs || currentMs);
  cache.private.put('bitaxeLastDecision', { profile: decision.profile, changedAtMs });

  const history = updateProfileHistory(decision.profile);
  const metrics = computeProfileMetrics(history, decision.profile);

  post(itemName('DryRun_Profile'), decision.profile);
  post(itemName('DryRun_TargetFrequency'), spec.frequency);
  post(itemName('DryRun_TargetVoltage'), spec.coreVoltage);
  post(itemName('DryRun_ProfilePower'), spec.watts);
  post(itemName('DryRun_ResidualWatts'), Math.round(residualWatts));
  post(itemName('DryRun_AvalonModeWatts'), avalonWatts);
  post(itemName('DryRun_ModeChanges_24h'), metrics.changeCount);
  post(itemName('DryRun_DwellTime_Current'), `${metrics.dwellMinutes.toFixed(1)} min`);
  post(itemName('DryRun_Min_Pct_24h'), (metrics.pct.Min || 0).toFixed(1));
  post(itemName('DryRun_Low_Pct_24h'), (metrics.pct.Low || 0).toFixed(1));
  post(itemName('DryRun_Stock_Pct_24h'), (metrics.pct.Stock || 0).toFixed(1));
  post(itemName('DryRun_Mid_Pct_24h'), (metrics.pct.Mid || 0).toFixed(1));
  post(itemName('DryRun_High_Pct_24h'), (metrics.pct.High || 0).toFixed(1));
  post(itemName('DryRun_Max_Pct_24h'), (metrics.pct.Max || 0).toFixed(1));
  post(itemName('DryRun_Standby_Pct_24h'), (metrics.pct.Standby || 0).toFixed(1));

  const detail = [
    `profile=${decision.profile}`,
    `reason=${decision.reason}`,
    `freq=${spec.frequency}`,
    `volt=${spec.coreVoltage}`,
    `wexp=${spec.watts}`,
    `avalon=${avalonMode}`,
    `aw=${avalonWatts}`,
    `avail=${Math.round(availableWatts)}`,
    `resid=${Math.round(residualWatts)}`,
    `s15=${slope15m.toFixed(1)}`,
    `s15hold=${slope15mSustainMinutes.toFixed(1)}m`,
    `soc=${soc.toFixed(1)}`,
    `chg=${charging}`,
    `tasic=${Number.isFinite(asicTempC) ? asicTempC.toFixed(1) + 'C' : 'n/a'}`,
    `tvr=${Number.isFinite(vrTempC) ? vrTempC.toFixed(1) + 'C' : 'n/a'}`,
    `oh=${overheatMode}`,
    `chg24=${metrics.changeCount}`,
    `dwell=${metrics.dwellMinutes.toFixed(1)}m`,
  ].join(',');

  post(itemName('DryRun_ModeDecision'), detail);
  // Policy status reflects whether the live controller will act on this
  // decision. The decision itself is computed regardless of LoadMgmt state.
  const liveOn = getBoolState(`${CFG.prefix}LoadManagement_Enable`, false);
  post(itemName('DryRun_Status'), liveOn ? 'policy-active-live-control' : 'policy-active-observation');
  post(itemName('LoadDecision'), `${liveOn ? 'live-policy' : 'observation'}:${detail}`);

  console.info(`Bitaxe dry-run decision: ${detail}`);
}


runDryPolicy();
