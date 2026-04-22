# Avalon Q commissioning checklist

Use this checklist on hardware arrival day when moving from dry-run-only monitoring to actual miner integration.

## 1. Network and power assignment

- Confirm the Avalon Q has a stable LAN IP or DHCP reservation.
- Confirm which smart plug / relay powers the Avalon path.
- Confirm that the Avalon path remains separate from the existing `Miner` / `Miner_Power` path.
- Confirm the Avalon branch is on the intended 15A circuit.
- Confirm no other unexpected discretionary loads are sharing that branch during testing.

Record:
- miner IP / hostname
- relay Thing UID
- relay item name
- circuit notes

## 2. openHAB item/rule preparation

- Confirm `AvalonQ_Miner1_*` items exist.
- Confirm dry-run items are updating.
- Confirm the dry-run rule is still safe and active.
- Confirm the actual command/control rule is still not controlling hardware before validation begins.
- Confirm `AvalonQ_Miner1_LoadManagement_Enable` remains OFF until end-to-end command validation is complete.

## 3. Basic TCP/API connectivity

From a shell on the openHAB host or another LAN host:

```bash
echo -n "version" | socat -t 300 stdio tcp:MINER_IP:4028,shut-none && echo
```

Validate:
- port `4028` is reachable
- response returns version/model details
- product/model identifies the expected Avalon unit

If this fails:
- verify IP
- verify the miner has finished booting
- verify the miner is not isolated on a different VLAN/subnet

## 4. Validate read commands first

Run and capture:

```bash
echo -n "summary" | socat -t 300 stdio tcp:MINER_IP:4028,shut-none && echo
echo -n "estats" | socat -t 300 stdio tcp:MINER_IP:4028,shut-none && echo
echo -n "pools" | socat -t 300 stdio tcp:MINER_IP:4028,shut-none && echo
```

Validate:
- `summary` returns hashrate/share stats
- `estats` returns temps/fans/workmode/state
- `pools` returns pool connectivity and stratum details

## 5. Validate standby / wake behavior before workmode switching

Preferred control path is standby via API, not hard AC power-off.

Test standby:

```bash
echo -n "ascset|0,softoff,1:TIMESTAMP" | socat -t 300 stdio tcp:MINER_IP:4028,shut-none && echo
```

Test wake:

```bash
echo -n "ascset|0,softon,1:TIMESTAMP" | socat -t 300 stdio tcp:MINER_IP:4028,shut-none && echo
```

Use a timestamp a few seconds in the future.

Validate:
- command returns success
- miner enters idle/standby state cleanly
- miner wakes cleanly
- openHAB state/parsing matches observed miner behavior

## 6. Validate workmode command syntax

The current Avalon Q implementation assumes:

```text
ascset|0,workmode,set,<mode>
```

Test query/read-compatible behavior first if supported.

Then test writes:
- Eco: `0`
- Standard: `1`

Do not test Super for automatic use right now.

Validate:
- the command form with `set` actually works on your hardware/firmware
- openHAB shows the correct workmode after refresh
- mode changes do not leave the miner in an inconsistent state

If the `set` form fails, test whether the miner expects the older A10-style syntax:

```text
ascset|0,workmode,<mode>
```

## 7. Validate power field parsing

The current integration interprets the second numeric value in `PS[...]` from `estats` as power.

Commissioning check:
- compare parsed `AvalonQ_Miner1_PowerW` against:
  - miner web UI / local display if available
  - smart plug measured power if available
  - expected Eco / Standard operating range

If the parsed power is clearly wrong, update the parser before trusting efficiency or curtailment math involving miner load.

## 8. Keep automatic mode ceiling at Standard

For now:
- automatic policy should only select `Eco` or `Standard`
- `Super` remains disabled because of the 15A circuit constraint

Commissioning check:
- verify no rule path can automatically promote to Super
- verify manual tests, if any, are deliberate and temporary

## 9. Retune SoC thresholds after the battery upgrade

Current thresholds were chosen in the context of AGM / estimated SoC.

Once Discover + BMS-backed SoC is available:
- re-evaluate `standbyLowSoc`
- re-evaluate `standbyHardLowSoc`
- re-evaluate Eco/Standard transition thresholds

Reason:
- LiFePO4 BMS SoC will be more trustworthy than the current voltage-derived estimate
- conservative AGM-era thresholds may be too cautious once true BMS SoC exists

## 10. Validate persistence and dashboard visibility

Before turning on live load management:
- confirm Avalon items are updating in the Miner page
- confirm persistence is recording:
  - expected PV
  - actual PV
  - curtailment ratio
  - effective SoC
  - mode decision
- confirm the dry-run thrash alert remains normal under stable conditions

## 11. Live enablement order

Recommended enablement order:
1. relay item linked and verified
2. read-only polling validated
3. standby/wake validated
4. Eco/Standard workmode validated
5. parser values spot-checked
6. dashboards/persistence verified
7. only then enable actual load management

## 12. Post-commissioning notes to capture

Record after first successful day:
- actual miner IP
- final relay item / Thing mapping
- successful workmode syntax used
- whether standby/wake needed any timing adjustments
- whether `PS[...]` parsing matched real power
- any firmware quirks
- whether Eco/Standard thresholds need adjustment
