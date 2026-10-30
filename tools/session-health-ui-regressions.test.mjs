#!/usr/bin/env node
/**
 * UI regressions from the 2026-10-30 review (F03, F12).
 *
 * Drives the real component with controllable props and a deferred fetch:
 *   U1  switching sessions must not keep showing the previous session's number
 *   U2  no session means the widget renders nothing
 *   U3  a timed-out request keeps the old number but marks it stale
 *
 * Usage: node tools/session-health-ui-regressions.test.mjs
 */
let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures += 1;
}

const state = [];
const refs = [];
let cursor = 0;
const effects = [];

const React = {
  createElement: (type, props, ...children) => {
    const element = { type, props: props ?? {}, children };
    if (element.props.ref) element.props.ref.current = { getBoundingClientRect: () => ({ left: 10, top: 10, bottom: 100, width: 164, height: 90 }), focus: () => {} };
    return element;
  },
  useState(initial) {
    const index = cursor++;
    if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
    return [state[index], (next) => { state[index] = typeof next === 'function' ? next(state[index]) : next; }];
  },
  useEffect(fn) { effects.push(fn); },
  useMemo(fn) { return fn(); },
  useRef(initial) { const index = cursor++; refs[index] ??= { current: initial }; return refs[index]; },
};

const pending = [];
const realTimeout = globalThis.setTimeout;
const timers = [];
globalThis.setTimeout = (fn) => { timers.push(fn); return timers.length; };
globalThis.clearTimeout = () => {};
const flush = async () => { await new Promise((resolve) => realTimeout(resolve, 0)); };
const runTimers = () => { while (timers.length > 0) timers.shift()(); };
globalThis.window = {
  __ModuleLoader__: { load: (definition) => { globalThis.__definition = definition; } },
  innerWidth: 1400, innerHeight: 900,
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener: () => {}, removeEventListener: () => {},
};
globalThis.document = { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} };
globalThis.fetch = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));

const url = new URL('../client.js', import.meta.url);
url.searchParams.set('t', String(Date.now()));
await import(url.href);

let component;
globalThis.__definition.factory((id) => {
  if (id === 'react') return React;
  throw new Error(`unexpected require(${id})`);
});
({
  inject: (name, callback) => callback(),
  effect: (fn) => fn(),
  locale: { register: () => () => {} },
  slots: { inject: (name, cb) => cb(), register: (options, instance) => { component = instance; return () => {}; } },
}).inject = (name, callback) => callback();
const ctx = {
  effect: (fn) => fn(),
  locale: { register: () => () => {} },
  slots: { inject: (name, cb) => cb(), register: (options, instance) => { component = instance; return () => {}; } },
};
const definition = globalThis.__definition;
const mod = definition.factory((id) => { if (id === 'react') return React; throw new Error(id); });
mod.apply(ctx);

function text(tree, out = []) {
  if (tree === null || tree === void 0) return out;
  if (typeof tree === 'string' || typeof tree === 'number') { out.push(String(tree)); return out; }
  if (Array.isArray(tree)) { for (const child of tree) text(child, out); return out; }
  if (tree.children) text(tree.children, out);
  return out;
}

const sessions = (id) => (selector) => selector(id === void 0 ? { byId: {} } : { byId: { [id]: { retainedBy: { mainView: 1 } } } });

let lastSession = Symbol('none');
let cleanups = [];
function paint(sessionId) {
  cursor = 0;
  const switched = sessionId !== lastSession;
  const tree = component({ t: (key) => key, useSessions: sessions(sessionId) });
  const collected = effects.splice(0);
  if (switched) {
    lastSession = sessionId;
    for (const cleanup of cleanups) cleanup();
    cleanups = [];
    for (const effect of collected) {
      const cleanup = effect();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    }
  }
  return tree;
}

const payload = (pct) => ({
  ok: true, found: true, fill: pct, tokens: Math.round(pct * 1000), contextWindow: 1000,
  events: 10, sampledAt: Date.now(), now: Date.now(), sampleValid: true, sessionId: 'A',
});

// U1: A shows 11%, then the user switches to B while B's request is still pending.
let tree = paint('A');
await flush();
pending.pop()?.resolve({ ok: true, status: 200, text: async () => JSON.stringify(payload(0.11)) });
await flush();
tree = paint('A');
check('U1 first session renders its number', text(tree).join(' ').includes('11%'), text(tree).join(' ').slice(0, 60));

tree = paint('B'); // B's fetch is now pending
check('U1 switch does not show the old number', !text(tree).join(' ').includes('11%'), text(tree).join(' ').slice(0, 60));

// U2: no session at all.
const empty = paint(void 0);
check('U2 no session renders nothing', empty === null || text(empty).length === 0, JSON.stringify(empty));

// U3: a request that times out keeps the number but marks it stale.
const fresh = 'C';
tree = paint(fresh);
await flush();
pending.pop()?.resolve({ ok: true, status: 200, text: async () => JSON.stringify(payload(0.22)) });
await flush();
const beforeTimeout = paint(fresh);
check('U3 number is shown before the timeout', text(beforeTimeout).join(' ').includes('22%'), text(beforeTimeout).join(' ').slice(0, 40));
runTimers();            // next poll starts and stays in flight
await flush();
while (pending.length > 0) pending.shift().reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
await flush();
tree = paint(fresh);
const staleText = text(tree).join(' ');
check('U3 timeout keeps the number', staleText.includes('22%'), staleText.slice(0, 60));
check('U3 timeout marks the data stale', staleText.includes('chip.stale'), staleText.slice(0, 90));

console.log(failures === 0 ? '\nall UI regression cases passed' : `\n${failures} UI regression case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
