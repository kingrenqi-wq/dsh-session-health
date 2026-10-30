/**
 * Host half of the session-health bundle.
 *
 * Reads the current session's log incrementally and returns a small snapshot:
 * context fill, plus two kinds of hints (repeated same-tool failures, a task
 * that has not finished). Read-only: it never writes to the sessions directory.
 *
 * Route: POST /_dsh/dsh-session-health/<method>, JSON in/out, same-origin only.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const ROUTE = '/_dsh/dsh-session-health';
const SESSIONS_ROOT = process.env.DSH_SESSION_HEALTH_ROOT ?? path.join(os.homedir(), '.dsh', 'sessions');
const MAX_BODY = 8 * 1024;
const STREAK_TRIGGER = 2;
const LONG_JOB_MS = 300_000;
const UNCONFIRMED_RETIRE_MS = 30 * 60_000;
const RECENT_MS = 10 * 60_000;
const MAX_CALLS = 5000;
const MAX_HISTORY = 50;
const TAIL_BYTES = 32;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/** file path -> parsed state */
const states = new Map();

// ── HTTP plumbing ──────────────────────────────────────────────────────────

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function respond(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

// ── Session lookup ─────────────────────────────────────────────────────────

/** Resolve one session id to a file that really sits under the sessions root. */
function locate(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || sessionId.includes('..')) return void 0;
  let workspaces;
  try {
    workspaces = fs.readdirSync(SESSIONS_ROOT);
  } catch {
    return void 0;
  }
  const rootReal = fs.realpathSync(SESSIONS_ROOT);
  for (const workspace of workspaces) {
    for (const candidate of [sessionId, `session-${sessionId}`]) {
      const file = path.join(SESSIONS_ROOT, workspace, candidate, 'session.v4.jsonl.zstd');
      let real;
      try {
        real = fs.realpathSync(file);
      } catch {
        continue;
      }
      if (!real.startsWith(`${rootReal}${path.sep}`)) continue;
      return real;
    }
  }
  return void 0;
}

// ── zstd frames ────────────────────────────────────────────────────────────

/** A skippable frame (magic 0x184D2A50..5F) carries a 4-byte length and a payload. */
function skippableEnd(buffer, start) {
  if (start + 4 > buffer.length) return { status: 'incomplete', end: start };
  if ((buffer[start] & 0xf0) !== 0x50 || buffer[start + 1] !== 0x2a
    || buffer[start + 2] !== 0x4d || buffer[start + 3] !== 0x18) return { status: 'none', end: start };
  if (start + 8 > buffer.length) return { status: 'incomplete', end: start };
  const size = buffer.readUInt32LE(start + 4);
  const end = start + 8 + size;
  return end <= buffer.length ? { status: 'complete', end } : { status: 'incomplete', end: start };
}

/**
 * Where one zstd frame ends.
 * @returns {{status:'complete'|'incomplete'|'invalid', end:number}}
 */
function frameEnd(buffer, start) {
  if (start + 4 > buffer.length) return { status: 'incomplete', end: start };
  if (buffer[start] !== 0x28 || buffer[start + 1] !== 0xb5
    || buffer[start + 2] !== 0x2f || buffer[start + 3] !== 0xfd) return { status: 'invalid', end: start };
  let p = start + 4;
  if (p >= buffer.length) return { status: 'incomplete', end: start };
  const descriptor = buffer[p];
  p += 1;
  const fcsFlag = descriptor >> 6;
  const singleSegment = (descriptor >> 5) & 1;
  const checksum = (descriptor >> 2) & 1;
  const dictFlag = descriptor & 3;
  if (!singleSegment) {
    if (p >= buffer.length) return { status: 'incomplete', end: start };
    p += 1; /* window descriptor */
  }
  const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
  p += fcsSize + [0, 1, 2, 4][dictFlag];
  if (p > buffer.length) return { status: 'incomplete', end: start };
  for (;;) {
    if (p + 3 > buffer.length) return { status: 'incomplete', end: start };
    const header = buffer[p] | (buffer[p + 1] << 8) | (buffer[p + 2] << 16);
    p += 3;
    const last = header & 1;
    const type = (header >> 1) & 3;
    const size = header >>> 3;
    if (type === 3) return { status: 'invalid', end: start };
    p += type === 1 ? 1 : size;
    if (p > buffer.length) return { status: 'incomplete', end: start };
    if (last === 1) break;
  }
  if (checksum === 1) p += 4;
  if (p > buffer.length) return { status: 'incomplete', end: start };
  return { status: 'complete', end: p };
}

