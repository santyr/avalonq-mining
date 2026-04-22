# openHAB example scripts

Current example scripts in this directory:
- `avalonq.items` — Avalon item scaffold
- `avalonq.js` — main polling/control integration for live hardware
- `avalonq-voltage-protection.js` — low-voltage standby-first protection example
- `avalonq-irradiance-dry-run.js` — irradiance-aware dry-run policy that logs intended Standby/Eco/Standard decisions without sending miner commands

Current project policy:
- automatic control is capped at Eco/Standard for now
- Super mode remains disabled by default because of the current 15A circuit
- standby via API is preferred over hard relay-off
