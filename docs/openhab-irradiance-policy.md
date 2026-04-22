# Irradiance-aware Avalon policy notes for the current openHAB model

This note maps the suggested irradiance-aware control policy onto the actual items currently present in the live openHAB instance.

## Matching live items found

Leading indicator / irradiance input:
- `AmbientWeatherWS2902A_SolarRadiation`
  - type: `Number:Intensity`
  - example state observed: `190.84 W/m²`

Actual PV production:
- `PV_Power`
  - type: `Number`
  - example state observed: `691`

Battery stored-energy input:
- `BatterySoC_Calculated`
  - current SoC item already used elsewhere

Charger / charging context:
- `BatteryChargingStatus`
- `ChargerStatus`

Useful related electrical items:
- `DCData_Voltage`
- `DCData_Current`
- `PV_Current`
- `PV_Voltage`

## No direct panel-temperature item found

I did not find a clear panel-temperature item in the current openHAB model.

That means the proposed expected-PV equation cannot yet use a trustworthy panel-temperature correction term from live data.

For now, the practical approach is:
- first-pass expected PV can be based on irradiance alone
- optionally add a simple future proxy if you later introduce a real panel/backsheet temperature sensor
- do not silently substitute unrelated temperatures and pretend they are panel temperature

Candidate ambient weather temperatures that exist but should not be treated as panel temperature unless you explicitly choose to use them as a rough proxy:
- `AmbientWeatherWS2902A_WeatherDataWs2902a_Temperature`
- `AmbientWeatherWS2902A_WH31E_193_Temperature`

## Placeholder Avalon items added in openHAB

To support this future policy, these placeholder Avalon items were created:
- `AvalonQ_Miner1_SolarIrradiance`
- `AvalonQ_Miner1_SolarIrradiance_5minAvg`
- `AvalonQ_Miner1_SolarIrradiance_Slope`
- `AvalonQ_Miner1_PV_Expected_Watts`
- `AvalonQ_Miner1_PV_Actual_Watts`
- `AvalonQ_Miner1_PV_Curtailment_Ratio`
- `AvalonQ_Miner1_DryRun_ModeDecision`
- `AvalonQ_Miner1_DryRun_Status`

These are scaffold items only right now.

## Real dry-run rule added in openHAB and enabled

A real dry-run rule is now present in the live system:
- `hex_avalonq_irradiance_dry_run`
- name: `AvalonQ Irradiance Dry Run`

Important properties:
- contains the actual first-pass irradiance-aware decision logic
- uses `AmbientWeatherWS2902A_WeatherDataWs2902a_Temperature` as the ambient input to an explicit NOCT cell-temperature estimate
- updates the Avalon dry-run items and logs intended mode decisions
- never sends miner commands
- is now enabled in openHAB because it is dry-run only and safe before hardware arrival
- keeps dry-run charger gating aligned with the live control policy
- updates its cache-backed irradiance series only on irradiance changes and the periodic cron tick, reducing read-modify-write races from unrelated triggers
- uses least-squares slope calculations over the full sample window instead of only first/last endpoints
- now has a canonical shared source file in the repo: `openhab/examples/avalonq-dryrun-policy-core.js`

## Recommended mapping for the eventual dry-run/live policy

Use these live items as the main inputs:
- irradiance: `AmbientWeatherWS2902A_SolarRadiation`
- actual PV watts: `PV_Power`
- battery SoC: `BatterySoC_Calculated`
- charging state: `BatteryChargingStatus`
- low-voltage guardrail: `DCData_Voltage`

Derived Avalon items should be updated as follows:
- `AvalonQ_Miner1_SolarIrradiance` <= mirror `AmbientWeatherWS2902A_SolarRadiation`
- `AvalonQ_Miner1_SolarIrradiance_5minAvg` <= smoothed irradiance
- `AvalonQ_Miner1_SolarIrradiance_Slope` <= irradiance slope in W/m²/min
- `AvalonQ_Miner1_PV_Actual_Watts` <= mirror `PV_Power`
- `AvalonQ_Miner1_PV_Expected_Watts` <= irradiance-based estimate
- `AvalonQ_Miner1_PV_Curtailment_Ratio` <= actual / expected when expected > 0
- `AvalonQ_Miner1_DryRun_ModeDecision` <= dry-run output string
- `AvalonQ_Miner1_DryRun_Status` <= dry-run state / notes

## Policy adjustments for this site

Given the current constraints:
- 15A circuit
- no Super mode for now
- preference for standby via API rather than hard power-off

The control policy should remain constrained to:
- `Eco`
- `Standard`
- `Standby`

Do not auto-select `Super` in the first live version.

## Interpretation of the external feedback in this environment

The feedback is directionally good and matches the actual system shape well:
- irradiance is available right now via Ambient Weather
- PV output is available right now via `PV_Power`
- SoC is available right now via `BatterySoC_Calculated`

So the major pieces for an irradiance-aware dry-run policy already exist.

The one obvious missing input is a real panel-temperature sensor.

## Practical next step when you want to activate dry-run

When you want this live in dry-run mode, the next implementation should:
1. mirror irradiance and PV actual power into the Avalon placeholder items
2. compute a 5-minute irradiance average
3. compute irradiance slope
4. compute a first-pass expected PV value
5. write intended mode changes to `AvalonQ_Miner1_DryRun_ModeDecision`
6. log only; do not send Avalon API commands yet

That will let you field-test threshold logic before the miner arrives.
