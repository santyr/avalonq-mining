#!/usr/bin/env python3
import argparse
import json
import os
import statistics
import sys
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone

DEFAULTS = {
    'expected': 'AvalonQ_Miner1_PV_Expected_Watts',
    'actual': 'AvalonQ_Miner1_PV_Actual_Watts',
    'curtailment': 'AvalonQ_Miner1_PV_Curtailment_Ratio',
    'irradiance': 'AvalonQ_Miner1_SolarIrradiance_5minAvg',
}


def fetch_json(base_url: str, token: str, path: str):
    req = urllib.request.Request(
        urllib.parse.urljoin(base_url, path),
        headers={'Authorization': f'Bearer {token}', 'Accept': 'application/json'},
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


def nearest(series, ts, maxdiff_ms=120000):
    best = None
    for t, v in series:
        diff = abs(t - ts)
        if diff <= maxdiff_ms and (best is None or diff < best[0]):
            best = (diff, v)
    return None if best is None else best[1]


def iso_week(ts_ms):
    d = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).date()
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def build_rows(raw):
    expw = numeric_series(raw['expected'])
    actw = numeric_series(raw['actual'])
    curt = numeric_series(raw['curtailment'])
    irr = numeric_series(raw['irradiance'])
    rows = []
    for ts, exp in expw:
        act = nearest(actw, ts)
        cur = nearest(curt, ts)
        ir = nearest(irr, ts)
        if act is None:
            continue
        rows.append((ts, exp, act, cur, ir))
    rows.sort(key=lambda r: r[0])
    return rows


def summarize_by_week(rows, high_irr_threshold):
    grouped = defaultdict(list)
    for row in rows:
        grouped[iso_week(row[0])].append(row)

    result = []
    for week, samples in sorted(grouped.items()):
        lost_wh = 0.0
        high_irr_lost_wh = 0.0
        gaps = []
        ratios = []
        high_ratios = []
        for i, row in enumerate(samples):
            ts, exp, act, cur, ir = row
            gap = max(0.0, exp - act)
            gaps.append(gap)
            if cur is not None:
                ratios.append(cur)
                if ir is not None and ir >= high_irr_threshold:
                    high_ratios.append(cur)
            next_ts = samples[i + 1][0] if i + 1 < len(samples) else ts
            dt_hours = max(0.0, (next_ts - ts) / 3600000.0)
            lost_wh += gap * dt_hours
            if ir is not None and ir >= high_irr_threshold:
                high_irr_lost_wh += gap * dt_hours
        result.append({
            'iso_week_utc': week,
            'samples': len(samples),
            'lost_kwh': lost_wh / 1000.0,
            'lost_kwh_high_irradiance': high_irr_lost_wh / 1000.0,
            'mean_gap_w': statistics.mean(gaps) if gaps else None,
            'max_gap_w': max(gaps) if gaps else None,
            'median_curtailment_ratio': statistics.median(ratios) if ratios else None,
            'median_curtailment_ratio_high_irradiance': statistics.median(high_ratios) if high_ratios else None,
        })
    return result


def main():
    p = argparse.ArgumentParser(description='Weekly lost-harvest report from persisted Avalon dry-run data.')
    p.add_argument('--base-url', default='http://192.168.1.161:8080/rest/')
    p.add_argument('--token', default='')
    p.add_argument('--service-id', default='jdbc')
    p.add_argument('--high-irradiance-threshold', type=float, default=600.0)
    p.add_argument('--pretty', action='store_true')
    args = p.parse_args()

    token = args.token or os.environ.get('OPENHAB_TOKEN', '')
    if not token:
        print('Missing token: pass --token or set OPENHAB_TOKEN', file=sys.stderr)
        sys.exit(2)

    raw = {}
    for key, item_name in DEFAULTS.items():
        path = f"persistence/items/{urllib.parse.quote(item_name)}?serviceId={urllib.parse.quote(args.service_id)}"
        raw[key] = fetch_json(args.base_url, token, path)

    rows = build_rows(raw)
    report = {
        'row_count': len(rows),
        'high_irradiance_threshold_w_m2': args.high_irradiance_threshold,
        'weeks': summarize_by_week(rows, args.high_irradiance_threshold),
    }
    print(json.dumps(report, indent=2 if args.pretty else None))


if __name__ == '__main__':
    main()
