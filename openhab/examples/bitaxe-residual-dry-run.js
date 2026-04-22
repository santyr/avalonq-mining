/*
 * Bitaxe Gamma residual-watts dry-run control rule for openHAB.
 *
 * Canonical source of policy logic:
 * openhab/examples/bitaxe-residual-policy-core.js
 */

const { rules, triggers } = require('openhab');
const { CFG, runDryPolicy } = require('./bitaxe-residual-policy-core');

rules.JSRule({
  name: 'Bitaxe Residual Dry Run',
  description: 'Dry-run only. Computes intended Bitaxe profile from the residual watts after the Avalon mode, SoC, irradiance slope, and ASIC temp. Never sends miner commands.',
  triggers: [
    triggers.ItemStateChangeTrigger(CFG.pvExpectedItem),
    triggers.GenericCronTrigger('0 */5 * * * ?'),
  ],
  execute: () => {
    try {
      runDryPolicy();
    } catch (e) {
      console.warn(`Bitaxe residual dry-run failed: ${e}`);
    }
  },
});
