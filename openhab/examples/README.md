# openHAB example scripts

Current example scripts in this directory:
- `avalonq.items` — Avalon item scaffold
- `avalonq.js` — main polling/control integration for live hardware
- `avalonq-voltage-protection.js` — low-voltage standby-first protection example
- `avalonq-irradiance-dry-run.js` — standalone JSRule-based irradiance-aware dry-run policy for file-based JS automation
- `avalonq-irradiance-dry-run-action.js` — inline script body for the REST-managed dry-run rule action in openHAB

Current project policy:
- automatic control is capped at Eco/Standard for now
- Super mode remains disabled by default because of the current 15A circuit
- standby via API is preferred over hard relay-off
