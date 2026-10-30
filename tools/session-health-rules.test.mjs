#!/usr/bin/env node
/**
 * Deterministic replay of the two v1 rules against synthetic session logs.
 *
 * Builds frames with zstd, calls the real `summarize()` from the plugin's host
 * half, and asserts the counting behaviour from PRD §6.1/§6.2.
 *
 * Usage: node tools/session-health-rules.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const moduleUrl = new URL('../index.js', import.meta.url);
moduleUrl.searchParams.set('t', String(Date.now()));
const { summarize } = await import(moduleUrl.href);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-health-'));
let seq = 0;
let failures = 0;
let fileSeq = 0;

/** Write one synthetic session log from event objects. */
function writeLog(events) {
  const file = path.join(dir, `session-${(fileSeq += 1)}.jsonl.zstd`);
  const buffers = [];
  for (const event of events) {
    const record = { type: event.type, seq: typeof event.seq === 'number' ? event.seq : (seq += 1), time: event.time, data: event.data ?? {} };
    buffers.push(zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(record)}\n`)));
  }
  fs.writeFileSync(file, Buffer.concat(buffers));
  return summarize(file);
}

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  → ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`}`);
  if (!ok) failures += 1;
}

const call = (id, name, args, time) => ({ type: 'tool/call', time, data: { callId: id, name, arguments: JSON.stringify(args) } });
const result = (id, text, time, turn = 1, error) => ({
  type: 'tool/result',
  time,
  data: { turn, step: 1, toolCallId: id, message: { role: 'tool', source: { kind: 'tool', callId: id }, content: [{ type: 'text', text }] }, ...(error ? { error } : {}) },
});
const turnStart = (time, turn = 1) => ({ type: 'turn/start', time, data: { turn } });
const turnEnd = (time, turn = 1) => ({ type: 'turn/end', time, data: { turn, reason: { kind: 'completed' } } });
const usage = (time, total, out) => ({
  type: 'assistant/message',
  time,
  data: { usage: { totalTokens: total, outputTokens: out, inputTokens: total - out, cacheReadTokens: 0, cacheWriteTokens: 0 } },
});
const context = (time, size) => ({ type: 'request/context', time, data: { contextWindow: size } });

const T = 1_700_000_000_000;

// AC-04: 8 different URLs, same tool, same failure class, no success between.
{
  const events = [turnStart(T), context(T + 1, 1_000_000)];
  for (let i = 0; i < 8; i += 1) {
    events.push(call(`c${i}`, 'web_fetch', { url: `https://host${i}.example/x` }, T + 10 + i));
    events.push(result(`c${i}`, `Error: URL hostname "host${i}.example" resolves to a non-public IP address`, T + 11 + i, 1, { name: 'FetchError', code: 'URL_HOSTNAME' }));
  }
  const snap = writeLog(events);
  check('AC-04 count', snap.streak?.count, 8);
  check('AC-04 targets', snap.streak?.targets.length, 8);
  check('AC-04 category', snap.streak?.category, 'url-hostname');
}

// AC-02: success in between resets the streak.
{
  const events = [turnStart(T), call('a', 'web_fetch', { url: 'https://x/1' }, T + 1)];
  events.push(result('a', 'Error: URL hostname "x" resolves to a non-public IP address', T + 2, 1, { name: 'FetchError', code: 'URL_HOSTNAME' }));
  events.push(call('b', 'web_fetch', { url: 'https://x/2' }, T + 3));
  events.push(result('b', 'ok', T + 4));
  events.push(call('c', 'web_fetch', { url: 'https://x/3' }, T + 5));
  events.push(result('c', 'Error: URL hostname "x" resolves to a non-public IP address', T + 6, 1, { name: 'FetchError', code: 'URL_HOSTNAME' }));
  check('AC-02 no streak', writeLog(events).streak, null);
}

// A different failure class restarts the count at one.
{
  const events = [turnStart(T)];
  events.push(call('a', 'read', { file_path: '/x' }, T + 1));
  events.push(result('a', "Error: ENOENT: no such file or directory, open '/x'", T + 2, 1, { name: 'ToolError', code: 'ENOENT' }));
  events.push(call('b', 'read', { file_path: '/y' }, T + 3));
  events.push(result('b', 'Error: cannot modify "/y"', T + 4, 1, { name: 'ToolError', code: 'EACCES' }));
  check('class change resets', writeLog(events).streak, null);
}

