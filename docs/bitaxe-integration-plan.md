# Bitaxe Gamma integration plan

This note describes how the Bitaxe Gamma (BM1370 ASIC, AxeOS firmware, ESP32-S3 controller) fits next to the existing Avalon Q integration on the off-grid Earthship site.

## Why add the Bitaxe

The Avalon Q is a coarse dump load. It has three quantized modes at roughly 800 W, 1300 W, and 1674 W. Super is disabled by project policy while the site runs on a 15 A circuit.

The Bitaxe is a fine-grain dump load. Its entire operating envelope is roughly 13 W to 25 W and it is continuously variable via PATCH to frequency and core voltage. That lets us trim the residual wattage above or below the Avalon's current mode step without touching the Avalon.

Together the two miners form a coarse+fine dump-load pair:
- Avalon Q picks the coarse step: Standby, Eco, or Standard.
- Bitaxe picks a fine profile: Standby, Min, Low, Stock, Mid, High, or Max.

## Control philosophy

Same guardrails as the Avalon side:
- dry-run before live
- standby over hard power-off
- voltage and SoC guardrails
- no automatic miner commands until the Bitaxe commissioning checklist has been walked
- load-management automation gated behind `Bitaxe_Gamma1_LoadManagement_Enable`, defaulting OFF

The Bitaxe residual policy is additive to the Avalon policy. The Avalon policy runs first and selects its mode. The Bitaxe policy reads the Avalon's intended mode from `AvalonQ_Miner1_DryRun_ModeDecision` and computes:

```
available_watts = max(0, PV_Expected_Watts - baselineHouseLoadWatts)
avalon_watts    = avalonModeWatts(AvalonQ mode)   // Standard=1300, Eco=800, Standby=0
residual_watts  = available_watts - avalon_watts
```

A positive residual means there is headroom above what the Avalon is currently asking for. A negative residual means the Avalon is already overcommitted relative to available PV and the Bitaxe should back off.

## Voltage/frequency pairing

Frequency and core voltage are not independent. Higher frequency needs more voltage to stay stable. Running over-frequency under-voltage produces hardware errors, which appear in `errorPercentage` and rejected shares.

The default table baked into `bitaxe.js` and `bitaxe-residual-policy-core.js`:

| Profile | Frequency (MHz) | Core Voltage (mV) | Expected Power (W) | Expected Hashrate (GH/s) |
|---------|-----------------|-------------------|--------------------|--------------------------|
| Min     | 400             | 1100              | 13                 | 900                      |
| Low     | 450             | 1150              | 15                 | 1000                     |
| Stock   | 490             | 1200              | 18                 | 1100                     |
| Mid     | 525             | 1200              | 20                 | 1150                     |
| High    | 550             | 1250              | 22                 | 1250                     |
| Max     | 575             | 1300              | 25                 | 1400                     |

Source: default starting table for the BM1370 profile shape. The runtime source of truth is the `/api/system/asic` endpoint, which returns `frequencyOptions` and `voltageOptions` arrays that the miner accepts. `setFrequencyVoltage()` in `bitaxe.js` validates any requested pair against those cached options and rejects anything not present. If the live device disagrees with the default table, the live options win.

## Safety invariants

1. `setFrequencyVoltage()` always sets `overclockEnabled: 1` in the PATCH body and always writes both `frequency` and `coreVoltage`. Writing one without the other can leave the device in a mismatched state.
2. Frequency and voltage must appear in the cached options from `/api/system/asic`. The default table is only a fallback when the slow poll has not yet populated the cache.
3. The policy respects the Bitaxe's configured `temptarget` indirectly by watching `temp` in the dry run and downshifting or dropping to Standby before the device hits its own protection.
4. `overheat_mode` in `/api/system/info` forces Standby in the dry-run policy. The live AxeOS firmware also self-throttles at this point; the rule is belt-and-suspenders.
5. Pool and stratum settings are operator-managed. The `httpPatch()` helper in `bitaxe.js` refuses any PATCH body that mentions `stratum` so a future caller cannot rewrite mining credentials from a rule.

## SoC thresholds

Reused from the Avalon policy intent to keep the two miners coherent.

- `standbyHardLowSoc` = 40
- `standbyLowSoc`     = 50
- `minProfileMinSoc`  = 50
- `stockProfileMinSoc` = 65
- `highProfileMinSoc` = 80
- `maxProfileMinSoc`  = 90

The per-profile `minSoc` values encode the rule that higher power draw should only come online when the battery bank has enough state of charge to absorb any transient curtailment.

After the Discover LiFePO4 upgrade, revisit these values the same way the Avalon commissioning checklist prescribes.

## Hysteresis and thrash control

With six active profiles plus Standby, the Bitaxe has more step granularity than the Avalon. Naive residual-band gating would thrash on irradiance noise. Two guards:

- `minDwellMinutes` (default 5): after any profile change, further non-safety changes are blocked until the dwell elapses. Standby drops bypass this guard.
- `hysteresisWatts` (default 2): to step down a profile, the residual must fall below the previous profile's watts by at least this margin. Upgrades have no hysteresis.

## Interaction with the Avalon rule

The Bitaxe dry-run fires on:
- state change of `AvalonQ_Miner1_PV_Expected_Watts`
- a 5-minute cron

Both triggers are already the Avalon dry-run's primary signals. The Bitaxe rule does not trigger on irradiance directly; it rides the expected-PV output that the Avalon rule already computes. That keeps the two rules serialized and avoids duplicate irradiance sampling.

## Power relay

The Bitaxe's AC power is driven by the existing `Miner_Power` item in the live openHAB instance. That item predates the Avalon and Bitaxe integrations. Reusing it here avoids defining a duplicate relay. The `bitaxe-voltage-protection.js` rule drives the same relay on the hard-low-voltage path. The legacy `Miner Voltage Protection` rule still exists in the live instance and also acts on `Miner_Power`; both rules observe the same DC voltage input, so coexistence is safe for the current guardrail surface. Consolidate long-term once commissioning is done.

## File layout

New files under `openhab/examples/`:
- `bitaxe.items` — item scaffold
- `bitaxe.js` — polling plus manual command rules, load-management gated
- `bitaxe-voltage-protection.js` — soft-drop to Min, hard-drop relay OFF
- `bitaxe-residual-policy-core.js` — canonical shared policy source
- `bitaxe-residual-dry-run.js` — file-based JSRule wrapper
- `bitaxe-residual-dry-run-action.js` — generated inline body for the REST-managed rule

## Not in scope for this pass

- Braiins pool integration for realized sats-per-kWh metrics.
- A Bitaxe-specific thrash-alert item parallel to the Avalon's `AvalonQ_Miner1_DryRun_ThrashAlert`.
- Any automation that rewrites pool or stratum settings.
- Any live PATCH before the commissioning checklist has been walked end to end.
