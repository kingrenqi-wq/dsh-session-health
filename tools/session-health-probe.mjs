#!/usr/bin/env node
/**
 * M0 probe: exercise the session-health host half without the running app.
 *
 * It builds a stub Cordis context, lets index.js register its route, then feeds
 * fake HTTP requests into the captured handler. Two things get proven here:
 *   - the route handler answers `health` and `snapshot`;
 *   - `snapshot` reads a real session file and returns a usable context fill.
 *
 * Usage: node tools/session-health-probe.mjs [sessionId]
 * Read-only. Prints the response bodies; exits non-zero when an assertion fails.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const dir = new URL('../', import.meta.url);

function findSessionId() {
  const root = path.join(os.homedir(), '.dsh', 'sessions');
  for (const workspace of fs.readdirSync(root)) {
    for (const entry of fs.readdirSync(path.join(root, workspace))) {
      const file = path.join(root, workspace, entry, 'session.v4.jsonl.zstd');
      if (fs.existsSync(file)) return entry.replace(/^session-/, '');
    }
  }
  return void 0;
}

const sessionId = process.argv[2] ?? findSessionId();
if (sessionId === void 0) {
  console.error('no session found');
  process.exit(2);
}

// ── stub Cordis context ─────────────────────────────────────────────────────
let handler;
const ctx = {
  inject: (names, callback) => {
    const stub = {
      effect: (fn) => fn(),
      connection: { requestRejection: () => void 0 },
      webServer: { register: (route) => { handler = route.handler; return () => {}; } },
    };
    callback(stub);
  },
  effect: (fn) => fn(),
};

const moduleUrl = new URL('index.js', dir);
moduleUrl.searchParams.set('t', String(Date.now()));
const { apply } = await import(moduleUrl.href);
apply(ctx);
if (typeof handler !== 'function') {
  console.error('FAIL host half registered no route');
  process.exit(1);
}
console.log('ok   route registered');

// ── fake request/response ──────────────────────────────────────────────────
async function call(method, body, options = {}) {
  const req = new EventEmitter();
  req.method = options.httpMethod ?? 'POST';
  req.url = `/_dsh/dsh-session-health/${method}`;
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(text) { this.body = text; this.done?.(); }, destroy() {} };
  const finished = new Promise((resolve) => { res.done = resolve; });
  const running = handler(req, res);
  req.emit('data', Buffer.from(JSON.stringify(body ?? {})));
  req.emit('end');
  await running;
  await finished;
  return { status: res.statusCode, body: JSON.parse(res.body ?? 'null') };
}

const health = await call('health');
console.log('health  ->', health.status, JSON.stringify(health.body));
if (health.status !== 200 || health.body.ok !== true) { console.error('FAIL health'); process.exit(1); }

const snap = await call('snapshot', { sessionId });
console.log('snapshot->', snap.status, JSON.stringify(snap.body));
if (snap.status !== 200 || snap.body.ok !== true || snap.body.found !== true) { console.error('FAIL snapshot did not resolve the session'); process.exit(1); }
if (!Number.isFinite(snap.body.fill)) { console.error('FAIL snapshot has no context fill'); process.exit(1); }
if (!(snap.body.contextWindow > 0) || !(snap.body.tokens > 0)) { console.error('FAIL snapshot token numbers look wrong'); process.exit(1); }

const unknown = await call('snapshot', { sessionId: 'no-such-session' });
console.log('unknown ->', unknown.status, JSON.stringify(unknown.body));
if (unknown.body.found !== false) { console.error('FAIL unknown session should report found:false'); process.exit(1); }

const wrongMethod = await call('health', {}, { httpMethod: 'GET' });
console.log('GET     ->', wrongMethod.status, JSON.stringify(wrongMethod.body));
if (wrongMethod.status !== 405) { console.error('FAIL GET should be rejected'); process.exit(1); }

const noId = await call('snapshot', {});
if (noId.body.ok !== false) { console.error('FAIL missing sessionId should fail'); process.exit(1); }
console.log('no-id   ->', noId.status, JSON.stringify(noId.body));

console.log('\nall host-half probes passed');
