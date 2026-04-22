/*
 * Intelligent Bitaxe (and site-wide) voltage-protection controller.
 *
 * Replaces the legacy single-signal `Miner Voltage Protection` rule
 * (9d925dea3c). Adds:
 *   - two-stage response: soft-drop to Min via API, then relay-off
 *   - SoC-aware delay (critical SoC shortens the countdown)
 *   - charger-stage awareness in the log strings for forensics
 *   - coordinated recovery: relay on -> wait for boot -> re-enable LoadMgmt
 *
 * This script is used as the inline ScriptAction body of a REST-managed rule.
 * Triggers:
 *   - ItemStateChangeTrigger: DCData_Voltage
 *
 * Coupling note: `Miner_Power` powers the Bitaxe. Cutting it kills the only
 * active miner on the bank, so the soft path is tried first whenever
 * voltage margin allows. Hard relay-off is a last-resort below the
 * hard-low threshold.
 */

const { items } = require('openhab');

const CFG = {
  voltageItem: 'DCData_Voltage',
  socItem: 'BatterySoC_Calculated',
  chargerStageItem: 'ChargerStatus',
  chargingItem: 'BatteryChargingStatus',
  powerRelayItem: 'Miner_Power',
  profileSetItem: 'Bitaxe_Gamma1_Profile_Set',
  loadMgmtItem: 'Bitaxe_Gamma1_LoadManagement_Enable',
  loadDecisionItem: 'Bitaxe_Gamma1_LoadDecision',

  // AGM-REGIME thresholds (conservative). The Fullriver DC400-6 bank is at
  // end-of-life: 4 of 16 cells failed, ~50-60% usable capacity, cannot tolerate
  // deep discharge or high charge voltage. Owner's stated shallow discharge
  // floor is ~50.2 V. See https://github.com/santyr/Solar_PV.
  //
  // Post-LFP-upgrade target values (Q2 2026, after Discover AES install):
  //   softLowVolts: 49.0, hardLowVolts: 47.0, recoveryVolts: 50.0
  //
  // Stage 1 (soft): drop Bitaxe to Min via the live controller.
  softLowVolts: 51.5,
  softDelayNormalS: 30,
  softDelayCriticalS: 10,

  // Stage 2 (hard): kill the relay outright.
  hardLowVolts: 50.2,
  hardDelayNormalS: 60,
  hardDelayCriticalS: 20,

  // Recovery: both stages release once voltage climbs above this.
  recoveryVolts: 53.0,
  // After relay-on, wait this long for the Bitaxe to boot before re-enabling
  // live load management (otherwise the live controller PATCHes a booting
  // device and hits connection errors).
  bootDelaySeconds: 30,

  // "Critical" SoC shortens both delays. The AGM bank supporting a Bitaxe
  // plus house loads at 45% SoC is under much more stress than at 90%.
  criticalSocThreshold: 50,
};

function getNumber(name, fb = NaN) {
  try { const n = parseFloat(String(items.getItem(name).state)); return Number.isFinite(n) ? n : fb; }
  catch (e) { return fb; }
}
function getString(name, fb = '') {
  try { return String(items.getItem(name).state); } catch (e) { return fb; }
}
function sendCmd(name, value) {
  try { items.getItem(name).sendCommand(String(value)); }
  catch (e) { console.warn(`voltage-protect sendCommand ${name} failed: ${e}`); }
}
function post(name, value) {
  try { items.getItem(name).postUpdate(String(value)); }
  catch (e) { console.warn(`voltage-protect postUpdate ${name} failed: ${e}`); }
}

function clearTimerKey(key) {
  const t = cache.private.get(key);
  if (t) { try { clearTimeout(t); } catch (e) {} cache.private.remove(key); }
}

function main() {
  const v = getNumber(CFG.voltageItem);
  if (!Number.isFinite(v)) return;

  const soc = getNumber(CFG.socItem, 100);
  const chargerStage = getString(CFG.chargerStageItem, 'unknown');
  const relayState = getString(CFG.powerRelayItem, 'UNKNOWN');
  const critical = soc < CFG.criticalSocThreshold;
  const softDelay = (critical ? CFG.softDelayCriticalS : CFG.softDelayNormalS) * 1000;
  const hardDelay = (critical ? CFG.hardDelayCriticalS : CFG.hardDelayNormalS) * 1000;
  const tag = `v=${v.toFixed(2)}V,soc=${soc.toFixed(1)}%,stage=${chargerStage}${critical ? ',crit' : ''}`;

  // Hard path: arm relay-off timer when voltage is at/below the hard limit.
  if (v <= CFG.hardLowVolts) {
    if (!cache.private.get('hardTimer') && relayState === 'ON') {
      post(CFG.loadDecisionItem, `vp_hard_pending:${tag}`);
      cache.private.put('hardTimer', setTimeout(() => {
        cache.private.remove('hardTimer');
        const currentV = getNumber(CFG.voltageItem);
        if (Number.isFinite(currentV) && currentV <= CFG.hardLowVolts) {
          sendCmd(CFG.loadMgmtItem, 'OFF');  // prevent live controller retry
          sendCmd(CFG.powerRelayItem, 'OFF');
          post(CFG.loadDecisionItem, `vp_hard_cut:${tag}`);
          console.warn(`voltage-protect: relay OFF at ${currentV}V`);
        }
      }, hardDelay));
    }
  } else {
    clearTimerKey('hardTimer');
  }

  // Soft path: arm the Min-profile throttle when voltage is in the warning
  // band. Soft path is skipped once the relay is already OFF (no API path).
  if (v <= CFG.softLowVolts && relayState === 'ON') {
    if (!cache.private.get('softTimer') && !cache.private.get('softApplied')) {
      post(CFG.loadDecisionItem, `vp_soft_pending:${tag}`);
      cache.private.put('softTimer', setTimeout(() => {
        cache.private.remove('softTimer');
        const currentV = getNumber(CFG.voltageItem);
        if (Number.isFinite(currentV) && currentV <= CFG.softLowVolts) {
          sendCmd(CFG.profileSetItem, 'Min');
          cache.private.put('softApplied', true);
          post(CFG.loadDecisionItem, `vp_soft_min:${tag}`);
          console.warn(`voltage-protect: Bitaxe -> Min at ${currentV}V`);
        }
      }, softDelay));
    }
  } else if (v > CFG.softLowVolts) {
    clearTimerKey('softTimer');
  }

  // Recovery: cancel pending timers and restore normal operation once
  // voltage is comfortably above the recovery threshold.
  if (v >= CFG.recoveryVolts) {
    clearTimerKey('softTimer');
    clearTimerKey('hardTimer');
    if (relayState === 'OFF') {
      sendCmd(CFG.powerRelayItem, 'ON');
      post(CFG.loadDecisionItem, `vp_recover_relay_on:${tag}`);
      // Delay load-mgmt re-enable until the Bitaxe finishes booting.
      setTimeout(() => {
        sendCmd(CFG.loadMgmtItem, 'ON');
        post(CFG.loadDecisionItem, `vp_recover_loadmgmt_on:${tag}`);
      }, CFG.bootDelaySeconds * 1000);
    } else if (cache.private.get('softApplied')) {
      // Soft throttle was applied but relay is still on. The live controller
      // resumes the policy's target profile on the next dry-run tick; just
      // clear our marker so we don't stay stuck at Min.
      cache.private.remove('softApplied');
      post(CFG.loadDecisionItem, `vp_recover_soft_release:${tag}`);
    }
  }
}

main();
