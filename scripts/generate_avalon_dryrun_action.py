#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
core = ROOT / 'openhab' / 'examples' / 'avalonq-dryrun-policy-core.js'
out = ROOT / 'openhab' / 'examples' / 'avalonq-irradiance-dry-run-action.js'

header = """/*
 * GENERATED FILE — do not edit directly.
 *
 * Canonical source of policy logic:
 * openhab/examples/avalonq-dryrun-policy-core.js
 *
 * This inline action body is for the REST-managed live openHAB rule.
 */

"""

core_text = core.read_text()
# Strip CommonJS export from the generated inline body.
core_text = core_text.replace("\nmodule.exports = { CFG, runDryPolicy };\n", "\n")
out.write_text(header + core_text + "\nrunDryPolicy();\n")
print(f'Wrote {out}')
