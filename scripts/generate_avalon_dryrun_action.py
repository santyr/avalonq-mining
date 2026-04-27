#!/usr/bin/env python3
import argparse
import sys
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


def build_action() -> str:
    core_text = core.read_text()
    # Strip CommonJS export from the generated inline body.
    core_text = core_text.replace("\nmodule.exports = { CFG, AVALON_MODE_WATTS, decideMode, runDryPolicy };\n", "\n")
    return header + core_text + "\nrunDryPolicy();\n"


def main() -> int:
    parser = argparse.ArgumentParser(description='Generate the REST inline Avalon dry-run action from the canonical policy core.')
    parser.add_argument('--check', action='store_true', help='fail if the generated action file is out of date')
    args = parser.parse_args()

    generated = build_action()
    if args.check:
        current = out.read_text() if out.exists() else ''
        if current != generated:
            print(f'{out} is out of date; run {Path(__file__).name}', file=sys.stderr)
            return 1
        print(f'{out} is up to date')
        return 0

    out.write_text(generated)
    print(f'Wrote {out}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