// ── State ──────────────────────────────────────────────────────────────────

function freshState(generation = 1) {
  return {
    generation,
    dev: -1,
    ino: -1,
    head: '',
    tail: '',
    prefixHash: '',
    cursor: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    size: 0,
    events: 0,
    gap: null,
    outOfOrder: false,
    lastSeq: -1,
    contextWindow: 0,
    tokens: 0,
    sampledAt: 0,
    sampleValid: false,
    lastEventAt: 0,
    turn: 0,
    turnOpen: false,
    compacting: false,
    streaks: new Map(),
    history: [],
    openJobs: new Map(),
    calls: new Map(),
    settledCalls: new Set(),
    seen: new Set(),
    lastUsageSeq: -1,
    lastTurnStarted: -1,
  };
}

function pushHistory(state, entry) {
  state.history.push(entry);
  if (state.history.length > MAX_HISTORY) state.history.shift();
}

function closeStreak(state, tool, at, by) {
  const streak = state.streaks.get(tool);
  if (streak !== void 0 && streak.count >= STREAK_TRIGGER) {
    pushHistory(state, {
      rule: 'streak',
      tool: streak.tool,
      category: streak.category,
      count: streak.count,
      targets: streak.targets.slice(0, 5),
      targetCount: streak.targets.length,
      firstSeq: streak.firstSeq,
      lastSeq: streak.lastSeq,
      startedAt: streak.firstAt,
      endedAt: at,
      endedBy: by,
    });
  }
  state.streaks.delete(tool);
}

function closeAllStreaks(state, at, by) {
  for (const tool of [...state.streaks.keys()]) closeStreak(state, tool, at, by);
}

/** Map a structured error to a stable category. */
function categoryOf(code, name) {
  const raw = `${code ?? ''} ${name ?? ''}`.toUpperCase();
  if (/TIMEOUT/.test(raw)) return 'timeout';
  if (/HOSTNAME|URL/.test(raw)) return 'url-hostname';
  if (/ENOENT|NOT_FOUND/.test(raw)) return 'fs-missing';
  if (/EACCES|EPERM|PERMISSION/.test(raw)) return 'fs-denied';
  return `error:${String(code ?? name ?? 'unknown').toLowerCase().slice(0, 24)}`;
}

const SHELL_TOOLS = new Set(['bash', 'pwsh', 'shell', 'terminal', 'bash_persistent']);

/**
 * Classify one failure. The structured `data.error` wins; a non-zero exit code
 * counts only for shell tools, where that marker is part of the tool's protocol.
 * Cancellation is kept separate from failures.
 */
function failureOf(event, call) {
  const data = event.data ?? {};
  if (event.type === 'job/settled' && data.status && data.status !== 'completed') {
    if (data.status === 'cancelled' || data.status === 'canceled') return { cancelled: true };
    if (call === void 0) return void 0;
    return { category: `job-${data.status}`, target: String(data.label ?? data.jobId ?? '').slice(0, 120), at: event.time, seq: event.seq };
  }
  if (event.type !== 'tool/result') return void 0;
  if (call === void 0) return void 0; /* unknown call: never guess a tool name */
  const error = data.error;
  if (error !== void 0 && error !== null) {
    const code = typeof error === 'string' ? error : (error.code ?? error.name);
    const name = typeof error === 'string' ? void 0 : error.name;
    const raw = `${code ?? ''} ${name ?? ''}`;
    if (/abort|cancel/i.test(raw)) return { cancelled: true };
    return { category: categoryOf(code, name), target: call.target ?? '', at: event.time, seq: event.seq };
  }
  if (SHELL_TOOLS.has(call.name) && Array.isArray(data.message?.content)) {
    const text = data.message.content.map((part) => part.text ?? '').join('');
    const exit = text.match(/\[exit code:\s*(\d+)\]\s*$/)?.[1];
    if (exit !== void 0 && exit !== '0') return { category: `exit-${exit}`, target: call.target ?? '', at: event.time, seq: event.seq };
  }
  return void 0;
}

