# openHAB example scripts

Current example scripts in this directory:
- `avalonq.items` — Avalon item scaffold
- `avalonq-dryrun.items` — dry-run scaffold items so the irradiance policy is file-managed and self-contained
- `avalonq.js` — main polling/control integration for live hardware
- `avalonq-voltage-protection.js` — low-voltage standby-first protection example
- `avalonq-irradiance-dry-run.js` — standalone JSRule-based irradiance-aware dry-run policy for file-based JS automation
- `avalonq-irradiance-dry-run-action.js` — inline script body for the REST-managed dry-run rule action in openHAB

Notes:
- keep the two dry-run JS files aligned; the `*-action.js` file is what currently backs the live REST-managed rule in openHAB
- the dry-run rule now updates its time series only on irradiance changes and the periodic cron tick, reducing cache read-modify-write races from unrelated triggers

Current project policy:
- automatic control is capped at Eco/Standard for now
- Super mode remains disabled by default because of the current 15A circuit
- standby via API is preferred over hard relay-off
