#!/usr/bin/env node
/**
 * Regression cases from the 2026-10-30 source review (F01–F14).
 *
 * Each case reproduces one reviewer counter-example and asserts the CORRECT
 * behaviour (the reviewer's own scripts assert the broken behaviour).
 *
 * Usage: node tools/session-health-regressions.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { EventEmitter } from 'node:events';

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-health-reg-'));
process.env.DSH_SESSION_HEALTH_ROOT = workdir;
const ws = path.join(workdir, 'ws');
fs.mkdirSync(ws, { recursive: true });

const moduleUrl = new URL('../index.js', import.meta.url);
moduleUrl.searchParams.set('t', String(Date.now()));
const { summarize, apply } = await import(moduleUrl.href);

const T = Date.now();
const e = (type, seq, data = {}, time = T) => ({ type, seq, time, data });
const frame = (record) => zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(record)}\n`));
const bytes = (events) => Buffer.concat(events.map(frame));
const start = (seq, turn) => e('turn/start', seq, { turn });
const call = (seq, id, name = 'read', turn = 1) => e('tool/call', seq, { callId: id, name, turn, arguments: JSON.stringify({ path: `/fixture/${id}` }) });
const result = (seq, id, text, turn = 1, error) => e('tool/result', seq, { turn, toolCallId: id, message: { source: { callId: id }, content: [{ type: 'text', text }] }, ...(error ? { error } : {}) });
const fail = (seq, id, turn = 1) => result(seq, id, 'Error: ENOENT: missing fixture', turn, { name: 'ToolError', code: 'ENOENT' });
const usage = (seq, n, total) => e('assistant/message', seq, { usage: { totalTokens: total ?? n + 10, outputTokens: 10, inputTokens: n, cacheReadTokens: 0, cacheWriteTokens: 0 } });
const ctx = (seq, window = 1000) => e('request/context', seq, { contextWindow: window });

let fileNo = 0;
let failures = 0;
function write(events) {
  const file = path.join(ws, `s${(fileNo += 1)}`, 'session.v4.jsonl.zstd');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes(events));
  return file;
}
function check(name, ok, extra = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures += 1;
}

// F04 / H1 — another tool's failure must not break this tool's sequence.
{
  const snap = summarize(write([start(1, 1), call(2, 'a'), fail(3, 'a'), call(4, 'x', 'web_fetch'), fail(5, 'x'), call(6, 'b'), fail(7, 'b')]));
  check('H1 read streak survives another tool', snap.streak?.tool === 'read' && snap.streak?.count === 2, JSON.stringify(snap.streak));
}

// F05 / H2 — late results from a finished turn are not counted in the new turn.
{
  const snap = summarize(write([start(1, 1), call(2, 'old-a'), call(3, 'old-b'), e('turn/end', 4, { turn: 1 }), start(5, 2), fail(6, 'old-a', 1), fail(7, 'old-b', 1)]));
  check('H2 late results do not form a streak', snap.streak === null, JSON.stringify(snap.streak));
  check('H2 late results are kept as history', snap.history.some((item) => item.endedBy === 'late-turn'), `${snap.history.length} history`);
}

// F06 / H3 — an out-of-order seq must not silently drop the success.
{
  const snap = summarize(write([start(1, 1), call(2, 'a'), call(3, 'ok'), fail(4, 'a'), call(7, 'b'), result(6, 'ok', 'ok'), fail(8, 'b')]));
  check('H3 out-of-order marks integrity', snap.integrity === 'out-of-order', String(snap.integrity));
  check('H3 out-of-order does not claim a streak', snap.streak === null, JSON.stringify(snap.streak));
}

// F08 / H4 — an Error: line inside a successfully read document is not a failure.
{
  const snap = summarize(write([start(1, 1), call(2, 'a'), result(3, 'a', 'Document header\nError: ENOENT example shown in documentation\nDocument footer'), call(4, 'b'), result(5, 'b', 'Another document\nError: ENOENT example shown in documentation\nEnd')]));
  check('H4 body Error is not a failure', snap.streak === null, JSON.stringify(snap.streak));
}

// F01 / H5 — same prefix, larger, different inode: must rebuild, not append.
{
  const common = bytes([start(1, 1), ctx(2)]);
  const old = Buffer.concat([common, frame(e('job/registered', 3, { jobId: 'old-job', startedAt: T - 400_000 })), frame(usage(4, 700))]);
  const file = path.join(ws, 'replacement', 'session.v4.jsonl.zstd');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, old);
  const before = summarize(file);
  const replacement = Buffer.concat([
    common,
    frame(e('assistant/message', 3, { usage: { totalTokens: 110, outputTokens: 10, inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }, padding: 'B'.repeat(2000) })),
    frame(e('padding', 4, { text: 'x'.repeat(2000) })),
  ]);
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, replacement);
  fs.renameSync(temp, file);
  const after = summarize(file);
  check('H5 replacement rebuilds generation', after.generation === before.generation + 1, `gen ${before.generation} → ${after.generation}`);
  check('H5 replacement reports the new token count', Math.abs((after.fill ?? 0) - 0.1) < 1e-9, String(after.fill));
  check('H5 replacement drops the old job', after.longJob === null, JSON.stringify(after.longJob));
}

// F02 / H6 — a skippable frame in the middle must not stop the reader.
{
  const skippable = Buffer.concat([Buffer.from([0x50, 0x2a, 0x4d, 0x18]), Buffer.from([1, 0, 0, 0]), Buffer.from([0x00])]);
  const file = path.join(ws, 'skippable', 'session.v4.jsonl.zstd');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([bytes([start(1, 1), ctx(2)]), skippable, frame(usage(3, 100))]));
  const snap = summarize(file);
  check('H6 skippable frame is skipped', Math.abs((snap.fill ?? 0) - 0.1) < 1e-9, String(snap.fill));
}

// F02 / H7 — an invalid block header invalidates the sample instead of keeping it.
{
  const file = path.join(ws, 'invalid', 'session.v4.jsonl.zstd');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes([start(1, 1), ctx(2), usage(3, 700)]));
  const good = summarize(file);
  fs.appendFileSync(file, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x01, 0x07, 0x00, 0x00]));
  const bad = summarize(file);
  check('H7 invalid frame is reported', bad.integrity === 'invalid-frame', String(bad.integrity));
  check('H7 invalid frame invalidates the sample', bad.sampleValid === false && bad.fill === null, `fill ${bad.fill}`);
  check('H7 the earlier value was valid', good.fill !== null);
}

// F02 / H8 — a complete frame with broken JSON invalidates the sample.
{
  const file = path.join(ws, 'badjson', 'session.v4.jsonl.zstd');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes([start(1, 1), ctx(2), usage(3, 700)]));
  summarize(file);
  fs.appendFileSync(file, zlib.zstdCompressSync(Buffer.from('{broken json}\n')));
  const snap = summarize(file);
  check('H8 broken JSON is reported', snap.integrity === 'bad-json', String(snap.integrity));
  check('H8 broken JSON invalidates the sample', snap.sampleValid === false, `valid ${snap.sampleValid}`);
}

// F09 / H9 — a usage that breaks the identity must not be accepted, nor keep the old one.
{
  const file = write([start(1, 1), ctx(2), e('assistant/message', 3, { usage: { totalTokens: 910, outputTokens: 10, inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } })]);
  const bad = summarize(file);
  check('H9 inconsistent usage is rejected', bad.fill === null, String(bad.fill));
  const good = write([start(1, 1), ctx(2), usage(3, 100)]);
  check('H9 consistent usage still works', Math.abs((summarize(good).fill ?? 0) - 0.1) < 1e-9);
}

// F07 / H13 — the same call reporting twice must count once.
{
  const snap = summarize(write([start(1, 1), call(2, 'a'), fail(3, 'a'), fail(9, 'a')]));
  check('H13 duplicate call counts once', snap.streak === null, JSON.stringify(snap.streak));
}

// F06-ish / H10 — a cancelled job is not a failure.
{
  const snap = summarize(write([
    start(1, 1),
    e('job/registered', 2, { jobId: 'j1', kind: 'bash', label: 'x', startedAt: T - 400_000 }),
    e('job/settled', 3, { jobId: 'j1', status: 'cancelled', finishedAt: T }),
  ]));
  check('H10 cancelled job is not a failure', snap.streak === null, JSON.stringify(snap.streak));
}

// F11 / H14 — a job with no evidence for 30 minutes is retired, not shown forever.
{
  const snap = summarize(write([start(1, 1), e('job/registered', 2, { jobId: 'j1', kind: 'bash', label: 'x', startedAt: T - 31 * 60_000 })]));
  check('H14 stale job is retired', snap.longJob === null, JSON.stringify(snap.longJob));
  const fresh = summarize(write([start(1, 1), e('job/registered', 2, { jobId: 'j2', kind: 'bash', label: 'x', startedAt: T - 400_000 })]));
  check('H14 fresh long job still shows', fresh.longJob !== null);
}

// F10 / H11 — a session id cannot escape the sessions root.
{
  let handler;
  apply({
    inject: (names, callback) => callback({ effect: (fn) => fn(), connection: { requestRejection: () => void 0 }, webServer: { register: (route) => { handler = route.handler; return () => {}; } } }),
    effect: (fn) => fn(),
  });
  async function callRoute(body) {
    const req = new EventEmitter();
    req.method = 'POST';
    req.url = '/_dsh/dsh-session-health/snapshot';
    const res = { setHeader() {}, end(text) { this.body = text; this.done?.(); }, destroy() {} };
    const finished = new Promise((resolve) => { res.done = resolve; });
    const running = handler(req, res);
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
    await running;
    await finished;
    return JSON.parse(res.body);
  }
  const escaped = await callRoute({ sessionId: '../../outside' });
  check('H11 traversal is refused', escaped.found === false || escaped.ok === false, JSON.stringify(escaped));
}

// R2 — an in-place rewrite that keeps the inode must rebuild (same size and grown).
{
  const file = path.join(ws, 'inplace', 'session.v4.jsonl.zstd');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const base = bytes([start(1, 1), ctx(2), usage(3, 700)]);
  fs.writeFileSync(file, base);
  const before = summarize(file);
  /* same size: rewrite the usage frame with a different value */
  const rewritten = bytes([start(1, 1), ctx(2), usage(3, 100)]);
  fs.writeFileSync(file, rewritten);
  const sameSize = summarize(file);
  check('R2 same-size rewrite rebuilds', sameSize.generation === before.generation + 1 && Math.abs((sameSize.fill ?? 0) - 0.1) < 1e-9, `gen ${sameSize.generation}, fill ${sameSize.fill}`);

  /* grown: rewrite the middle, then append another frame */
  fs.writeFileSync(file, base);
  summarize(file);
  const grown = Buffer.concat([rewritten, frame(e('padding', 4, { text: 'x' }))]);
  fs.writeFileSync(file, grown);
  const after = summarize(file);
  check('R2 rewrite-then-append rebuilds', Math.abs((after.fill ?? 0) - 0.1) < 1e-9, String(after.fill));
}