function targetOf(args) {
  const value = args?.file_path ?? args?.path ?? args?.url ?? args?.pattern ?? args?.command;
  return typeof value === 'string' ? value.slice(0, 120) : '';
}

/** usage is only trusted when the four buckets add up to the reported total. */
function usageOf(data) {
  const usage = data.usage;
  if (usage === void 0) return void 0;
  const { inputTokens: input, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write } = usage;
  const values = [input, output, read, write, usage.totalTokens];
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)) return void 0;
  if (usage.totalTokens !== input + output + read + write) return void 0;
  return { total: usage.totalTokens, output };
}

function applyEvent(state, event, call, turnOfEvent) {
  if (Number.isFinite(event.seq)) {
    if (state.seen.has(event.seq)) return;
    if (event.seq < state.lastSeq) {
      /* Continuity is gone: do not pretend a streak survived it. */
      state.outOfOrder = true;
      state.gap = state.gap ?? 'out-of-order';
      closeAllStreaks(state, event.time, 'out-of-order');
    }
    state.seen.add(event.seq);
    if (state.seen.size > MAX_CALLS) state.seen.delete(state.seen.values().next().value);
    if (event.seq > state.lastSeq) state.lastSeq = event.seq;
  }
  const data = event.data ?? {};
  state.events += 1;
  if (typeof event.time === 'number' && event.time > state.lastEventAt) state.lastEventAt = event.time;

  if (event.type === 'turn/start') {
    const next = data.turn ?? state.turn + 1;
    if (next < state.lastTurnStarted) return; /* replayed older turn */
    /* Keep the previous turn's hint visible (as "previous turn") until it ages out. */
    for (const streak of state.streaks.values()) if (streak.endedAt === void 0) streak.endedAt = event.time;
    state.lastTurnStarted = next;
    state.turn = next;
    state.turnOpen = true;
    return;
  }
  if (event.type === 'turn/end') {
    state.turnOpen = false;
    for (const streak of state.streaks.values()) if (streak.endedAt === void 0) streak.endedAt = event.time;
    return;
  }
  if (event.type === 'compaction/start') {
    state.compacting = true;
    state.sampleValid = false;
    return;
  }
  if (event.type === 'compaction/end' || event.type === 'compaction/summary') {
    state.compacting = false;
    return;
  }
  if (event.type === 'request/context' && Number.isFinite(data.contextWindow) && data.contextWindow > 0) {
    if (state.contextWindow !== data.contextWindow && state.sampledAt > 0) state.sampleValid = false;
    state.contextWindow = data.contextWindow;
    return;
  }
  if (event.type === 'assistant/message') {
    if (Number.isFinite(event.seq) && event.seq < state.lastUsageSeq) return; /* older request */
    const usage = usageOf(data);
    if (usage === void 0) {
      /* A broken usage must not leave the previous snapshot looking current. */
      if (data.usage !== void 0) state.sampleValid = false;
      return;
    }
    state.tokens = usage.total - usage.output;
    state.sampledAt = event.time ?? state.sampledAt;
    state.sampleValid = true;
    if (Number.isFinite(event.seq)) state.lastUsageSeq = event.seq;
    return;
  }
  if (event.type === 'job/registered' && data.jobId) {
    state.openJobs.set(data.jobId, {
      jobId: data.jobId,
      kind: data.kind ?? 'job',
      label: String(data.label ?? '').slice(0, 120),
      startedAt: data.startedAt ?? event.time,
    });
    return;
  }
  if (event.type === 'job/settled' && data.jobId) {
    const job = state.openJobs.get(data.jobId);
    state.openJobs.delete(data.jobId);
    const endedAt = data.finishedAt ?? event.time;
    if (job !== void 0 && endedAt - job.startedAt >= LONG_JOB_MS) {
      pushHistory(state, { rule: 'longJob', jobId: job.jobId, kind: job.kind, label: job.label, startedAt: job.startedAt, endedAt, endedBy: data.status ?? 'done', count: 1, targetCount: 0 });
    }
    return;
  }

  if (event.type !== 'tool/result') return;
  if (call === void 0) return;
  const failure = failureOf(event, call);
  if (turnOfEvent !== void 0 && turnOfEvent !== state.turn) {
    if (failure !== void 0 && failure.cancelled !== true) {
      pushHistory(state, { rule: 'streak', tool: call.name, category: failure.category ?? 'unknown', count: 1, targets: [], targetCount: 0, firstSeq: event.seq, lastSeq: event.seq, startedAt: event.time, endedAt: event.time, endedBy: 'late-turn' });
    }
    return;
  }
  if (failure === void 0) {
    if (state.streaks.has(call.name)) closeStreak(state, call.name, event.time, 'success');
    return;
  }
  if (failure.cancelled === true) {
    closeStreak(state, call.name, event.time, 'cancel');
    return;
  }
  const current = state.streaks.get(call.name);
  if (current !== void 0 && current.turn !== state.turn) {
    closeStreak(state, call.name, event.time, 'next-turn');
  }
  const open = state.streaks.get(call.name);
  if (open !== void 0 && open.category === failure.category) {
    open.count += 1;
    open.lastSeq = failure.seq;
    open.lastAt = failure.at;
    if (failure.target && !open.targets.includes(failure.target)) open.targets.push(failure.target);
    return;
  }
  closeStreak(state, call.name, event.time, 'new-class');
  state.streaks.set(call.name, {
    endedAt: void 0,
    turn: state.turn,
    tool: call.name,
    category: failure.category,
    count: 1,
    targets: failure.target ? [failure.target] : [],
    firstSeq: failure.seq,
    firstAt: failure.at,
    lastSeq: failure.seq,
    lastAt: failure.at,
  });
}

