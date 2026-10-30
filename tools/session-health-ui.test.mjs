#!/usr/bin/env node
/**
 * UI state matrix: render the real Client component against fake Host answers.
 *
 * Implements just enough of React (useState/useEffect/useRef) to run one
 * component, then asserts what text lands in the widget for each Host payload.
 *
 * Usage: node tools/session-health-ui.test.mjs
 */
import fs from 'node:fs';

const file = new URL('../client.js', import.meta.url);

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures += 1;
}

/** Tiny hook runtime: one component, one state store. */
function makeReact() {
  const state = [];
  const refs = [];
  let cursor = 0;
  const pending = [];
  const React = {
    createElement: (type, props, ...children) => {
      const element = { type, props: props ?? {}, children };
      if (element.props.ref) {
        element.props.ref.current = {
          getBoundingClientRect: () => ({ left: 100, top: 100, bottom: 190, width: 164, height: 90 }),
          focus: () => {},
        };
      }
      return element;
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
      return [state[index], (next) => {
        state[index] = typeof next === 'function' ? next(state[index]) : next;
      }];
    },
    useEffect(fn) { pending.push(fn); },
    useMemo(fn) { return fn(); },
    useRef(initial) {
      const index = cursor++;
      refs[index] ??= { current: initial };
      return refs[index];
    },
  };
  return { React, pending, resetCursor: () => { cursor = 0; } };
}

function collectText(tree, out = []) {
  if (tree === null || tree === void 0 || tree === false) return out;
  if (typeof tree === 'string' || typeof tree === 'number') { out.push(String(tree)); return out; }
  if (Array.isArray(tree)) { for (const child of tree) collectText(child, out); return out; }
  if (tree.children) collectText(tree.children, out);
  return out;
}

/** Load the module fresh, with a fake window/React/document. */
async function loadComponent() {
  const runtime = makeReact();
  let definition;
  globalThis.window = {
    __ModuleLoader__: { load: (value) => { definition = value; } },
    innerWidth: 1440,
    innerHeight: 900,
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  globalThis.document = { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} };
  const url = new URL(file);
  url.searchParams.set('t', String(Date.now()));
  await import(url.href);
  const module = definition.factory((id) => {
    if (id === 'react') return runtime.React;
    throw new Error(`unexpected require(${id})`);
  });
  return { module, runtime };
}

/** Run the component to a settled state, returning its text. */
async function render(payload, open = false) {
  const { module, runtime } = await loadComponent();
  let component;
  const ctx = {
    effect: (fn) => fn(),
    locale: { register: () => () => {} },
    slots: { inject: (name, cb) => cb(), register: (options, instance) => { component = instance; return () => {}; } },
  };
  module.apply(ctx);

  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) });

  const paint = async () => {
    runtime.resetCursor();
    const effects = runtime.pending.splice(0);
    const tree = component({
      t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
      useSessions: (selector) => selector({ byId: { 'session-x': { retainedBy: { mainView: 1 } } } }),
    });
    for (const effect of effects) effect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return tree;
  };

  let tree = await paint();
  tree = await paint();
  tree = await paint();
  if (open) {
    const event = { button: 0, clientX: 120, clientY: 130, pointerId: 1 };
    tree.props.onPointerDown?.(event);
    tree.props.onPointerUp?.(event);
    for (let pass = 0; pass < 3; pass += 1) tree = await paint();
  }
  return collectText(tree).join(' ');
}

const base = { ok: true, found: true, fill: 0.31, tokens: 328000, contextWindow: 1048576, events: 2100, sampledAt: Date.now(), file: {} };

const normal = await render(base);
check('normal shows percentage', normal.includes('31%'), normal.slice(0, 80));

const missing = await render({ ok: true, found: false });
check('missing session shows unavailable', missing.includes('chip.unavailable'), missing.slice(0, 80));

const warning = await render({ ...base, streak: { count: 2, tool: 'read', category: 'fs-missing', targets: ['/a'], firstSeq: 1, lastSeq: 2, recent: false } });
check('streak shows reason', warning.includes('chip.streak'), warning.slice(0, 100));

const recent = await render({ ...base, streak: { count: 2, tool: 'read', category: 'fs-missing', targets: ['/a'], firstSeq: 1, lastSeq: 2, recent: true } });
check('recent streak uses previous-turn wording', recent.includes('chip.streakRecent'), recent.slice(0, 100));

const job = await render({ ...base, longJob: { jobId: 'j1', kind: 'bash', label: 'pnpm build', startedAt: Date.now() - 400000, ageMs: 400000, confirmed: false } });
check('long job shows pending wording', job.includes('chip.pending'), job.slice(0, 100));

const noFill = await render({ ok: true, found: true, fill: null, contextWindow: 0, tokens: 0 });
check('no fill shows dash, not 0/0', noFill.includes('— —'), noFill.slice(0, 80));

const withHistory = await render({ ...base, history: [
  { rule: 'streak', tool: 'read', category: 'fs-missing', count: 2, startedAt: Date.now() - 600000, endedAt: Date.now() - 500000, endedBy: 'next-turn' },
  { rule: 'longJob', kind: 'bash', label: 'build', startedAt: Date.now() - 400000, endedAt: Date.now() - 100000, endedBy: 'completed' },
] }, true);
check('history lists closed hints', withHistory.includes('chip.history') && withHistory.includes('chip.end.nextTurn'), withHistory.slice(0, 120));

const bothHints = await render({
  ...base,
  streak: { count: 2, tool: 'read', category: 'fs-missing', targets: ['/a'], firstSeq: 1, lastSeq: 2, recent: false },
  longJob: { jobId: 'j1', kind: 'bash', label: 'build', startedAt: Date.now() - 400000, ageMs: 400000, confirmed: false },
});
check('streak outranks the long job', bothHints.includes('chip.streak') && !bothHints.includes('chip.pending'), bothHints.slice(0, 90));

const gap = await render({ ...base, integrity: 'bad-json' });
check('integrity is visible in the widget', gap.includes('chip.integrity'), gap.slice(0, 90));
check('integrity changes the text', gap !== normal, '');

const compacting = await render({ ...base, fill: null, compacting: true, sampleValid: false });
check('compaction shows updating', compacting.includes('chip.compacting') && compacting.includes('chip.compactingNote'), compacting.slice(0, 100));

const waiting = await render({ ...base, fill: null, compacting: false, sampleValid: false });
check('invalid sample waits for next request', waiting.includes('chip.waiting'), waiting.slice(0, 100));

console.log(failures === 0 ? '\nall UI states passed' : `\n${failures} UI state(s) failed`);
process.exit(failures === 0 ? 0 : 1);
