# spl-output-linux

A real audio output level and listening-exposure monitor for Linux (PipeWire).

It measures the actual signal level coming out of your default audio device,
converts it to an estimated sound pressure level (SPL) in dB using a per-device
calibration that you create with a physical SPL meter, and logs it over time so
you can see listening duration, average loudness, worst-case peaks, and a
noise-exposure dose. Think of the "Headphone Audio Levels" screen in the iOS
Health app, but on Linux, per output device, and calibrated by you.

## Why this exists

- iOS shows calibrated headphone SPL, but only for Apple hardware inside Apple's
  ecosystem. On Linux there is no built-in equivalent.
- The output device matters. The same digital level produces different real
  loudness on different headphones, so calibration has to be per device.
- Active headphones (for example AirPods Max) run their own DSP, which makes a
  fixed digital tone drift in loudness over time. This tool stores raw
  measurements, so you can recalibrate any time and re-derive all history.
- You may want exact numbers: worst-case peak, energy-average level (Leq), and a
  daily exposure dose, not just a vague "loud" or "ok" label.

## What it measures and how

- A background daemon captures the default sink monitor with `pw-record` and
  computes the RMS and peak level in dBFS every few seconds.
- It records the timestamp, device, dBFS (RMS and peak), and the current volume.
  Raw values are stored, so recalibration retroactively updates all past SPL
  numbers.
- SPL is estimated with a per-device linear fit: `SPL = slope * dBFS + offset`,
  measured at a fixed volume with a real SPL meter. Volume changes are
  compensated with a `20 * log10(volume / calibrated_volume)` term.
- Exposure dose uses the NIOSH model (85 dB for 8 hours, 3 dB exchange rate).
  100 percent equals a full day of safe exposure.

## Requirements

- PipeWire with `pw-record`, `pw-play`, and `wpctl` (WirePlumber)
- Python 3.8 or newer, standard library only. `audioop` is used when present,
  with a pure-Python fallback for Python 3.13 and later where `audioop` was
  removed.
- `sox` and `ffmpeg` to generate calibration tones
- A physical SPL meter for calibration. C weighting or Z (flat) is preferred.

## Install

```
git clone https://github.com/mrayden/spl-output-linux
cd spl-output-linux
./install.sh
```

This copies `dbmon` into `~/.local/share/dbmon`, symlinks it into `~/.local/bin`,
and enables a systemd user service that logs in the background. Make sure
`~/.local/bin` is on your PATH.

## Desktop app (Electron UI)

A GUI lives in `ui/`. It shows a live SPL meter, an OK / Loud status like the
iOS Health "Headphone Audio Levels" screen, daily level bars colored by your
cap, per-device filtering, a device list with whitelist toggles, a settings
tab, and an optional tray icon that shows the current dB.

Run it directly:

```
cd ui
npm install
npm start
```

Or install an app-menu launcher (this also runs npm install):

```
cd ui
./install-ui.sh
```

Then open "SPL Output Monitor" from your applications menu. Highlights:

- Live meter with an over-cap warning, plus a badge when the current device is
  not calibrated or not whitelisted.
- Time range tabs (24h, 7d, 30d) and a per-device filter.
- OK / Loud status and an Apple-style chart showing each day's min-to-max level
  as a rounded capsule (green under the cap, red over it) with an average dot.
- Settings tab: set the cap, toggle the tray icon (closing then hides to the
  tray instead of quitting), and choose whether non-whitelisted devices show by
  default.
- Calibration tab: recalibrate or add calibration at multiple frequencies per
  device. It plays test tones, captures the output level, you type the SPL from
  your meter, and it fits and stores a per-frequency curve. SPL estimates then
  interpolate across your calibrated frequencies (log scale).
- Spectrum tab: a live frequency spectrum of your output (Web Audio FFT of the
  device monitor) alongside the current calibrated SPL.

The UI reads the same data as the CLI (it calls `dbmon ... --json`), so the
background service must be installed and running.

## Calibration

1. Set the headphones you want as the system output and fix the volume, for
   example 50 percent.
2. Generate test tones with `./gen-tones.sh`. This writes 1 kHz sine tones from
   -6 to -30 dBFS into `~/cal-tones`.
3. Run `dbmon calibrate`. For each tone it plays, hold your SPL meter at the ear
   cup, let it settle, and type the dB reading. It fits
   `SPL = slope * dBFS + offset` and stores it for that device and volume.

Notes that matter for accuracy:

- Active headphones: block the on-head or wear sensor during calibration so the
  DSP does not ramp the level. If a steady tone keeps getting louder, the sensor
  is not blocked and the calibration will not be stable.