/** Decode complete frames from the cursor; stop only at a genuinely incomplete tail. */
function ingest(state, buffer, base) {
  let p = 0;
  while (p < buffer.length) {
    const skip = skippableEnd(buffer, p);
    if (skip.status === 'incomplete') break;
    if (skip.status === 'complete') { p = skip.end; continue; }
    const frame = frameEnd(buffer, p);
    if (frame.status === 'incomplete') break;
    if (frame.status === 'invalid') {
      state.gap = state.gap ?? 'invalid-frame';
      state.sampleValid = false;
      closeAllStreaks(state, state.lastEventAt, 'integrity');
      break;
    }
    let text = null;
    try {
      text = zlib.zstdDecompressSync(buffer.subarray(p, frame.end)).toString('utf8');
    } catch {
      state.gap = state.gap ?? 'decode-failed';
      state.sampleValid = false;
      closeAllStreaks(state, state.lastEventAt, 'integrity');
    }
    if (text !== null) {
      for (const line of text.trim().split('\n')) {
        if (line.length === 0) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          state.gap = state.gap ?? 'bad-json';
          state.sampleValid = false;
          closeAllStreaks(state, state.lastEventAt, 'integrity');
          continue;
        }
        let call;
        if (event.type === 'tool/call') {
          const id = event.data?.callId;
          if (id !== void 0 && !state.calls.has(id)) {
            let args = {};
            try { args = JSON.parse(event.data?.arguments ?? '{}'); } catch { args = {}; }
            call = { name: event.data?.name ?? 'tool', target: targetOf(args), turn: event.data?.turn ?? state.turn };
            state.calls.set(id, call);
            if (state.calls.size > MAX_CALLS) state.calls.delete(state.calls.keys().next().value);
          } else {
            call = state.calls.get(id);
          }
        } else if (event.type === 'tool/result') {
          const id = event.data?.message?.source?.callId ?? event.data?.toolCallId;
          call = state.calls.get(id);
          if (id !== void 0 && state.settledCalls.has(id)) continue; /* one terminal result per call */
          if (id !== void 0) {
            state.settledCalls.add(id);
            if (state.settledCalls.size > MAX_CALLS) state.settledCalls.delete(state.settledCalls.values().next().value);
          }
        }
        applyEvent(state, event, call, call?.turn);
      }
    }
    p = frame.end;
  }
  state.cursor = base + p;
}

