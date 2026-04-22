# Avalon Q commissioning checklist

Use this checklist on hardware arrival day when moving from dry-run-only monitoring to actual miner integration.

## 1. Network and power assignment

- Confirm the Avalon Q has a stable LAN IP or DHCP reservation.
- Confirm which smart plug / relay powers the Avalon path.
- Confirm that the Avalon path remains separate from the existing `Miner` / `Miner_Power` path.
- Confirm the Avalon branch is on the intended 20A circuit.
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

## 8. Verify Super-mode thresholds on the 20A branch

Super mode (~1674 W) is enabled by default now that the Avalon branch is on a 20A circuit. The XW6848-21 has 6.8 kW of continuous capacity, so Super on top of normal house load is well within envelope.

Commissioning checks:
- verify the branch is in fact a 20A circuit and not still 15A (NEC derate to 1920 W on 20A leaves ~220 W of slack with Super + Bitaxe)
- verify the policy's `superAvailableWatts`/`superMinSoc`/`superSlope15mFloor` thresholds in `avalonq-dryrun-policy-core.js` still match site reality
- verify the dry-run policy promotes to Super when `availableWatts > 1900 && soc > 90 && slope15m > 0 && charging`
- verify `Super` is also represented in the metrics (`AvalonQ_Miner1_DryRun_Super_Pct_24h` populating)
- if any first-run instability is seen on the 20A breaker, fall back by setting `allowSuperMode: false` in the policy core

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

## 13. Bitaxe commissioning addendum

The Bitaxe Gamma uses a different API (plain HTTP on port 80 over the AxeOS REST surface), so it has its own commissioning steps. Walk these in parallel with the Avalon steps above once the Bitaxe is on the LAN.

### 13.1 Network and power assignment

- Confirm the Bitaxe has a stable LAN IP or DHCP reservation; update `CFG.host` in `openhab/examples/bitaxe.js`.
- Confirm the Bitaxe is physically powered through the existing `Miner_Power` relay. If this is not the case, stop and reassign before continuing.
- Confirm the Bitaxe's 25 W envelope is accounted for on top of the Avalon 1674 W ceiling; the 15 A circuit has room for both.
- Confirm `Bitaxe_Gamma1_LoadManagement_Enable` remains OFF until end-to-end validation is complete.

### 13.2 Basic HTTP/API connectivity

From a shell on the openHAB host or another LAN host:

```bash
curl -sS http://BITAXE_IP/api/system/info | jq .
curl -sS http://BITAXE_IP/api/system/asic | jq .
```

Validate:
- port 80 is reachable
- JSON is well-formed
- `ASICModel` is `BM1370`
- `frequencyOptions` and `voltageOptions` arrays are non-empty

If this fails:
- verify IP
- verify the miner finished booting
- verify there is no firewall rule blocking port 80 between openHAB and the Bitaxe

### 13.3 Validate the default profile table against `/api/system/asic`

The default table baked into `bitaxe.js` is only a starting point. The authoritative source at runtime is `/api/system/asic`. Verify that every `(frequency, coreVoltage)` pair in the default table appears in `frequencyOptions` and `voltageOptions` respectively. If the live device reports different options:
- trust the live options
- update the profile table in `bitaxe-residual-policy-core.js` if the power/hashrate figures drift meaningfully

### 13.4 Validate a non-destructive PATCH round-trip

Use fan speed first because it is the lowest-risk setting to flip.

```bash
curl -sS -X PATCH http://BITAXE_IP/api/system \
  -H 'Content-Type: application/json' \
  -d '{"autofanspeed":0,"fanspeed":40}'
sleep 2
curl -sS http://BITAXE_IP/api/system/info | jq '.fanspeed, .autofanspeed'
```

Validate:
- PATCH returns 200
- `fanspeed` in the next `/api/system/info` matches what was sent
- flipping `autofanspeed` back to `1` restores automatic fan control

### 13.5 Validate the overclock gate

With `CFG.allowOverclock = false` (default), attempt to set a frequency/voltage pair via `Bitaxe_Gamma1_TargetFrequency_Set` or `Bitaxe_Gamma1_Profile_Set`. Validate:
- the rule logs a refusal indicating the overclock gate is off
- no PATCH is sent

Only then, carefully flip `allowOverclock` to `true`, retry with the `Stock` profile, and confirm:
- PATCH returns 200
- `/api/system/info` reflects the new `frequency` and `coreVoltage` values
- hashrate and power trend toward the expected profile figures
- `errorPercentage` stays near zero

Revert to `Stock` when done unless you are explicitly tuning.

### 13.6 Validate firmware currency

Check the firmware version reported in `Bitaxe_Gamma1_Firmware` and `Bitaxe_Gamma1_AxeOSVersion` against the latest ESP-Miner release. Upgrade out-of-band before trusting long-running automation. Reference: the ESP-Miner repository releases page on GitHub (navigate to it manually, do not bake a URL into the rule).

### 13.7 Validate thermal guardrails before long-running automation

Before enabling load management, confirm the live `Bitaxe_Gamma1_ASIC_Temp` value is sane and that `Bitaxe_Gamma1_TempTarget` matches the configured target (recommended 60-65 C). The dry-run policy downshifts one profile at 70 C and forces Standby at 80 C; verify that behavior by temporarily applying a high profile during a warm part of the day and observing the dry-run decision.

### 13.8 Live enablement order

Only after every step above is green:
1. verify the Avalon commissioning checklist is complete
2. confirm the dry-run rule `Bitaxe Residual Dry Run` is updating items
3. confirm persistence is recording the Bitaxe items listed in `docs/persistence-and-before-after-analysis.md`
4. flip `Bitaxe_Gamma1_LoadManagement_Enable` to ON
5. watch the first few profile transitions manually before trusting overnight operation
