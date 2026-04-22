/*
 * Avalon Q irradiance-aware dry-run control rule for openHAB.
 *
 * Canonical source of policy logic:
 * openhab/examples/avalonq-dryrun-policy-core.js
 */

const { rules, triggers } = require('openhab');
const { CFG, runDryPolicy } = require('./avalonq-dryrun-policy-core');

rules.JSRule({
  name: 'AvalonQ Irradiance Dry Run',
  description: 'Dry-run only. Computes intended Avalon mode from irradiance, ambient temp, PV output, and SoC without sending miner commands.',
  triggers: [
    triggers.ItemStateChangeTrigger(CFG.irradianceItem),
    triggers.GenericCronTrigger('0 */5 * * * ?'),
  ],
  execute: () => {
    try {
      runDryPolicy();
    } catch (e) {
      console.warn(`AvalonQ irradiance dry-run failed: ${e}`);
    }
  },
});
