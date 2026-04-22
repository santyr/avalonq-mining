/*
 * Example openHAB JavaScript rule for Bitaxe Gamma low-voltage protection.
 *
 * Preferred behavior is to command the Bitaxe to the Min profile via the AxeOS
 * API (reduces from ~25 W peak to ~13 W). If voltage stays low beyond a
 * second threshold, the physical power relay is commanded OFF.
 *
 * Coupling note:
 * - The Bitaxe's AC power relay in this deployment is the existing
 *   `Miner_Power` item. That item predates this Bitaxe integration and is
 *   also the relay targeted by the legacy `Miner Voltage Protection` rule.
 *   Both rules will drive the same relay. Do not define a parallel
 *   `Bitaxe_Gamma1_PowerRelay_Set` here; the shared relay path is
 *   intentional.
 * - The legacy rule is not removed from the live openHAB instance because it
 *   is out of scope for this file-based example. Long-term the legacy rule
 *   should be retired once this Bitaxe rule and the Avalon rule together
 *   cover the same guardrail surface.
 *
 * Requires:
 * - bitaxe.js loaded and reachable in the same automation environment
 * - a DC battery voltage item in openHAB
 */

const { rules, triggers, items } = require('openhab');

const PROTECT = {
  voltageItem: 'DCData_Voltage',
  // Target the manual-profile string setpoint declared in bitaxe.items. That
  // setpoint goes through bitaxe.js and is still subject to the
  // `allowOverclock` gate, so live behavior is safe until the operator flips
  // load management on.
  profileItem: 'Bitaxe_Gamma1_Profile_Set',
  powerRelayItem: 'Miner_Power',
  loadDecisionItem: 'Bitaxe_Gamma1_LoadDecision',

  // First threshold: drop to the Min profile.
  softLowLimit: 50.0,
  // Second threshold: if still under, cut AC power to the Bitaxe.
  hardLowLimit: 48.5,
  recoveryLimit: 51.0,
  delaySeconds: 60,
};

function getNumber(name, fallback = NaN) {
  try {
    const n = parseFloat(String(items.getItem(name).state));
    return Number.isFinite(n) ? n : fallback;
  } catch (e) {
    return fallback;
  }
}

function send(name, value) {
  try {
    items.getItem(name).sendCommand(String(value));
  } catch (e) {
    console.warn(`Bitaxe voltage protection sendCommand failed for ${name}: ${e}`);
  }
}

function post(name, value) {
  try {
    items.getItem(name).postUpdate(String(value));
  } catch (e) {
    console.warn(`Bitaxe voltage protection postUpdate failed for ${name}: ${e}`);
  }
}

rules.JSRule({
  name: 'Bitaxe Voltage Protection',
  description: 'Drops Bitaxe to Min profile on sustained low battery voltage, then cuts relay on a harder threshold.',
  triggers: [triggers.ItemStateChangeTrigger(PROTECT.voltageItem)],
  execute: () => {
    const voltage = getNumber(PROTECT.voltageItem);
    if (!Number.isFinite(voltage)) return;

    const softTimer = cache.private.get('bitaxeSoftVoltageTimer');
    const hardTimer = cache.private.get('bitaxeHardVoltageTimer');

    if (voltage <= PROTECT.hardLowLimit) {
      if (!hardTimer) {
        post(PROTECT.loadDecisionItem, `hard_low_voltage_pending:${voltage}`);
        cache.private.put('bitaxeHardVoltageTimer', setTimeout(() => {
          const currentV = getNumber(PROTECT.voltageItem);
          if (Number.isFinite(currentV) && currentV <= PROTECT.hardLowLimit) {
            send(PROTECT.powerRelayItem, 'OFF');
            post(PROTECT.loadDecisionItem, `hard_low_voltage_relay_off:${currentV}`);
          }
          cache.private.remove('bitaxeHardVoltageTimer');
        }, PROTECT.delaySeconds * 1000));
      }
      return;
    }

    if (voltage <= PROTECT.softLowLimit) {
      if (!softTimer) {
        post(PROTECT.loadDecisionItem, `soft_low_voltage_pending:${voltage}`);
        cache.private.put('bitaxeSoftVoltageTimer', setTimeout(() => {
          const currentV = getNumber(PROTECT.voltageItem);
          if (Number.isFinite(currentV) && currentV <= PROTECT.softLowLimit) {
            send(PROTECT.profileItem, 'Min');
            post(PROTECT.loadDecisionItem, `soft_low_voltage_min_profile:${currentV}`);
          }
          cache.private.remove('bitaxeSoftVoltageTimer');
        }, PROTECT.delaySeconds * 1000));
      }
      return;
    }

    if (voltage > PROTECT.softLowLimit) {
      if (softTimer) {
        clearTimeout(softTimer);
        cache.private.remove('bitaxeSoftVoltageTimer');
      }
      if (hardTimer) {
        clearTimeout(hardTimer);
        cache.private.remove('bitaxeHardVoltageTimer');
      }
      if (voltage >= PROTECT.recoveryLimit) {
        send(PROTECT.powerRelayItem, 'ON');
        post(PROTECT.loadDecisionItem, `recovered:${voltage}`);
      }
    }
  },
});
