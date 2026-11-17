#!/usr/bin/env bash
# Turns a screen recording into the README's GIF (images/readme/first-review.gif).
# Usage: scripts/readme-gif.sh <recording.mov> [crop=w:h:x:y] [start=0] [duration=20] [width=1200] [fps=12]
# Crop is in the recording's pixels (a Retina capture is 2x the screen points); omit it or pass ""
# for the whole frame. Two passes: a palette built from this clip, then dithered frames.
set -euo pipefail

in=${1:?recording file}
crop=${2:-}
start=${3:-0}
dur=${4:-20}
width=${5:-1200}
fps=${6:-12}
out=${OUT:-images/readme/first-review.gif}

filters="fps=${fps}"
[ -n "$crop" ] && filters="crop=${crop},${filters}"
filters="${filters},scale=${width}:-1:flags=lanczos"

palette=$(mktemp -t readme-palette).png
trap 'rm -f "$palette"' EXIT

ffmpeg -v error -y -ss "$start" -t "$dur" -i "$in" -vf "${filters},palettegen=max_colors=128:stats_mode=diff" "$palette"
ffmpeg -v error -y -ss "$start" -t "$dur" -i "$in" -i "$palette" \
  -lavfi "${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" "$out"

ls -lh "$out"