// R3 — a half-written skippable frame is incomplete, never corrupt.
{
  const one = bytes([start(1, 1), ctx(2), usage(3, 100)]);
  const skippable = Buffer.concat([Buffer.from([0x50, 0x2a, 0x4d, 0x18, 0x04, 0, 0, 0]), Buffer.from('abcd')]);
  const whole = Buffer.concat([one, skippable, frame(usage(4, 200))]);
  const file = path.join(ws, 'skippable-partial', 'session.v4.jsonl.zstd');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let flagged = 0;
  for (let cut = 4; cut < skippable.length; cut += 1) {
    fs.writeFileSync(file, whole.subarray(0, one.length + cut));
    const partial = summarize(file);
    if (partial.integrity !== null) flagged += 1;
  }
  check('R3 partial skippable is not corrupt', flagged === 0, `${flagged} flagged`);
  fs.writeFileSync(file, whole);
  const full = summarize(file);
  check('R3 completed skippable reads on', Math.abs((full.fill ?? 0) - 0.2) < 1e-9 && full.integrity === null, `fill ${full.fill}, integrity ${full.integrity}`);
}

// R4 — replaying a call registration must not reopen its terminal result.
{
  const snap = summarize(write([start(1, 1), call(2, 'a'), fail(3, 'a'), call(2, 'a'), fail(4, 'a')]));
  check('R4 replayed call still deduped', snap.streak === null, JSON.stringify(snap.streak));
}

// R5 — a single-line body that merely starts with "Error:" is not a failure.
{
  const snap = summarize(write([
    start(1, 1),
    call(2, 'a'), result(3, 'a', 'Error: ENOENT example shown in documentation'),
    call(4, 'b'), result(5, 'b', 'Error: ENOENT example shown in documentation'),
  ]));
  check('R5 single-line body is not a failure', snap.streak === null, JSON.stringify(snap.streak));
}

// R6 — an older request must not overwrite the newest snapshot.
{
  const snap = summarize(write([start(1, 1), ctx(2), usage(10, 700), usage(5, 100)]));
  check('R6 older usage does not regress', Math.abs((snap.fill ?? 0) - 0.7) < 1e-9, String(snap.fill));
  const turns = summarize(write([start(5, 5), start(2, 2)]));
  check('R6 older turn is ignored', turns.turn === 5, String(turns.turn));
}

fs.rmSync(workdir, { recursive: true, force: true });
console.log(failures === 0 ? '\nall regression cases passed' : `\n${failures} regression case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