// AC-06: cancellation and ordinary prose are not failures.
{
  const events = [turnStart(T)];
  events.push(call('a', 'bash', { command: 'sleep 10' }, T + 1));
  events.push(result('a', 'Error: tool call aborted by user', T + 2, 1, { name: 'ToolError', code: 'ABORTED' }));
  events.push(call('b', 'bash', { command: 'sleep 10' }, T + 3));
  events.push(result('b', 'Error: tool call aborted by user', T + 4, 1, { name: 'ToolError', code: 'ABORTED' }));
  check('cancellations never form a streak', writeLog(events).streak, null);

  const prose = [turnStart(T)];
  prose.push(call('a', 'read', { file_path: '/x' }, T + 1));
  prose.push(result('a', 'note: the code below raises an Error: but the read succeeded', T + 2));
  prose.push(call('b', 'read', { file_path: '/y' }, T + 3));
  prose.push(result('b', 'note: another Error: inside the body only', T + 4));
  check('prose mentioning Error is not a failure', writeLog(prose).streak, null);
}

// AC-07: the same event delivered twice counts once.
{
  const events = [
    { ...turnStart(T), seq: 1 },
    { ...call('a', 'read', { file_path: '/x' }, T + 1), seq: 2 },
    { ...result('a', 'Error: cannot read "/x": not found', T + 2, 1, { name: 'ToolError', code: 'ENOENT' }), seq: 3 },
    { ...result('a', 'Error: cannot read "/x": not found', T + 2, 1, { name: 'ToolError', code: 'ENOENT' }), seq: 3 },
  ];
  const snap = writeLog(events);
  check('duplicate seq counted once', snap.streak, null);
  check('duplicate seq leaves no history', snap.history.length, 0);
}

// "not found" and "permission denied" are different classes.
{
  const missing = [turnStart(T)];
  missing.push(call('a', 'read', { file_path: '/x' }, T + 1));
  missing.push(result('a', 'Error: cannot read "/x": not found', T + 2, 1, { name: 'ToolError', code: 'ENOENT' }));
  missing.push(call('b', 'read', { file_path: '/y' }, T + 3));
  missing.push(result('b', 'Error: cannot read "/y": not found', T + 4, 1, { name: 'ToolError', code: 'ENOENT' }));
  check('not found is fs-missing', writeLog(missing).streak?.category, 'fs-missing');
}

// Turn end keeps the hint as "previous turn" for 10 minutes, then drops it.
{
  const now = Date.now();
  const events = [turnStart(now - 120_000)];
  events.push(call('a', 'bash', { command: 'false' }, now - 119_000));
  events.push(result('a', '(no output) [exit code: 1]', now - 118_000));
  events.push(call('b', 'bash', { command: 'false' }, now - 117_000));
  events.push(result('b', '(no output) [exit code: 1]', now - 116_000));
  const open = writeLog(events);
  check('exit streak live', open.streak?.count, 2);
  check('exit streak live not recent', open.streak?.recent, false);

  const justEnded = writeLog([...events, turnEnd(now - 60_000)]);
  check('hint kept after turn end', justEnded.streak?.count, 2);
  check('hint marked recent', justEnded.streak?.recent, true);

  const longAgo = writeLog([...events, turnEnd(now - 11 * 60_000)]);
  check('hint expires after 10 min', longAgo.streak, null);

  const nextTurn = writeLog([...events, turnEnd(now - 60_000), turnStart(now - 30_000)]);
  check('new turn keeps the hint as previous turn', [nextTurn.streak?.recent, nextTurn.streak?.count], [true, 2]);
}

