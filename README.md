# avalonq-mining

Repo for the off-grid Earthship mining setup.

Currently running:
- a **Bitaxe Gamma** (BM1370 / AxeOS v2.13.1) live at `192.168.1.39`, fully managed by openHAB
- placeholder integration for an **Avalon Q** that will deploy when hardware arrives

## Site context

- 4.2 kW PV array, AGM bank (Discover LiFePO4 upgrade pending)
- Schneider Conext **XW6848-21** inverter (6.8 kW continuous)
- 20A circuit on the future Avalon mining branch
- openHAB at `http://192.168.1.161:8080`

## Current state

### Bitaxe — live

- Polled every 15 s (`hex_bitaxe_fast_poll`) and 5 min (`hex_bitaxe_slow_poll`)
- Profile selected by `hex_bitaxe_residual_dry_run` from PV residual (after the Avalon mode), SoC, irradiance trend, ASIC + VR temps
- Profile applied by `hex_bitaxe_live_profile` (PATCH `/api/system` with `overclockEnabled: 1, frequency, coreVoltage`); gated on `Bitaxe_Gamma1_LoadManagement_Enable`
- Two-stage voltage protection (`hex_bitaxe_voltage_protection`): 50.0 V soft drops to Min profile via API; 48.5 V hard cuts the relay; SoC-aware delays
- Legacy `Miner Voltage Protection` (uid `9d925dea3c`) is disabled
- Default automatic ceiling is **High** (550 MHz / 1200 mV / ~20 W); Max (550 / 1250 / ~23 W) is reachable only via manual `Bitaxe_Gamma1_Profile_Set`

### Avalon Q — dry-run only

- Hardware not yet on site
- `hex_avalonq_irradiance_dry_run` decides intended mode (Eco / Standard / Super / Standby) from irradiance, SoC, charger stage, slope
- `Super` is enabled in the policy with explicit thresholds (`superAvailableWatts=1900`, `superMinSoc=90`, positive irradiance slope, `chargerEffective`); gated on `AvalonQ_Miner1_LoadManagement_Enable` (currently OFF)
- `chargerEffective` tolerates `BatteryChargingStatus` flickers when the XW+ pulses during Float — eliminates false `charger_inactive` thrash

## Repo structure

`openhab/examples/`
- `avalonq.items` / `avalonq-dryrun.items` — Avalon item scaffolds
- `avalonq.js` — file-based Avalon polling/control (deploys when hardware arrives)
- `avalonq-voltage-protection.js` — file-based Avalon voltage protection
- `avalonq-dryrun-policy-core.js` — canonical Avalon policy source
- `avalonq-irradiance-dry-run.js` / `avalonq-irradiance-dry-run-action.js` — file wrapper + REST inline action twin
- `bitaxe.items` — Bitaxe item scaffold
- `bitaxe.js` — file-based Bitaxe polling/control reference
- `bitaxe-voltage-protection.js` — file-based Bitaxe voltage protection reference
- `bitaxe-voltage-protection-action.js` — REST inline body for the live two-stage voltage protection
- `bitaxe-residual-policy-core.js` — canonical Bitaxe policy source
- `bitaxe-residual-dry-run.js` / `bitaxe-residual-dry-run-action.js` — file wrapper + REST inline policy twin
- `bitaxe-live-control-action.js` — REST inline body that PATCHes the Bitaxe with the policy decision

`openhab/pages/` — UI page JSON (Miner page, Avalon chart pages)

`docs/`
- `bitaxe-integration-plan.md` — coarse + fine dump-load model and safety invariants
- `avalon-commissioning-checklist.md` — Avalon hardware-arrival steps and Bitaxe addendum
- `openhab-irradiance-policy.md` — irradiance-aware policy rationale
- `persistence-and-before-after-analysis.md` — JDBC persistence list and pre/post-upgrade analysis plan

`references/` — vendor/API notes (Canaan)

`scripts/` — Python rollups (lost-harvest reporting, action regeneration)

## When Avalon hardware arrives

1. identify the Avalon miner LAN IP
2. assign the smart plug / relay that will power the Avalon path
3. link the final openHAB relay item for Avalon
4. deploy the real script-backed Avalon rules from this repo
5. validate API commands on port 4028: `version`, `summary`, `estats`, `pools`, standby on/off, Eco / Standard / Super switching
6. walk `docs/avalon-commissioning-checklist.md` (sections 1-12 for Avalon, section 13 for the Bitaxe addendum already complete)
7. enable Avalon load management only after end-to-end validation

## Conventions

- Avalon items: `AvalonQ_Miner1_*` (live group `AvalonQ_Miner1`)
- Bitaxe items: `Bitaxe_Gamma1_*` (live group `gBitaxe_Gamma1`)
- The Bitaxe AC relay is the existing `Miner_Power` item — not duplicated; see `docs/bitaxe-integration-plan.md`
- Standby (or Min profile) via API is preferred over relay-off; relay-off is the last-resort safety
- Policy logic lives in `*-policy-core.js`; the REST-managed inline twin is `*-action.js` (regenerate via `scripts/generate_avalon_dryrun_action.py`)
- Pool/stratum settings are operator-managed; the live PATCH helpers refuse any body that mentions `stratum`
