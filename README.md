# Song Creator ATS Agent

ATS agent that watches for song creation tasks and processes them through the ACE-Step music generation API.

## How It Works

1. Watches ATS channel `song-creator` for new `task.created` events
2. Claims the task, extracts payload (`prompt`, `lyrics`, `audio_duration`)
3. Submits to ACE-Step API (`/release_task`) for music generation
4. Polls `/query_result` every 5s until generation completes
5. Downloads generated audio from ACE-Step
6. Uploads to Backblaze B2 (`adas-storage/music/`)
7. Completes the ATS task with public audio URLs

## Requirements

- Node.js >= 18
- `ats` CLI installed and configured
- ACE-Step API running on `localhost:8000`
- AWS CLI configured (`~/env.vars` with B2 credentials)
- `jq` (for test script)

## Usage

```bash
# Start the agent
npm start

# Create a test task
bash test.sh

# Custom test
bash test.sh "upbeat electronic dance music" "your lyrics here" 120
```

## Task Payload

```json
{
  "prompt": "A dreamy lo-fi hip hop beat with soft piano",
  "lyrics": "[verse]\nWalking through the city...\n[chorus]\nLet the music...",
  "audio_duration": 240
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `prompt` | string | `""` | Music style description |
| `lyrics` | string | `""` | Song lyrics with section tags |
| `audio_duration` | number | `240` | Duration in seconds |

## Actor Identity

- **Type:** `agent`
- **ID:** `song-creator`
- **Name:** `Song-Creator`

## Output

On success, the ATS task is completed with:

```json
{
  "audio_urls": ["https://f004.backblazeb2.com/file/adas-storage/music/task-123-0-1706000000-output.mp3"],
  "audio_count": 1,
  "ace_step_task_id": "ace-abc123"
}
```

On failure, the ATS task is failed with the error reason.

## ACE-Step Parameters

| Parameter | Value |
|-----------|-------|
| `thinking` | `true` |
| `infer_step` | `8` |
| `guidance_scale` | `7.0` |
| `audio_duration` | from payload (default 240) |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ACE_STEP_URL` | `http://localhost:8000` | ACE-Step API base URL |

## Reconnection

The watcher auto-reconnects on disconnect with exponential backoff (3s to 60s max).