/** Read exactly `length` bytes; a short read is reported to the caller. */
function readAt(fd, offset, length) {
  const buffer = Buffer.alloc(length);
  if (length === 0) return buffer;
  let read = 0;
  while (read < length) {
    const n = fs.readSync(fd, buffer, read, length - read, offset + read);
    if (n <= 0) break;
    read += n;
  }
  return read === length ? buffer : buffer.subarray(0, read);
}

/** Hash of everything already consumed: appends keep it, rewrites break it. */
function hashPrefix(fd, cursor) {
  const hash = crypto.createHash('sha256');
  const chunk = 1 << 20;
  for (let offset = 0; offset < cursor; offset += chunk) {
    hash.update(readAt(fd, offset, Math.min(chunk, cursor - offset)));
  }
  return hash.digest('hex');
}

function identityOf(stat) {
  return `${stat.dev}:${stat.ino}`;
}

/** Snapshot of the session file, parsed incrementally. */
function summarize(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (error) {
    states.delete(file);
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    let state = states.get(file);
    const replaced = state !== void 0 && identityOf(state) !== identityOf(stat);
    const shrunk = state !== void 0 && stat.size < state.size;
    if (state === void 0 || replaced || shrunk) {
      state = freshState(state === void 0 ? 1 : state.generation + 1);
      state.dev = stat.dev;
      state.ino = stat.ino;
      states.set(file, state);
    }
    /* The bytes just before the cursor must still be the ones we consumed. */
    if (state.cursor > 0 && state.cursor <= stat.size) {
      const keep = Math.min(TAIL_BYTES, state.cursor);
      const tail = readAt(fd, state.cursor - keep, keep).toString('hex');
      if (tail !== state.tail) {
        state = freshState(state.generation + 1);
        state.dev = stat.dev;
        state.ino = stat.ino;
        states.set(file, state);
      }
    }
    if (state.size === stat.size && state.cursor > 0 && (stat.mtimeMs !== state.mtimeMs || stat.ctimeMs !== state.ctimeMs)) {
      /* Same length, different timestamp: the bytes were rewritten in place. */
      state = freshState(state.generation + 1);
      state.dev = stat.dev;
      state.ino = stat.ino;
      states.set(file, state);
    }
    /* Everything already consumed must still hash the same; a rewrite anywhere breaks it. */
    const changed = stat.size !== state.size || stat.mtimeMs !== state.mtimeMs || stat.ctimeMs !== state.ctimeMs;
    if (changed && state.cursor > 0 && state.prefixHash !== '') {
      if (hashPrefix(fd, state.cursor) !== state.prefixHash) {
        state = freshState(state.generation + 1);
        state.dev = stat.dev;
        state.ino = stat.ino;
        states.set(file, state);
      }
    }
    if (state.size !== stat.size) {
      const want = Math.max(0, stat.size - state.cursor);
      const buffer = readAt(fd, state.cursor, want);
      if (buffer.length < want) state.gap = state.gap ?? 'short-read';
      else ingest(state, buffer, state.cursor);
      state.size = stat.size;
    }
    state.mtimeMs = stat.mtimeMs;
    state.ctimeMs = stat.ctimeMs;
    if (state.cursor > 0) {
      const keep = Math.min(TAIL_BYTES, state.cursor);
      state.tail = readAt(fd, state.cursor - keep, keep).toString('hex');
      /* Keep the fingerprint in step with the cursor, or every append looks like a rewrite. */
      if (changed || state.prefixHash === '') state.prefixHash = hashPrefix(fd, state.cursor);
    }
    if (state.head === '' && stat.size > 0) state.head = readAt(fd, 0, Math.min(64, stat.size)).toString('hex');
    return decorate(state, Date.now());
  } finally {
    fs.closeSync(fd);
  }
}

/** Jobs with no evidence for 30 minutes leave the live state and become history. */
function retireStaleJobs(state, now) {
  for (const job of [...state.openJobs.values()]) {
    if (now - job.startedAt <= UNCONFIRMED_RETIRE_MS) continue;
    state.openJobs.delete(job.jobId);
    pushHistory(state, { rule: 'longJob', jobId: job.jobId, kind: job.kind, label: job.label, startedAt: job.startedAt, endedAt: now, endedBy: 'unconfirmed', count: 1, targetCount: 0 });
  }
}

