#!/usr/bin/env bash
set -euo pipefail

# Test script: creates a song creation task on ATS channel song-creator

PROMPT="${1:-A dreamy lo-fi hip hop beat with soft piano and rain sounds}"
LYRICS="${2:-[verse]
Walking through the city lights
Rain is falling soft tonight
Every drop a melody
Washing over you and me

[chorus]
Let the music carry us away
In this moment we will stay
Dancing through the midnight rain
Never feeling any pain}"
DURATION="${3:-60}"

echo "Creating test task on channel song-creator..."
echo "  Prompt:   $PROMPT"
echo "  Duration: ${DURATION}s"
echo ""

PAYLOAD=$(cat <<EOF
{"prompt": $(echo "$PROMPT" | jq -Rs .), "lyrics": $(echo "$LYRICS" | jq -Rs .), "audio_duration": $DURATION}
EOF
)

ats create "Test Song Generation" \
  --channel song-creator \
  --type song-generation \
  --payload "$PAYLOAD" \
  --actor-type human \
  --actor-id test-user \
  --actor-name "Test User" \
  -f json

echo ""
echo "Task created. The song-creator agent should pick it up automatically."
echo "Watch progress: ats list --channel song-creator --all -f json"
