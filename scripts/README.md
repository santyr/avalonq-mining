# Scripts

## `avalon_persistence_report.py`

Summarizes persisted Avalon dry-run metrics from the openHAB REST persistence API.

Example:

```bash
OPENHAB_TOKEN='YOUR_TOKEN' python3 scripts/avalon_persistence_report.py --pretty
```

Defaults:
- base URL: `http://192.168.1.161:8080/rest/`
- service id: `jdbc`

Current report includes:
- curtailment ratio distribution
- expected vs actual PV summary
- filtered irradiance windows
- dry-run mode counts and top reasons
- latest 24h dry-run allocation metrics
