#!/usr/bin/env bash
set -euo pipefail

# Generate 1 kHz sine calibration tones at known dBFS levels.
# Requires sox.

D="$HOME/cal-tones"
mkdir -p "$D"
for l in 6 12 18 24 30; do
  sox -n -r 48000 -c 2 "$D/tone_-${l}dBFS.wav" synth 25 sine 1000 gain -"${l}"
done
echo "Wrote calibration tones to $D:"
ls -1 "$D"
