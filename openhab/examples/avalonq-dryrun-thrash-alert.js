const enterThreshold = 12;
const clearThreshold = 8;
const recoveryDwellMinutes = 60;

function parseKeyValueDetail(detail) {
  const out = {};
  String(detail || '').split(',').forEach(part => {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.substring(0, idx)] = part.substring(idx + 1);
  });
  return out;
}

function numericState(itemName) {
  try {
    const n = parseFloat(String(items.getItem(itemName).state));
    return Number.isFinite(n) ? n : NaN;
  } catch (e) {
    return NaN;
  }
}

const changes = numericState('AvalonQ_Miner1_DryRun_ModeChanges_24h');
const decisionDetail = (() => {
  try { return String(items.getItem('AvalonQ_Miner1_DryRun_ModeDecision').state); } catch (e) { return ''; }
})();
const decision = parseKeyValueDetail(decisionDetail);
const dwellMinutes = parseFloat(String(decision.dwell || '').replace('m', ''));
const recovered = Number.isFinite(dwellMinutes) && dwellMinutes >= recoveryDwellMinutes;
const alertItem = items.getItem('AvalonQ_Miner1_DryRun_ThrashAlert');
const prev = String(alertItem.state);

// A 24h change count intentionally decays slowly, but the operator-facing
// alert should mean "thrashing now", not "there was thrash earlier today".
// Clear once the current mode has been stable for an hour even if the 24h
// counter is still above the normal hysteresis clear threshold.
if (recovered) {
  if (prev !== 'normal') alertItem.postUpdate('normal');
  console.info(`AvalonQ dry-run thrash alert recovered: changes=${Number.isFinite(changes) ? changes : 'n/a'}, dwell=${dwellMinutes.toFixed(1)}m, recovery>=${recoveryDwellMinutes}m`);
} else if (Number.isFinite(changes) && changes > enterThreshold) {
  if (prev !== 'thrash') alertItem.postUpdate('thrash');
  console.warn(`AvalonQ dry-run thrash alert active: changes=${changes}, dwell=${Number.isFinite(dwellMinutes) ? dwellMinutes.toFixed(1) + 'm' : 'n/a'}, enter>${enterThreshold}, clear<${clearThreshold}`);
} else if (!Number.isFinite(changes) || changes < clearThreshold) {
  if (prev !== 'normal') alertItem.postUpdate('normal');
  console.info(`AvalonQ dry-run thrash alert normal: changes=${Number.isFinite(changes) ? changes : 'n/a'}, enter>${enterThreshold}, clear<${clearThreshold}`);
} else {
  console.info(`AvalonQ dry-run thrash alert hold: changes=${changes}, dwell=${Number.isFinite(dwellMinutes) ? dwellMinutes.toFixed(1) + 'm' : 'n/a'}, state=${prev}, enter>${enterThreshold}, clear<${clearThreshold}`);
}