// Long job: below 300s is not reported, above is, settled never counts.
{
  const now = Date.now();
  const shortStart = now - 299_000;
  const longStart = now - 301_000;
  const short = writeLog([turnStart(T), { type: 'job/registered', time: T + 1, data: { jobId: 'j-short', kind: 'bash', label: 'x', startedAt: shortStart } }]);
  check('long job 299s hidden', short.longJob, null);
  const long = writeLog([turnStart(T), { type: 'job/registered', time: T + 1, data: { jobId: 'j-long', kind: 'bash', label: 'x', startedAt: longStart } }]);
  check('long job 301s shown', long.longJob?.jobId, 'j-long');
  check('long job unconfirmed', long.longJob?.confirmed, false);
  const settled = writeLog([
    turnStart(T),
    { type: 'job/registered', time: T + 1, data: { jobId: 'j2', kind: 'bash', label: 'x', startedAt: longStart } },
    { type: 'job/settled', time: T + 5, data: { jobId: 'j2', status: 'completed' } },
  ]);
  check('settled job not reported', settled.longJob, null);
}

// A job still open when its turn ends stops nagging, and lands in history.
{
  const now = Date.now();
  const snap = writeLog([
    turnStart(now - 400_000),
    { type: 'job/registered', time: now - 390_000, data: { jobId: 'j-end', kind: 'bash', label: 'x', startedAt: now - 390_000 } },
    turnEnd(now - 60_000),
  ]);
  check('open job is retired at turn end', snap.longJob, null);
  const entry = snap.history.find((item) => item.jobId === 'j-end');
  check('retired job records why', entry?.endedBy, 'turn-ended');
}

// Token identity: fill = (total - output) / window.
{
  const snap = writeLog([turnStart(T), context(T + 1, 1_000_000), usage(T + 2, 30_000, 1_000)]);
  check('fill from identity', snap.fill, 0.029);
}

// History: closed hints are kept with the reason they closed.
{
  const now = Date.now();
  const events = [turnStart(now - 300_000)];
  events.push(call('a', 'read', { file_path: '/x' }, now - 299_000));
  events.push(result('a', 'Error: cannot read "/x": not found', now - 298_000, 1, { name: 'ToolError', code: 'ENOENT' }));
  events.push(call('b', 'read', { file_path: '/y' }, now - 297_000));
  events.push(result('b', 'Error: cannot read "/y": not found', now - 296_000, 1, { name: 'ToolError', code: 'ENOENT' }));
  const nextTurnFailures = [
    ...events,
    turnStart(now - 295_000, 2),
    call('c', 'read', { file_path: '/z' }, now - 294_000),
    result('c', 'Error: cannot read "/z": not found', now - 293_000, 2, { name: 'ToolError', code: 'ENOENT' }),
  ];
  const closedByTurn = writeLog(nextTurnFailures);
  check('history keeps closed streak', closedByTurn.history?.length, 1);
  check('history records the closing reason', closedByTurn.history?.[0]?.endedBy, 'next-turn');

  const closedBySuccess = [turnStart(now - 300_000)];
  closedBySuccess.push(call('a', 'read', { file_path: '/x' }, now - 299_000));
  closedBySuccess.push(result('a', 'Error: cannot read "/x": not found', now - 298_000, 1, { name: 'ToolError', code: 'ENOENT' }));
  closedBySuccess.push(call('b', 'read', { file_path: '/y' }, now - 297_000));
  closedBySuccess.push(result('b', 'Error: cannot read "/y": not found', now - 296_000, 1, { name: 'ToolError', code: 'ENOENT' }));
  closedBySuccess.push(call('c', 'read', { file_path: '/z' }, now - 295_000));
  closedBySuccess.push(result('c', 'ok', now - 294_000));
  const bySuccess = writeLog(closedBySuccess);
  check('success closes into history', bySuccess.history?.[0]?.endedBy, 'success');
  check('success clears the live hint', bySuccess.streak, null);
}

// Long jobs that crossed the threshold leave a history entry when they settle.
{
  const now = Date.now();
  const events = [turnStart(now - 600_000), { type: 'job/registered', time: now - 590_000, data: { jobId: 'j1', kind: 'bash', label: 'build', startedAt: now - 590_000 } }];
  const settled = writeLog([...events, { type: 'job/settled', time: now - 100_000, data: { jobId: 'j1', status: 'completed', finishedAt: now - 100_000 } }]);
  check('long job lands in history', settled.history?.length, 1);
  check('long job history keeps status', settled.history?.[0]?.endedBy, 'completed');
}

console.log(failures === 0 ? '\nall rule replays passed' : `\n${failures} replay(s) failed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
