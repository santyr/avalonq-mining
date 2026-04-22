# Persistence and before/after battery-upgrade analysis

This note documents what to persist from the running Avalon dry-run model and how to use it for before/after analysis around the future Discover battery upgrade.

## Current live persistence situation

From the live openHAB instance:
- installed persistence add-on: `persistence-jdbc-postgresql`

So the simplest path is to persist the Avalon dry-run metrics into the existing PostgreSQL-backed persistence layer rather than introducing a second store.

## Why this matters

The dry-run rule is already producing the beginnings of a useful historical dataset:
- irradiance
- expected PV
- actual PV
- curtailment ratio
- effective SoC
- intended Avalon mode

This lets us quantify:
- how much solar is available for discretionary mining load
- how often the control policy would select Standby / Eco / Standard
- how much solar production is being curtailed before the battery upgrade
- how that curtailment changes after the Discover system is installed

That before/after comparison is especially valuable because it converts the degraded AGM bank problem into directly measurable lost harvest.

## Recommended items to persist

Highest priority Avalon dry-run items:
- `AvalonQ_Miner1_PV_Curtailment_Ratio`
- `AvalonQ_Miner1_PV_Expected_Watts`
- `AvalonQ_Miner1_PV_Actual_Watts`
- `AvalonQ_Miner1_SolarIrradiance`
- `AvalonQ_Miner1_SolarIrradiance_5minAvg`
- `AvalonQ_Miner1_SolarIrradiance_Slope_3min`
- `AvalonQ_Miner1_SolarIrradiance_Slope_15min`
- `AvalonQ_Miner1_Panel_CellTemp_Estimate`
- `AvalonQ_Miner1_SoC_Effective`
- `AvalonQ_Miner1_DryRun_ModeChanges_24h`
- `AvalonQ_Miner1_DryRun_Eco_Pct_24h`
- `AvalonQ_Miner1_DryRun_Standard_Pct_24h`
- `AvalonQ_Miner1_DryRun_Standby_Pct_24h`

Important upstream source items to persist alongside them:
- `AmbientWeatherWS2902A_SolarRadiation`
- `PV_Power`
- `BatterySoC_Calculated`
- `BatteryChargingStatus`
- `ChargerStatus`
- `DCData_Voltage`
- `DCData_Current`
- `PV_Current`
- `PV_Voltage`

Useful operational item to persist even though it is a String:
- `AvalonQ_Miner1_DryRun_ModeDecision`

Why keep the string item:
- it preserves the exact reason chosen by the dry-run rule
- it is helpful for event-style forensic review even if the numeric items are the main analysis source

## Recommended persistence strategy

Because the dry-run rule updates often, not every field needs the same persistence cadence.

Recommended split:

1. Persist every change for low-rate / state-like items:
- `AvalonQ_Miner1_DryRun_ModeDecision`
- `AvalonQ_Miner1_DryRun_Status`
- `BatteryChargingStatus`
- `ChargerStatus`

2. Persist every update or on a regular cadence for numeric analysis items:
- irradiance items
- expected/actual PV items
- curtailment ratio
- SoC effective
- DC voltage/current
- PV power/current/voltage

If the JDBC persistence config is currently broad and already storing these, keep it simple and reuse that. If it is selective, add the Avalon items explicitly.

## Recommended minimum SQL/JDBC retention mindset

If storage is not a concern, keep all raw samples during this pre-hardware and pre-upgrade period.

If you need to economize later:
- retain raw samples for at least the full pre-upgrade period plus some post-upgrade overlap
- do not downsample away the pre-upgrade curtailment evidence until after the battery-upgrade comparison has been completed

## Metrics to compare before vs after the Discover upgrade

These are the most useful comparison metrics.

### 1. PV curtailment ratio distribution

Primary item:
- `AvalonQ_Miner1_PV_Curtailment_Ratio`

Compare:
- median curtailment ratio during sun hours
- 90th percentile and 10th percentile
- fraction of time ratio is below thresholds like `0.8`, `0.6`, `0.4`

Interpretation:
- lower ratios before upgrade imply more curtailed harvest
- improvement after upgrade should show higher ratios during strong solar windows

### 2. Expected vs actual PV gap

Use:
- `AvalonQ_Miner1_PV_Expected_Watts`
- `AvalonQ_Miner1_PV_Actual_Watts`

Derived comparison:
- `Expected - Actual`

Interpretation:
- this is the instantaneous wattage left on the table
- integrate it over time to estimate lost kWh

### 3. Lost harvest estimate

For each sample interval:
- `lost_watts = max(0, expected - actual)`
- `lost_kwh += lost_watts * hours_elapsed / 1000`

Do this for:
- whole days
- clear-sky-ish windows
- high irradiance windows only, e.g. `irradiance_5min > 600 W/m²`

Interpretation:
- gives a concrete energy estimate of what the weak battery bank is preventing you from capturing

### 4. Mode allocation suitability

Use:
- `AvalonQ_Miner1_DryRun_Eco_Pct_24h`
- `AvalonQ_Miner1_DryRun_Standard_Pct_24h`
- `AvalonQ_Miner1_DryRun_Standby_Pct_24h`

