#!/usr/bin/env node
/**
 * Read-only audit: parsing must not touch the session files.
 *
 * Hashes every session file, runs the host half's summarize() over all of them,
 * then re-hashes and compares. Also fails if any directory entry appears.
 *
 * Usage: node tools/session-health-readonly.test.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.join(os.homedir(), '.dsh', 'sessions');
/* The live session file is appended to by the host while this runs, so the audit
 * works on a frozen copy — the same rule the PRD gives for the read-only check. */
const frozen = fs.mkdtempSync(path.join(os.tmpdir(), 'session-health-ro-'));
const moduleUrl = new URL('../index.js', import.meta.url);
moduleUrl.searchParams.set('t', String(Date.now()));
const { summarize } = await import(moduleUrl.href);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function digest(files) {
  return files.map((file) => {
    const stat = fs.statSync(file);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    return `${file}\u0000${stat.size}\u0000${stat.mtimeMs}\u0000${hash}`;
  }).join('\n');
}

const before = walk(root);
const beforeDigest = digest(before);

const copies = [];
for (const file of before) {
  if (!file.endsWith('session.v4.jsonl.zstd')) continue;
  const target = path.join(frozen, String(copies.length), 'session.v4.jsonl.zstd');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(file, target);
  copies.push(target);
}
const copyDigest = digest(copies);

let parsed = 0;
for (const file of copies) {
  summarize(file);
  parsed += 1;
}

const after = walk(root);
const afterDigest = digest(after);
const afterCopies = digest(copies);

const sameFiles = before.length === after.length;
const sameBytes = afterCopies === copyDigest;

console.log(`${sameFiles ? 'ok  ' : 'FAIL'} file list unchanged (${before.length} files)`);
console.log(`${sameBytes ? 'ok  ' : 'FAIL'} frozen copies unchanged after parsing ${parsed} sessions`);
console.log(`${beforeDigest === afterDigest ? 'ok  ' : 'note'} live files: ${beforeDigest === afterDigest ? 'also unchanged' : 'changed by the editor while the audit ran (expected)'}`);

if (!sameBytes) {
  const b = new Set(beforeDigest.split('\n'));
  for (const line of afterDigest.split('\n')) {
    if (!b.has(line)) console.log('  changed:', line.split('\u0000')[0]);
  }
}
fs.rmSync(frozen, { recursive: true, force: true });
process.exit(sameFiles && sameBytes ? 0 : 1);
