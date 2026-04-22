# Canaan API notes for Avalon Q integration

This is a practical summary of the vendor API material we reviewed for the Avalon Q project.

Sources used:
- Canaan support page for Avalon Q commands
- Canaan `avalon10-docs` A10 API manual as a protocol/reference cross-check

## Core protocol model

The Canaan miner API is a direct TCP command socket.

Key operational properties:
- TCP short connections
- default port: `4028`
- one command per connection
- send command, read response, close connection
- do not treat it like REST
- do not pipeline or run concurrent API requests

Important note from the A10 manual that still matches the integration style we want:
- API communication should be single-threaded / sequential
- wait for one command to finish before starting the next

That means our openHAB integration should:
- poll centrally
- serialize commands
- avoid overlapping requests
- avoid one-command-per-item designs

## Basic command style

Typical Linux form from vendor examples:

```bash
echo -n "summary" | socat -t 300 stdio tcp:MINER_IP:4028,shut-none && echo
```

The same pattern applies to all read and write commands.

## Read commands we care about

### `version`
Use for:
- firmware/version info
- API version
- model identification
- DNA / MAC

Example response fields seen on the Avalon Q page:
- `CGMiner=4.11.1`
- `API=3.7`
- `PROD=Avalon Q`
- `MODEL=Q`
- `LVERSION=...`
- `DNA=...`
- `MAC=...`

### `summary`
Use for:
- uptime
- average hashrate
- accepted/rejected shares
- hardware errors
- rejection/stale rates

Useful fields:
- `Elapsed`
- `MHS av`
- `Accepted`
- `Rejected`
- `Hardware Errors`
- `Pool Rejected%`
- `Pool Stale%`

Note:
- values are in MH/s in the response, so the openHAB integration converts to TH/s for display.

### `estats`
Use for:
- detailed live miner state
- temperatures
- fan RPM
- power-ish fields
- workmode
- standby/work state
- ping
- LCD state

Useful fields observed on the Avalon Q page:
- `SYSTEMSTATU[...]`
- `STATE[...]`
- `ITemp[...]`
- `HBITemp[...]`
- `HBOTemp[...]`
- `TMax[...]`
- `TAvg[...]`
- `Fan1[...]` through `Fan4[...]`
- `FanR[...]`
- `PING[...]`
- `LcdOnoff[...]`
- `WORKMODE[...]`
- `WORKLEVEL[...]`
- `SoftOffTime[...]`
- `SoftOnTime[...]`
- `GHSspd[...]`
- `PS[...]`
- `MPO[...]`

Practical parsing notes:
- `SYSTEMSTATU[Work: In Work, Hash Board: 1]` indicates active mining
- if the system summary says `Work: In Idle`, treat that as standby
- `WORKMODE[0]` / `1` / `2` is useful, but pair it with `SYSTEMSTATU[...]`
- `PS[...]` contains a packed set of values; the current example integration extracts the second numeric value as power

### `pools`
Use for:
- pool URL
- pool online/alive status
- accepted/rejected counts
- stratum details

Useful fields:
- `URL`
- `Status`
- `Accepted`
- `Rejected`
- `Stratum URL`
- `Stratum Difficulty`
- `Pool Rejected%`
- `Pool Stale%`

Security note:
- pool responses can include usernames and passwords
- avoid exposing raw pool credentials in dashboards or logs

## Write commands we care about

### Set fan speed

```text
ascset|0,fan-spd,<SPEED>
```

Notes:
- allowed manual range: `15..100`
- `-1` returns the miner to automatic fan control

### Set work mode

```text
ascset|0,workmode,set,<mode>
```

Avalon Q values from the vendor page:
- `0` = Eco
- `1` = Standard
- `2` = Super

Project policy for now:
- only use Eco and Standard automatically
- keep Super disabled by default because the miner must stay within the current 15A circuit
- revisit Super later if winter operating conditions change

### Reboot

```text
ascset|0,reboot,0
```

Use carefully:
- this is fine for manual maintenance
- do not automate reboot as a routine control mechanism

### Standby / soft off

```text
ascset|0,softoff,1:<timestamp>
```

### Wake / soft on

```text
ascset|0,softon,1:<timestamp>
```

Important notes:
- both commands require a future timestamp
- a helper like `epoch_now + 5 seconds` is appropriate
- this is the preferred stop/start path for our project instead of hard-cutting AC power

Project policy for now:
- prefer standby via API
- only use relay power-off as an optional fallback, not the default

### LCD control

The Avalon Q support page also documents LCD control and the example integration uses:

```text
ascset|0,lcd,0:<0|1>
```

### Pool configuration

```text
setpool|<username>,<userpass>,<poolnum>,<pooladdr>,<worker>,<workerpasswd>
```

Notes:
- higher risk because it carries credentials
- vendor note says pool settings do not take effect until reboot
- avoid exposing this in a first-pass openHAB UI

## Response format notes

The API responses are not friendly JSON.

Common patterns:
- top-level comma/pipe separated key-value output
- packed bracket fields in `estats`
- values like `KEY=value`
- structured segments like `WORKMODE[0]`

Practical parser strategy:
- parse simple `key=value` fields for `version`, `summary`, and `pools`
- parse `KEY[...]` bracket fields for `estats`
- normalize status into openHAB-friendly values after parsing

## Integration implications for openHAB

These vendor docs support the design already chosen for this project:

1. One central JS rule should own polling and command sending.
2. Poll the miner sequentially, not concurrently.
3. Prefer a fast poll set of:
   - `summary`
   - `estats`
   - `pools`
4. Poll `version` less frequently.
5. Use API standby/wake as the normal power-management path.
6. Keep AC relay control separate and optional.
7. Reuse upstream battery state inputs from openHAB:
   - `BatterySoC_Calculated`
   - `BatteryChargingStatus`
8. Keep the Avalon path separate from the existing `Miner` / `Miner_Power` setup.

## Operational guardrails

- Do not overlap API requests.
- Do not poll every metric independently.
- Do not expose pool credentials casually.
- Do not auto-enable Super mode right now.
- Treat standby as the preferred low-power state.
- Use relay-off only as an optional fallback or emergency measure.

## Commands most likely to be used first when hardware arrives

```bash
# Identify the miner
echo -n "version" | socat -t 300 stdio tcp:MINER_IP:4028,shut-none && echo

# Basic health
echo -n "summary" | socat -t 300 stdio tcp:MINER_IP:4028,shut-none && echo

# Detailed operating state
echo -n "estats" | socat -t 300 stdio tcp:MINER_IP:4028,shut-none && echo

# Pool state
echo -n "pools" | socat -t 300 stdio tcp:MINER_IP:4028,shut-none && echo

# Enter standby (use a future epoch timestamp)
echo -n "ascset|0,softoff,1:TIMESTAMP" | socat -t 300 stdio tcp:MINER_IP:4028,shut-none && echo

# Wake back up
echo -n "ascset|0,softon,1:TIMESTAMP" | socat -t 300 stdio tcp:MINER_IP:4028,shut-none && echo

# Set Eco
echo -n "ascset|0,workmode,set,0" | socat -t 300 stdio tcp:MINER_IP:4028,shut-none && echo

# Set Standard
echo -n "ascset|0,workmode,set,1" | socat -t 300 stdio tcp:MINER_IP:4028,shut-none && echo
```