/** Add age-dependent fields and pick the hint worth showing. */
function decorate(state, now) {
  retireStaleJobs(state, now);
  let streak = null;
  for (const candidate of state.streaks.values()) {
    if (candidate.count < STREAK_TRIGGER) continue;
    const endedAt = candidate.endedAt;
    if (endedAt !== void 0 && now - endedAt > RECENT_MS) continue;
    if (streak === null || candidate.lastAt > streak.lastAt) streak = candidate;
  }
  let longJob = null;
  for (const job of state.openJobs.values()) {
    const age = Math.max(0, now - job.startedAt);
    if (age < LONG_JOB_MS || age > UNCONFIRMED_RETIRE_MS) continue;
    if (longJob === null || job.startedAt < longJob.startedAt) longJob = job;
  }
  const ageMs = longJob === null ? 0 : Math.max(0, now - longJob.startedAt);
  return {
    generation: state.generation,
    events: state.events,
    integrity: state.gap ?? (state.outOfOrder ? 'out-of-order' : null),
    turn: state.turn,
    turnOpen: state.turnOpen,
    contextWindow: state.contextWindow,
    tokens: state.tokens,
    fill: state.sampleValid && state.contextWindow > 0 ? state.tokens / state.contextWindow : null,
    compacting: state.compacting,
    sampleValid: state.sampleValid,
    sampledAt: state.sampledAt || null,
    lastEventAt: state.lastEventAt || null,
    streak: streak === null ? null : { ...streak, recent: streak.endedAt !== void 0 },
    longJob: longJob === null ? null : { ...longJob, ageMs, confirmed: false },
    history: state.history.slice(-8),
    file: { size: state.size, cursor: state.cursor },
    now,
  };
}

export { summarize };

function handleSnapshot(body) {
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
  if (sessionId === '') return { ok: false, error: 'sessionId required' };
  const file = locate(sessionId);
  if (file === void 0) {
    for (const key of states.keys()) {
      if (key.includes(`${path.sep}${sessionId}${path.sep}`) || key.includes(`${path.sep}session-${sessionId}${path.sep}`)) states.delete(key);
    }
    return { ok: true, sessionId, found: false };
  }
  try {
    return { ok: true, sessionId, found: true, file, ...summarize(file) };
  } catch (error) {
    return { ok: false, sessionId, error: String(error?.message ?? error) };
  }
}

export function apply(ctx) {
  ctx.inject(['connection', 'webServer'], (webCtx) => {
    webCtx.effect(() => {
      const dispose = webCtx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: async (req, res) => {
          let method = '';
          try {
            const rejection = webCtx.connection.requestRejection(req);
            if (rejection !== void 0) {
              respond(res, rejection, { ok: false, error: 'request rejected' });
              return;
            }
            const url = new URL(req.url ?? '/', 'http://localhost');
            if (!url.pathname.startsWith(`${ROUTE}/`)) {
              respond(res, 404, { ok: false, error: 'not found' });
              return;
            }
            method = decodeURIComponent(url.pathname.slice(ROUTE.length + 1));
            if (req.method !== 'POST') {
              respond(res, 405, { ok: false, error: 'POST required' });
              return;
            }
            const raw = await readBody(req, MAX_BODY);
            let body = {};
            if (raw.length > 0) {
              try { body = JSON.parse(raw); } catch { respond(res, 400, { ok: false, error: 'invalid JSON' }); return; }
            }
            if (method === 'health') {
              respond(res, 200, { ok: true, method, at: Date.now() });
              return;
            }
            if (method === 'snapshot') {
              respond(res, 200, handleSnapshot(body));
              return;
            }
            respond(res, 404, { ok: false, error: `unknown method: ${method}` });
          } catch (error) {
            console.warn('[dsh-session-health] route failed:', String(error?.stack ?? error));
            if (!res.headersSent) respond(res, 500, { ok: false, error: 'internal error' });
            else res.destroy(error);
          }
        },
      });
      return () => dispose();
    }, 'dsh-session-health: web routes');
  });
}
