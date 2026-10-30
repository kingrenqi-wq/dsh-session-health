#!/usr/bin/env node
/**
 * Resource soak: call summarize() on the live session every 5 seconds and report
 * RSS drift. Short version of PRD §9.3's one-hour check.
 *
 * Usage: node tools/session-health-soak.mjs <sessionFile> [seconds]
 */
import fs from 'node:fs';

const file = process.argv[2];
const seconds = Number(process.argv[3] ?? 180);
if (!file) {
  console.error('usage: node tools/session-health-soak.mjs <sessionFile> [seconds]');
  process.exit(2);
}

const moduleUrl = new URL('../index.js', import.meta.url);
moduleUrl.searchParams.set('t', String(Date.now()));
const { summarize } = await import(moduleUrl.href);

const base = process.memoryUsage().rss;
const started = Date.now();
let worst = 0;
let peakDelta = 0;

while ((Date.now() - started) / 1000 < seconds) {
  const t0 = Date.now();
  const snapshot = summarize(file);
  const cost = Date.now() - t0;
  worst = Math.max(worst, cost);
  const delta = (process.memoryUsage().rss - base) / 1048576;
  peakDelta = Math.max(peakDelta, delta);
  console.log(`t=${Math.round((Date.now() - started) / 1000)}s cost=${cost}ms rssDelta=${delta.toFixed(1)}MB events=${snapshot.events} size=${snapshot.file.size}`);
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

console.log(`\ndone: worst poll ${worst}ms, peak RSS delta ${peakDelta.toFixed(1)}MB`);