Interpretation:
- shows whether the control policy is materially shifting toward more usable mining windows after the upgrade

### 5. Thrash / hysteresis quality

Use:
- `AvalonQ_Miner1_DryRun_ModeChanges_24h`

Interpretation:
- helps identify bad thresholds or weather-driven oscillation
- should remain bounded even as more solar becomes available

## High-value analysis windows

The best windows for comparing pre/post upgrade behavior are:
- clear mornings
- clear noon periods
- partly cloudy periods with fast ramps
- days where the battery reaches absorb/float early

Especially useful filter:
- irradiance high
- expected PV high
- actual PV significantly below expected

Those are the moments that most clearly show curtailment.

## Example current evidence

At one observed moment, the running dry-run model reported values like:
- irradiance about `577 W/m²`
- expected PV about `1924 W`
- actual PV about `1590 W`
- curtailment ratio about `0.83`

That is already the kind of evidence we want to accumulate systematically.

## SoC transition plan

Right now:
- `AvalonQ_Miner1_SoC_Effective` effectively reflects `BatterySoC_Calculated`

Future plan:
- when a Discover/BMS-backed SoC source exists, point the dry-run model at that preferred source
- keep persisting both the effective SoC and the legacy calculated SoC during the transition period

That enables:
- easier rule continuity
- direct comparison of legacy estimated SoC vs future BMS SoC

## Practical recommendation for openHAB configuration

When you touch persistence config next, make sure the following Avalon items are explicitly included if your JDBC strategy is selective:
- `AvalonQ_Miner1_*`

At minimum, explicitly include:
- `AvalonQ_Miner1_PV_Curtailment_Ratio`
- `AvalonQ_Miner1_PV_Expected_Watts`
- `AvalonQ_Miner1_PV_Actual_Watts`
- `AvalonQ_Miner1_SolarIrradiance_5minAvg`
- `AvalonQ_Miner1_SolarIrradiance_Slope_15min`
- `AvalonQ_Miner1_Panel_CellTemp_Estimate`
- `AvalonQ_Miner1_SoC_Effective`
- `AvalonQ_Miner1_DryRun_ModeDecision`

## What to do next

Recommended next operational step:
1. let the enabled dry-run rule collect data for at least several days
2. confirm the JDBC persistence config is actually storing the Avalon dry-run items
3. after enough samples accumulate, review:
   - curtailment ratio distribution
   - expected vs actual PV gap
   - mode allocation percentages
   - mode changes per day
4. after the Discover upgrade, repeat the same analysis and compare

That will give a quantitative before/after story for lost harvest and discretionary-load headroom.

## Bitaxe Gamma persistence additions

Once the Bitaxe integration is deployed, add the following items to the same JDBC persistence configuration so the same before/after analysis can include the fine-grain dump load.

Bitaxe live telemetry, persist on every update:
- `Bitaxe_Gamma1_Power` — actual wattage drawn by the Bitaxe; required to compute the realized fine-grain harvest contribution.
- `Bitaxe_Gamma1_Hashrate` — primary mining performance signal; pairs with power for efficiency tracking and detection of unstable frequency/voltage pairs.
- `Bitaxe_Gamma1_ASIC_Temp` — thermal trend; required to validate that the dry-run thermal guardrails (`thermalDownshiftC`, `thermalStandbyC`) are reasonable in this enclosure.
- `Bitaxe_Gamma1_ErrorPct` — leading indicator of an over-frequency / under-voltage pairing problem; persistence makes it possible to correlate error spikes with profile changes.
- `Bitaxe_Gamma1_Frequency` — applied target frequency at the device; needed to attribute power and hashrate to a specific profile.
- `Bitaxe_Gamma1_CoreVoltage` — applied target core voltage at the device; same attribution role as frequency.

Bitaxe dry-run state, persist on change:
- `Bitaxe_Gamma1_DryRun_ModeDecision` — the comma-separated detail string describing what the policy intended; preserves the reason at the moment of decision for forensic review.

Bitaxe profile allocation metrics, persist on every update:
- `Bitaxe_Gamma1_DryRun_Min_Pct_24h`
- `Bitaxe_Gamma1_DryRun_Stock_Pct_24h`
- `Bitaxe_Gamma1_DryRun_Max_Pct_24h`

These three are the most informative subset of the seven `DryRun_*_Pct_24h` items because they bracket the operating envelope (lowest, default, highest). Persist the others (`Low`, `Mid`, `High`, `Standby`) too if the JDBC budget allows; they are cheap and useful for the same coarse/fine before/after story the Avalon items already drive.

Why this set is the minimum:
- `Power` and `Hashrate` together let us compute realized J/TH for the Bitaxe and compare against the dry-run's expected `watts` per profile.
- `ASIC_Temp` and `ErrorPct` are the two signals that catch profile choices that look fine on paper but stress the hardware.
- `Frequency` and `CoreVoltage` make every other Bitaxe sample interpretable; without them you cannot tell which profile any given power/hashrate sample belongs to.
- `DryRun_ModeDecision` and the percentage-allocation items mirror what the Avalon analysis already relies on, so the same scripts and dashboards generalize naturally to the Bitaxe.
