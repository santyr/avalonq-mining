# avalonq-mining

Broader project repo for the Avalon Q mining setup.

This repo is intended to hold the operational pieces around the Avalon Q miner, including:
- openHAB integration and automation
- power-management and battery-aware control policy
- deployment notes for the on-site miner and relay path
- future monitoring, tuning, and seasonal operating changes

Current status:
- miner hardware has not arrived yet
- placeholder Avalon items and disabled rules have already been created in the live openHAB instance
- preferred control model is standby via the Avalon API rather than hard power-off
- automatic operating modes should stay in Eco or Standard for now to respect the 15A circuit
- Super mode is intentionally disabled by default for now and may be revisited in winter

Repo structure:
- `openhab/examples/`
  - `avalonq.items`
  - `avalonq.js`
  - `avalonq-voltage-protection.js`
- `docs/`
  - deployment notes, integration plans, and operational runbooks
- `references/`
  - vendor/API reference notes and related material

Immediate next steps when hardware arrives:
1. identify the Avalon miner LAN IP
2. assign the smart plug / relay that will power the Avalon path
3. link the final openHAB relay item for Avalon
4. deploy the real script-backed Avalon rules from this repo
5. validate API commands on port 4028:
   - version
   - summary
   - estats
   - pools
   - standby on/off
   - Eco / Standard switching
6. enable load management only after end-to-end validation

Notes:
- keep the existing current miner path (`Miner`, `Miner_Power`, `Miner Voltage Protection`) separate from the Avalon path
- Avalon should use its own items and rules under the `AvalonQ_Miner1_*` namespace
- standby via API is preferred; relay-off should remain an optional fallback only
