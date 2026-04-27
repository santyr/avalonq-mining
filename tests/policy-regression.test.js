const assert = require('assert');
const Module = require('module');
const originalRequire = Module.prototype.require;

function installOpenhabStub(states = {}) {
  global.cache = {
    private: {
      _data: new Map(),
      get(k) { return this._data.get(k); },
      put(k, v) { this._data.set(k, v); },
      remove(k) { this._data.delete(k); },
    },
  };
  Module.prototype.require = function patchedRequire(name) {
    if (name === 'openhab') {
      return {
        items: {
          getItem(itemName) {
            return {
              state: Object.prototype.hasOwnProperty.call(states, itemName) ? states[itemName] : 'NULL',
              postUpdate(value) { states[itemName] = String(value); },
            };
          },
        },
      };
    }
    return originalRequire.apply(this, arguments);
  };
}

function loadFresh(path, states = {}) {
  installOpenhabStub(states);
  delete require.cache[require.resolve(path)];
  return require(path);
}

function testAvalonHighSocDoesNotEcoBelowEcoHeadroom() {
  const avalon = loadFresh('../openhab/examples/avalonq-dryrun-policy-core.js');
  assert.strictEqual(typeof avalon.decideMode, 'function', 'Avalon core must export decideMode for regression tests');
  const decision = avalon.decideMode({
    soc: 100,
    charging: false,
    chargerStage: 'Float',
    availableWatts: 625,
    slope15m: -7,
    slope15mSustainMinutes: 0,
    previousMode: 'Eco',
    previousDwellMinutes: 60,
  });
  assert.deepStrictEqual(decision, { mode: 'Standby', reason: 'insufficient_margin' });
}

function testAvalonHighSocChoosesEcoOnlyWhenEcoFits() {
  const avalon = loadFresh('../openhab/examples/avalonq-dryrun-policy-core.js');
  const decision = avalon.decideMode({
    soc: 100,
    charging: false,
    chargerStage: 'Float',
    availableWatts: 950,
    slope15m: -7,
    slope15mSustainMinutes: 0,
    previousMode: 'Standby',
    previousDwellMinutes: 60,
  });
  assert.deepStrictEqual(decision, { mode: 'Eco', reason: 'high_soc_dump_load' });
}

function testAvalonDoesNotEnterEcoAtBareThresholdFromStandby() {
  const avalon = loadFresh('../openhab/examples/avalonq-dryrun-policy-core.js');
  const decision = avalon.decideMode({
    soc: 100,
    charging: false,
    chargerStage: 'Float',
    availableWatts: 801,
    slope15m: -20,
    slope15mSustainMinutes: 0,
    previousMode: 'Standby',
    previousDwellMinutes: 60,
  });
  assert.deepStrictEqual(decision, { mode: 'Standby', reason: 'insufficient_margin' });
}

function testAvalonHoldsEcoThroughShortCloudDip() {
  const avalon = loadFresh('../openhab/examples/avalonq-dryrun-policy-core.js');
  const decision = avalon.decideMode({
    soc: 100,
    charging: false,
    chargerStage: 'Float',
    availableWatts: 584,
    slope15m: 16,
    slope15mSustainMinutes: 0,
    previousMode: 'Eco',
    previousDwellMinutes: 5,
  });
  assert.deepStrictEqual(decision, { mode: 'Eco', reason: 'eco_min_dwell' });
}

function testBitaxeUsesEffectiveAvalonWattsWhenAvalonLiveDisabled() {
  const bitaxe = loadFresh('../openhab/examples/bitaxe-residual-policy-core.js');
  assert.strictEqual(typeof bitaxe.effectiveAvalonWatts, 'function', 'Bitaxe core must export effectiveAvalonWatts');
  const watts = bitaxe.effectiveAvalonWatts('Eco', false);
  assert.strictEqual(watts, 0);
}

function testBitaxeKeepsPlannedResidualSeparateFromRealResidual() {
  const bitaxe = loadFresh('../openhab/examples/bitaxe-residual-policy-core.js');
  assert.strictEqual(typeof bitaxe.computeResiduals, 'function', 'Bitaxe core must export computeResiduals');
  const r = bitaxe.computeResiduals({ expectedPv: 934, avalonMode: 'Eco', avalonLiveEnabled: false });
  assert.strictEqual(r.siteHeadroomWatts, 634);
  assert.strictEqual(r.avalonPlannedWatts, 800);
  assert.strictEqual(r.avalonEffectiveWatts, 0);
  assert.strictEqual(r.residualAfterPlannedAvalonWatts, -166);
  assert.strictEqual(r.residualAfterEffectiveAvalonWatts, 634);
}

const tests = [
  testAvalonHighSocDoesNotEcoBelowEcoHeadroom,
  testAvalonHighSocChoosesEcoOnlyWhenEcoFits,
  testAvalonDoesNotEnterEcoAtBareThresholdFromStandby,
  testAvalonHoldsEcoThroughShortCloudDip,
  testBitaxeUsesEffectiveAvalonWattsWhenAvalonLiveDisabled,
  testBitaxeKeepsPlannedResidualSeparateFromRealResidual,
];

for (const test of tests) {
  test();
  console.log(`ok ${test.name}`);
}

Module.prototype.require = originalRequire;
