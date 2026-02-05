#!/usr/bin/env node

import { spawn, execSync } from 'child_process';
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ACTOR = { type: 'agent', id: 'song-creator', name: 'Song-Creator' };
const ATS_CHANNEL = 'song-creator';
const ACE_STEP_BASE = process.env.ACE_STEP_URL || 'http://localhost:8000';
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes max per generation
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 60000;

const B2_PUBLIC_URL = 'https://f004.backblazeb2.com/file/adas-storage';
const B2_BUCKET = 'adas-storage';
const B2_MUSIC_PREFIX = 'music';

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level, msg, data) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(data && { data }),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers (built-in only, no dependencies)
// ---------------------------------------------------------------------------

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const mod = parsedUrl.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };

    const req = mod.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });

    req.on('error', reject);

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

async function httpJson(url, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  const body = options.body ? JSON.stringify(options.body) : undefined;
  const res = await httpRequest(url, {
    method: options.method || (body ? 'POST' : 'GET'),
    headers,
    body,
  });
  const text = res.body.toString('utf8');
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

// ---------------------------------------------------------------------------
// ATS CLI helpers
// ---------------------------------------------------------------------------

function atsExec(args) {
  const cmd = ['ats', ...args].join(' ');
  log('debug', `ats exec: ${cmd}`);
  const out = execSync(cmd, { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
  return out.trim();
}

function atsExecJson(args) {
  const raw = atsExec([...args, '-f', 'json']);
  return JSON.parse(raw);
}

function actorArgs() {
  return [
    '--actor-type', ACTOR.type,
    '--actor-id', ACTOR.id,
    '--actor-name', ACTOR.name,
  ];
}

function atsGetTask(taskId) {
  return atsExecJson(['get', taskId]);
}

function atsClaimTask(taskId) {
  // Use a long lease (15 minutes) since audio generation can take several minutes
  atsExec(['claim', taskId, '--lease', String(15 * 60 * 1000), ...actorArgs()]);
  log('info', `Claimed task ${taskId}`);
}

function atsCompleteTask(taskId, outputs) {
  const outputsJson = JSON.stringify(outputs);
  // Use spawnSync-style quoting via shell to avoid escaping issues
  const cmd = `ats complete ${taskId} --outputs ${shellQuote(outputsJson)} ${actorArgs().join(' ')}`;
  log('debug', `ats exec: ${cmd}`);
  execSync(cmd, { encoding: 'utf8', timeout: 30000 });
  log('info', `Completed task ${taskId}`, { outputs });
}

function atsFailTask(taskId, reason) {
  // Truncate and sanitize reason for shell safety
  const safeReason = reason.slice(0, 500).replace(/\n/g, ' ');
  const cmd = `ats fail ${taskId} --reason ${shellQuote(safeReason)} ${actorArgs().join(' ')}`;
  log('debug', `ats exec: ${cmd}`);
  execSync(cmd, { encoding: 'utf8', timeout: 30000 });
  log('warn', `Failed task ${taskId}`, { reason });
}

function shellQuote(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ---------------------------------------------------------------------------
// ACE-Step API
// ---------------------------------------------------------------------------

async function submitToAceStep(payload) {
  const body = {
    prompt: payload.prompt || '',
    lyrics: payload.lyrics || '',
    audio_duration: payload.audio_duration || 240,
    thinking: true,
    infer_step: 8,
    guidance_scale: 7.0,
  };

  log('info', 'Submitting to ACE-Step', { body });

  const res = await httpJson(`${ACE_STEP_BASE}/release_task`, {
    method: 'POST',
    body,
  });

  if (res.status !== 200 || !res.json) {
    throw new Error(`ACE-Step submit failed (HTTP ${res.status}): ${res.text}`);
  }

  // ACE-Step API wraps responses in { data, code, error, timestamp }
  const envelope = res.json;
  if (envelope.error) {
    throw new Error(`ACE-Step submit error: ${JSON.stringify(envelope.error)}`);
  }

  return envelope.data || envelope;
}

async function pollAceStepResult(aceTaskId) {
  const start = Date.now();

  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const res = await httpJson(`${ACE_STEP_BASE}/query_result`, {
      method: 'POST',
      body: { task_id_list: [aceTaskId] },
    });

    if (res.status !== 200 || !res.json) {
      log('warn', 'Poll query_result non-200', { status: res.status, text: res.text });
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // ACE-Step API wraps responses in { data: [...], code, error, timestamp }
    const data = res.json.data || res.json;

    // data is an array of task results; find ours
    let taskResult;
    if (Array.isArray(data)) {
      taskResult = data.find(t => t.task_id === aceTaskId) || data[0];
    } else if (data[aceTaskId]) {
      taskResult = data[aceTaskId];
    } else {
      taskResult = data;
    }

    if (!taskResult) {
      log('debug', 'ACE-Step task not found in response, retrying...');
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // status=1 means done, status=0 means still processing, status=-1 means failed
    const status = taskResult.status;
    if (status === -1 || status === 'failed' || status === 'error') {
      throw new Error(`ACE-Step generation failed: ${JSON.stringify(taskResult)}`);
    }

    if (status === 1 || status === 'done' || status === 'completed' || status === 'success') {
      log('info', 'ACE-Step generation complete');
      return taskResult;
    }

    log('debug', 'ACE-Step still processing...', {
      elapsed: Math.round((Date.now() - start) / 1000),
      status,
    });

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`ACE-Step polling timed out after ${POLL_TIMEOUT_MS / 1000}s`);
}

function extractAudioPaths(taskResult) {
  // The result field may be a JSON string containing an array of track objects
  let tracks = taskResult.result;
  if (typeof tracks === 'string') {
    try { tracks = JSON.parse(tracks); } catch { tracks = null; }
  }

  // Extract "file" URLs from each track object
  if (Array.isArray(tracks)) {
    return tracks.map(t => t.file).filter(Boolean);
  }

  // Fallback: try common shapes
  if (taskResult.audio_paths && Array.isArray(taskResult.audio_paths)) {
    return taskResult.audio_paths;
  }
  if (taskResult.files && Array.isArray(taskResult.files)) {
    return taskResult.files;
  }
  if (taskResult.audio_path) return [taskResult.audio_path];
  if (taskResult.file) return [taskResult.file];
  return [];
}

// ---------------------------------------------------------------------------
// Audio download from ACE-Step
// ---------------------------------------------------------------------------

async function downloadAudio(remotePath, localPath) {
  // remotePath may already be a full URL path like "/v1/audio?path=..."
  const url = remotePath.startsWith('/v1/')
    ? `${ACE_STEP_BASE}${remotePath}`
    : `${ACE_STEP_BASE}/v1/audio?path=${encodeURIComponent(remotePath)}`;
  log('info', `Downloading audio: ${url}`);

  const res = await httpRequest(url);
  if (res.status !== 200) {
    throw new Error(`Audio download failed (HTTP ${res.status}) for ${remotePath}`);
  }

  fs.writeFileSync(localPath, res.body);
  log('info', `Downloaded audio to ${localPath} (${res.body.length} bytes)`);
}

// ---------------------------------------------------------------------------
// B2 upload via AWS CLI
// ---------------------------------------------------------------------------

function uploadToB2(localPath, remoteName) {
  // Strip any query params or path prefixes — keep only the filename
  let cleanName = remoteName.split('?')[0];
  cleanName = cleanName.split('/').pop();
  // Ensure .mp3 extension
  if (!cleanName.endsWith('.mp3')) cleanName += '.mp3';
  const s3Path = `s3://${B2_BUCKET}/${B2_MUSIC_PREFIX}/${cleanName}`;
  // Source env.vars for AWS credentials then upload
  const cmd = `source ~/env.vars && aws --endpoint-url https://$B2_ENDPOINT s3 cp "${localPath}" ${s3Path} --acl public-read`;
  log('info', `Uploading to B2: ${s3Path}`);
  execSync(cmd, { encoding: 'utf8', shell: '/bin/bash', timeout: 120000 });
  const publicUrl = `${B2_PUBLIC_URL}/${B2_MUSIC_PREFIX}/${cleanName}`;
  log('info', `Uploaded: ${publicUrl}`);
  return publicUrl;
}

// ---------------------------------------------------------------------------
// Task processing pipeline
// ---------------------------------------------------------------------------

async function processTask(taskId) {
  log('info', `Processing task ${taskId}`);

  // 1. Claim task (or verify it's already ours)
  try {
    atsClaimTask(taskId);
  } catch (err) {
    // Check if already assigned to us – if so, continue processing
    try {
      const current = atsGetTask(taskId);
      if (current.assignee_id === ACTOR.id && current.status === 'in_progress') {
        log('info', `Task ${taskId} already assigned to us, continuing`);
      } else {
        log('warn', `Could not claim task ${taskId} (status: ${current.status}, assignee: ${current.assignee_id})`, { error: err.message });
        return;
      }
    } catch {
      log('warn', `Could not claim task ${taskId}`, { error: err.message });
      return;
    }
  }

  // 2. Get task details
  const task = atsGetTask(taskId);
  const payload = task.payload || {};
  log('info', `Task payload`, { payload });

  if (!payload.prompt && !payload.lyrics) {
    atsFailTask(taskId, 'Task payload must include at least "prompt" or "lyrics"');
    return;
  }

  try {
    // 3. Submit to ACE-Step
    const submitResult = await submitToAceStep(payload);
    const aceTaskId = submitResult.task_id || submitResult.id;

    if (!aceTaskId) {
      throw new Error(`No task_id returned from ACE-Step: ${JSON.stringify(submitResult)}`);
    }

    log('info', `ACE-Step task created: ${aceTaskId}`);

    // 4. Poll for completion
    const aceResult = await pollAceStepResult(aceTaskId);

    // 5. Extract audio paths
    const audioPaths = extractAudioPaths(aceResult);

    if (audioPaths.length === 0) {
      throw new Error(`No audio files in ACE-Step result: ${JSON.stringify(aceResult)}`);
    }

    // 6. Download and upload each audio file
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'song-creator-'));
    const uploadedUrls = [];

    for (let i = 0; i < audioPaths.length; i++) {
      const audioPath = audioPaths[i];
      const finalRemoteName = `task-${taskId}-${i}.mp3`;
      const localPath = path.join(tmpDir, finalRemoteName);

      await downloadAudio(audioPath, localPath);
      const publicUrl = uploadToB2(localPath, finalRemoteName);
      uploadedUrls.push(publicUrl);

      // Clean up local file
      try { fs.unlinkSync(localPath); } catch { /* ignore */ }
    }

    // Clean up temp directory
    try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }

    // 7. Complete ATS task
    const outputs = {
      audio_urls: uploadedUrls,
      audio_count: uploadedUrls.length,
      ace_step_task_id: aceTaskId,
    };
    atsCompleteTask(taskId, outputs);

    log('info', `Task ${taskId} completed successfully`, { urls: uploadedUrls });
  } catch (err) {
    const reason = `${err.message || err}`;
    log('error', `Task ${taskId} failed`, { error: reason, stack: err.stack });
    try {
      atsFailTask(taskId, reason);
    } catch (failErr) {
      log('error', `Failed to mark task ${taskId} as failed`, { error: failErr.message });
    }
  }
}

// ---------------------------------------------------------------------------
// ATS watcher (spawns `ats watch` as a child process)
// ---------------------------------------------------------------------------

function startWatcher() {
  let reconnectDelay = RECONNECT_DELAY_MS;
  const processing = new Set(); // track in-flight task IDs to avoid double-processing

  function launch() {
    log('info', `Starting ATS watcher on channel "${ATS_CHANNEL}"`);

    const child = spawn('ats', [
      'watch',
      '--channel', ATS_CHANNEL,
      '--events', 'task.created',
      '-f', 'json',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buffer = '';

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        handleWatchLine(line.trim());
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) log('warn', `ats watch stderr: ${text}`);
    });

    child.on('close', (code) => {
      log('warn', `ats watch exited with code ${code}, reconnecting in ${reconnectDelay}ms`);
      setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_DELAY_MS);
        launch();
      }, reconnectDelay);
    });

    child.on('error', (err) => {
      log('error', `ats watch spawn error`, { error: err.message });
      setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_DELAY_MS);
        launch();
      }, reconnectDelay);
    });

    // Reset delay on successful data
    child.stdout.once('data', () => {
      reconnectDelay = RECONNECT_DELAY_MS;
    });
  }

  function handleWatchLine(line) {
    let taskId;

    // Try JSON first
    try {
      const event = JSON.parse(line);
      taskId = event.task_id || event.taskId || event.id ||
               (event.task && (event.task.id || event.task.task_id)) ||
               (event.data && (event.data.task_id || event.data.id));
    } catch {
      // ats watch table format: "  Task #175: Test Song 2"
      const match = line.match(/Task\s+#(\d+)/);
      if (match) {
        taskId = parseInt(match[1], 10);
      } else {
        // Ignore status/connection lines
        log('debug', `Non-event watch line: ${line}`);
        return;
      }
    }

    if (!taskId) {
      log('warn', 'Watch event missing task ID', { line });
      return;
    }

    if (processing.has(taskId)) {
      log('debug', `Task ${taskId} already being processed, skipping`);
      return;
    }

    processing.add(taskId);
    log('info', `New task event: ${taskId}`);

    processTask(taskId)
      .catch((err) => log('error', `Unhandled error for task ${taskId}`, { error: err.message }))
      .finally(() => processing.delete(taskId));
  }

  launch();
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  log('info', '=== Song Creator ATS Agent starting ===', {
    actor: ACTOR,
    channel: ATS_CHANNEL,
    aceStepBase: ACE_STEP_BASE,
  });

  // Verify ATS CLI is available
  try {
    const version = atsExec(['--help']).split('\n')[0];
    log('info', 'ATS CLI available', { version });
  } catch (err) {
    log('error', 'ATS CLI not available - is ats installed and configured?', { error: err.message });
    process.exit(1);
  }

  startWatcher();

  // Graceful shutdown
  const shutdown = (sig) => {
    log('info', `Received ${sig}, shutting down`);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
