#!/usr/bin/env python3
import argparse
import json
import math
import statistics
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone

DEFAULT_ITEMS = {
    'curtailment': 'AvalonQ_Miner1_PV_Curtailment_Ratio',
    'expected': 'AvalonQ_Miner1_PV_Expected_Watts',
    'actual': 'AvalonQ_Miner1_PV_Actual_Watts',
    'irradiance': 'AvalonQ_Miner1_SolarIrradiance_5minAvg',
    'mode': 'AvalonQ_Miner1_DryRun_ModeDecision',
    'changes24h': 'AvalonQ_Miner1_DryRun_ModeChanges_24h',
    'eco24h': 'AvalonQ_Miner1_DryRun_Eco_Pct_24h',
    'std24h': 'AvalonQ_Miner1_DryRun_Standard_Pct_24h',
    'standby24h': 'AvalonQ_Miner1_DryRun_Standby_Pct_24h',
}


def iso(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).isoformat()


def pct(values, p):
    if not values:
        return None
    s = sorted(values)
    idx = (len(s) - 1) * p
    lo = math.floor(idx)
    hi = math.ceil(idx)
    if lo == hi:
        return s[int(idx)]
    return s[lo] + (s[hi] - s[lo]) * (idx - lo)


def fetch_json(base_url: str, token: str, path: str):
    req = urllib.request.Request(
        urllib.parse.urljoin(base_url, path),
        headers={
            'Authorization': f'Bearer {token}',
            'Accept': 'application/json',
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def numeric_series(payload):
    out = []
    for d in payload.get('data', []):
        try:
            out.append((int(d['time']), float(str(d['state']).split()[0])))
        except Exception:
            continue
    return out


def nearest(series, ts, maxdiff_ms):
    best = None
    for t, v in series:
        diff = abs(t - ts)
        if diff <= maxdiff_ms and (best is None or diff < best[0]):
            best = (diff, v)
    return None if best is None else best[1]


def build_report(raw):
    curt = numeric_series(raw['curtailment'])
    expw = numeric_series(raw['expected'])
    actw = numeric_series(raw['actual'])
    irr = numeric_series(raw['irradiance'])

    rows = []
    for ts, exp in expw:
        act = nearest(actw, ts, 120_000)
        c = nearest(curt, ts, 120_000)
        ir = nearest(irr, ts, 120_000)
        if act is not None and c is not None:
            rows.append((ts, exp, act, c, ir))

    curts = [r[3] for r in rows]
    expvals = [r[1] for r in rows]
    actvals = [r[2] for r in rows]
    gaps = [max(0, r[1] - r[2]) for r in rows]
    hi_irr = [r for r in rows if r[4] is not None and r[4] > 600]
    mid_irr = [r for r in rows if r[4] is not None and r[4] > 400]

    mode_counts = {'Standby': 0, 'Eco': 0, 'Standard': 0}
    reasons = {}
    for d in raw['mode'].get('data', []):
        s = str(d['state'])
        mode = None
        reason = None
        for part in s.split(','):
            if part.startswith('mode='):
                mode = part.split('=', 1)[1]
            elif part.startswith('reason='):
                reason = part.split('=', 1)[1]
        if mode in mode_counts:
            mode_counts[mode] += 1
        if reason:
            reasons[reason] = reasons.get(reason, 0) + 1

    changes = numeric_series(raw['changes24h'])
    eco_pct = numeric_series(raw['eco24h'])
    std_pct = numeric_series(raw['std24h'])
    standby_pct = numeric_series(raw['standby24h'])

    return {
        'sample_window': {
            'curtailment_first_ts': iso(curt[0][0]) if curt else None,
            'curtailment_last_ts': iso(curt[-1][0]) if curt else None,
            'curtailment_points': len(curt),
            'joined_points': len(rows),
        },
        'curtailment_ratio': {
            'min': min(curts) if curts else None,
            'p10': pct(curts, 0.10) if curts else None,
            'median': pct(curts, 0.50) if curts else None,
            'p90': pct(curts, 0.90) if curts else None,
            'max': max(curts) if curts else None,
            'below_0_8_fraction': (sum(1 for x in curts if x < 0.8) / len(curts)) if curts else None,
            'below_0_6_fraction': (sum(1 for x in curts if x < 0.6) / len(curts)) if curts else None,
        },
        'expected_vs_actual_watts': {
            'expected_mean': statistics.mean(expvals) if expvals else None,
            'actual_mean': statistics.mean(actvals) if actvals else None,
            'mean_gap_positive_only': statistics.mean(gaps) if gaps else None,
            'max_gap': max(gaps) if gaps else None,
        },
        'high_irradiance_over_600_wm2': {
            'points': len(hi_irr),
            'median_curtailment_ratio': pct([r[3] for r in hi_irr], 0.5) if hi_irr else None,
            'mean_positive_gap': statistics.mean([max(0, r[1] - r[2]) for r in hi_irr]) if hi_irr else None,
        },
        'mid_irradiance_over_400_wm2': {
            'points': len(mid_irr),
            'median_curtailment_ratio': pct([r[3] for r in mid_irr], 0.5) if mid_irr else None,
            'mean_positive_gap': statistics.mean([max(0, r[1] - r[2]) for r in mid_irr]) if mid_irr else None,
        },
        'mode_decisions': {
            'counts': mode_counts,
            'top_reasons': sorted(reasons.items(), key=lambda kv: kv[1], reverse=True)[:10],
            'latest_mode_changes_24h': changes[-1][1] if changes else None,
            'latest_eco_pct_24h': eco_pct[-1][1] if eco_pct else None,
            'latest_standard_pct_24h': std_pct[-1][1] if std_pct else None,
            'latest_standby_pct_24h': standby_pct[-1][1] if standby_pct else None,
        },
    }


def main():
    parser = argparse.ArgumentParser(description='Summarize persisted Avalon dry-run metrics from openHAB REST persistence.')
    parser.add_argument('--base-url', default='http://192.168.1.161:8080/rest/', help='Base openHAB REST URL')
    parser.add_argument('--token', default='', help='openHAB API token (or set OPENHAB_TOKEN)')
    parser.add_argument('--service-id', default='jdbc', help='Persistence service id')
    parser.add_argument('--pretty', action='store_true', help='Pretty-print JSON output')
    args = parser.parse_args()

    token = args.token or __import__('os').environ.get('OPENHAB_TOKEN', '')
    if not token:
        print('Missing token: pass --token or set OPENHAB_TOKEN', file=sys.stderr)
        sys.exit(2)

    raw = {}
    for key, item_name in DEFAULT_ITEMS.items():
        path = f"persistence/items/{urllib.parse.quote(item_name)}?serviceId={urllib.parse.quote(args.service_id)}"
        raw[key] = fetch_json(args.base_url, token, path)

    report = build_report(raw)
    print(json.dumps(report, indent=2 if args.pretty else None))


if __name__ == '__main__':
    main()