- Use C or Z (flat) weighting on the meter. A weighting is close at 1 kHz.
- Room noise sets a floor. Quiet tones near the room level read too high. Keep
  your calibration points in roughly the 68 to 82 dB range for best results.

## Per-device tracking and the whitelist

Every output device is tracked and calibrated separately. Everything is always
logged, but reports can exclude non-whitelisted devices so your graphs only
reflect the headphones you care about (not speakers or HDMI, where the meter at
your ear does not apply).

```
dbmon devices             # list devices seen, with calibration and whitelist status
dbmon whitelist add XM5   # match by label or node name substring
dbmon whitelist rm XM5
dbmon whitelist           # show the current whitelist
```

When any device is whitelisted, reports default to whitelisted only. Use
`dbmon report --all` to include everything.

## Usage

```
dbmon live                # live SPL readout for the current output device
dbmon report              # last 7 days, broken down by device and by day
dbmon report --days 30    # last 30 days
dbmon report --all        # include non-whitelisted devices
dbmon report --device XM5 # filter to one device
dbmon cap 75              # set your personal loudness cap in dB (default 75)
dbmon cap                 # show the current cap
dbmon showcalib           # show stored calibration curves
```

Example report:

```
=== Audio exposure - last 7 day(s) - whitelisted devices only ===

-- by device --
device                     listen    Leq  max dB    >75dB  dose%  calib
AirPods Max                9.30 h   71.4    88.1   1.40 h     62  yes
WH-1000XM5                 2.10 h   68.2    79.6   0.20 h      9  yes

-- by day (calibrated devices) --
date          listen    Leq  max dB    >75dB  dose%
2026-07-14    1.80 h   70.9    85.3   0.30 h     11
2026-07-15    2.40 h   72.6    88.1   0.55 h     22
...

TOTAL (calibrated): 11.40 h   Leq 70.8 dB   worst-case peak 88.1 dB
Worst-case peak: 88.1 dB on 2026-07-15 at 21:42
Over cap (75 dB): 1.60 h  (14% of listening)
```

## Loudness cap

Set a personal loudness limit and see how much time you spend above it.

```
dbmon cap 75     # set the cap to 75 dB (default is 75)
dbmon cap        # show the current cap
```

Reports then include a column for time spent above the cap (per device and per
day) plus a total, for example "Over cap (75 dB): 1.60 h (14% of listening)".
The `dbmon live` readout prints a warning when the current level goes over the
cap. This is separate from the NIOSH dose: the cap is your own comfort or safety
line, while the dose follows the occupational standard.

## Loading a saved calibration

Calibrations are stored in the `calibrations` folder. To load one, find your
device node name and add the curve:

```
wpctl inspect @DEFAULT_AUDIO_SINK@ | grep node.name
dbmon addcalib --device <node.name> --volume 0.5 --slope 1.075 --offset 91.2 --weighting C
```

## Included calibrations

- AirPods Max (Gen 1), A2DP, 50 percent volume, C weighting, 1 kHz:
  - Fit: `SPL = 1.075 * dBFS + 91.2`
  - Raw points (monitor RMS dBFS to SPL dB): (-9.17, 81.5), (-15.17, 74.9),
    (-21.17, 68.6)
  - Measured at the ear cup with a physical meter, wear sensor blocked so the
    DSP did not ramp.

See `calibrations/airpods-max.json`. Replace the device node hint with your own
node name, since Bluetooth node names are based on the device address.

## Accuracy and honest limits

- This is a ballpark meter, not an audiology instrument. Expect roughly plus or
  minus 1 to 2 dB at best, because there is no ear coupler.
- SPL comes from a C-weighted meter. Occupational dose standards use A weighting,
  so the dose figure is an estimate, not a legal measurement.
- Calibration is single-frequency at 1 kHz. Broadband music will not map
  perfectly, especially on headphones with strong DSP.
- Bluetooth latency does not affect level measurement. It only affects real-time
  monitoring, which this tool does not do.
- Active headphones can change their own gain. If you suspect drift, recalibrate.
  Raw data is preserved, so history updates automatically.

## Data

- SQLite database at `~/.local/share/dbmon/data.db` with tables `samples`,
  `calib`, and `devices`.
- Back it up or copy it between machines. Recalibrating never loses history,
  because raw dBFS and volume are stored and SPL is computed on read.

## Uninstall

```
systemctl --user disable --now dbmon.service
rm ~/.config/systemd/user/dbmon.service ~/.local/bin/dbmon
rm -rf ~/.local/share/dbmon   # this also deletes your history and calibration
```

## License

MIT. See LICENSE.
