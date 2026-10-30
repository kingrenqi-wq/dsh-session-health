#!/usr/bin/env node
/**
 * Fault matrix for the session-health host half.
 *
 * Points the plugin at a throw-away sessions directory (DSH_SESSION_HEALTH_ROOT)
 * and feeds the real route handler six broken inputs. Every case must answer
 * without throwing, and must not claim a healthy state it cannot prove.
 *
 * Usage: node tools/session-health-faults.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { EventEmitter } from 'node:events';

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-health-faults-'));
process.env.DSH_SESSION_HEALTH_ROOT = workdir;

const workspace = path.join(workdir, 'ws');
function sessionDir(id) {
  const dir = path.join(workspace, id);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'session.v4.jsonl.zstd');
}

function frame(record) {
  return zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(record)}\n`));
}

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures += 1;
}

// fixtures
fs.writeFileSync(sessionDir('corrupt'), Buffer.from('not a zstd log at all, just bytes'));
fs.writeFileSync(sessionDir('empty-events'), Buffer.concat([
  frame({ type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } }),
]));
fs.writeFileSync(sessionDir('truncated'), Buffer.concat([
  frame({ type: 'assistant/message', seq: 1, time: Date.now(), data: { usage: { totalTokens: 10, outputTokens: 1 } } }),
  zlib.zstdCompressSync(Buffer.from('{"type":"turn/end","seq":2,"time":1,"data":{} }\n')).subarray(0, 10),
]));
const denied = sessionDir('denied');
fs.writeFileSync(denied, frame({ type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } }));
fs.chmodSync(denied, 0o000);

// many frames, to time a realistic worst case
const big = [];
for (let i = 0; i < 4000; i += 1) {
  big.push(frame({ type: 'tool/result', seq: i, time: Date.now(), data: { message: { content: [{ type: 'text', text: 'ok' }] } } }));
}
fs.writeFileSync(sessionDir('big'), Buffer.concat(big));

// ── mount the route against the fixture ────────────────────────────────────
let handler;
const ctx = {
  inject: (names, callback) => callback({
    effect: (fn) => fn(),
    connection: { requestRejection: () => void 0 },
    webServer: { register: (route) => { handler = route.handler; return () => {}; } },
  }),
  effect: (fn) => fn(),
};
const moduleUrl = new URL('../index.js', import.meta.url);
moduleUrl.searchParams.set('t', String(Date.now()));
const { apply } = await import(moduleUrl.href);
apply(ctx);

async function call(method, body) {
  const req = new EventEmitter();
  req.method = 'POST';
  req.url = `/_dsh/dsh-session-health/${method}`;
  const res = { statusCode: 0, setHeader() {}, end(text) { this.body = text; this.done?.(); }, destroy() {} };
  const finished = new Promise((resolve) => { res.done = resolve; });
  const running = handler(req, res);
  req.emit('data', Buffer.from(JSON.stringify(body ?? {})));
  req.emit('end');
  await running;
  await finished;
  return { status: res.statusCode, body: JSON.parse(res.body ?? 'null') };
}

const corrupt = await call('snapshot', { sessionId: 'corrupt' });
check('corrupt file does not throw', corrupt.status === 200 && corrupt.body.ok === true, JSON.stringify(corrupt.body).slice(0, 120));
check('corrupt file reports no context', corrupt.body.fill === null);

const missing = await call('snapshot', { sessionId: 'no-such-session' });
check('unknown session degrades', missing.body.ok === true && missing.body.found === false);

const empty = await call('snapshot', { sessionId: 'empty-events' });
check('no usage → no fill', empty.body.fill === null && empty.body.found === true);

const truncated = await call('snapshot', { sessionId: 'truncated' });
check('torn tail keeps decoded frames', truncated.status === 200 && truncated.body.ok === true);

const perm = await call('snapshot', { sessionId: 'denied' });
check('unreadable file reports an error', perm.body.ok === false, perm.body.error ?? '');

const started = Date.now();
const bigResult = await call('snapshot', { sessionId: 'big' });
const elapsed = Date.now() - started;
check('4000-frame file parses under 300ms', bigResult.body.ok === true && elapsed < 300, `${elapsed}ms`);

const cachedStarted = Date.now();
await call('snapshot', { sessionId: 'big' });
const cachedElapsed = Date.now() - cachedStarted;
check('second read is cached', cachedElapsed <= 30, `${cachedElapsed}ms`);

const bigPath = path.join(workspace, 'big', 'session.v4.jsonl.zstd');
fs.appendFileSync(bigPath, frame({ type: 'tool/result', seq: 9999, time: Date.now(), data: { message: { content: [{ type: 'text', text: 'ok' }] } } }));
const appendedStarted = Date.now();
const appended = await call('snapshot', { sessionId: 'big' });
const appendedElapsed = Date.now() - appendedStarted;
check('append parses only the tail', appended.body.events === 4001 && appendedElapsed < 30, `${appendedElapsed}ms, events ${appended.body.events}, size ${appended.body.file.size}, cursor ${appended.body.file.cursor}`);


// truncation and replacement must rebuild, never keep a stale cursor
{
  const file = bigPath;
  const before = await call('snapshot', { sessionId: 'big' });
  const truncated = zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 9 } }) + '\n'));
  fs.writeFileSync(file, truncated);
  const after = await call('snapshot', { sessionId: 'big' });
  check('truncation rebuilds state', after.body.events === 1 && after.body.turn === 9, `events ${after.body.events}`);
  check('cursor follows the shorter file', after.body.file.cursor === after.body.file.size);
  // same size, different head: replacement
  const replacement = Buffer.concat([zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 42 } }) + '\n')), Buffer.alloc(Math.max(0, truncated.length - 1), 0)]);
  fs.writeFileSync(file, replacement);
  const replaced = await call('snapshot', { sessionId: 'big' });
  check('replacement rebuilds state', replaced.body.turn === 42 || replaced.body.events === 1, `turn ${replaced.body.turn}, events ${replaced.body.events}`);
  fs.writeFileSync(file, Buffer.concat(big));
}

// file generation: replacement and delete/recreate must not inherit state
{
  const file = path.join(workspace, 'gen', 'session.v4.jsonl.zstd');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, frame({ type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } }));
  const first = await call('snapshot', { sessionId: 'gen' });
  check('first generation', first.body.generation === 1, `gen ${first.body.generation}`);

  fs.writeFileSync(file, frame({ type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 2 } }));
  const second = await call('snapshot', { sessionId: 'gen' });
  check('replacement bumps generation', second.body.generation === 2 && second.body.turn === 2, `gen ${second.body.generation}, turn ${second.body.turn}`);

  fs.rmSync(file);
  const gone = await call('snapshot', { sessionId: 'gen' });
  check('deleted file reports not found', gone.body.found === false);

  fs.writeFileSync(file, frame({ type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 3 } }));
  const back = await call('snapshot', { sessionId: 'gen' });
  check('recreated file starts a clean generation', back.body.generation === 1 && back.body.events === 1, `gen ${back.body.generation}, events ${back.body.events}`);
}

fs.chmodSync(denied, 0o644);
fs.rmSync(workdir, { recursive: true, force: true });

console.log(failures === 0 ? '\nall fault cases passed' : `\n${failures} fault case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
