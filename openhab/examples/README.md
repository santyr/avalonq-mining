# openHAB example scripts

Current example scripts in this directory:
- `avalonq.items` — Avalon item scaffold
- `avalonq-dryrun.items` — dry-run scaffold items so the irradiance policy is file-managed and self-contained
- `avalonq.js` — main polling/control integration for live hardware
- `avalonq-voltage-protection.js` — low-voltage standby-first protection example
- `avalonq-dryrun-policy-core.js` — canonical shared source of truth for the irradiance-aware dry-run policy logic
- `avalonq-irradiance-dry-run.js` — file-based JSRule wrapper around the canonical dry-run policy core
- `avalonq-irradiance-dry-run-action.js` — generated inline action body for the REST-managed dry-run rule action in openHAB

Notes:
- `avalonq-dryrun-policy-core.js` is the only file that should be edited for dry-run policy logic changes
- regenerate `avalonq-irradiance-dry-run-action.js` with `python3 scripts/generate_avalon_dryrun_action.py` after changing the canonical core
- the dry-run rule now updates its time series only on irradiance changes and the periodic cron tick, reducing cache read-modify-write races from unrelated triggers

Current project policy:
- automatic control is capped at Eco/Standard for now
- Super mode remains disabled by default because of the current 15A circuit
- standby via API is preferred over hard relay-off
