# DSH Session Health

A small floating card for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): it shows the current session's context fill, and turns amber for two situations that are worth a look — the same tool failing repeatedly, or a task with no terminal state for a long time. Clicking it shows the evidence.

![preview](docs/preview.png)

> Design mock drawn from the real styles, not a screenshot.

## What it shows

| State | Card | Meaning |
|---|---|---|
| Normal | `Context 31%` | input context of the latest request |
| Older than 90s | number dims to 60% | the sample is old; the value is not zeroed |
| Compacting | `updating` + `compaction running` | the previous snapshot is invalid while compaction runs |
| After compaction / model switch | `waiting for the next request` | old snapshot retired |
| Same failure ≥2 | amber border + `same failure ×2` | same tool, same error class, targets merged |
| Task >300s without end | `task state unconfirmed` | it never claims the task is still alive |
| Broken records | extra `records incomplete` | some records could not be parsed |
| Context ≥50% | number turns **amber** | colour only, no extra text |
| Context ≥65% | number turns **red** | colour only |

## What it never does

- No judgement about whether the answer is right, no ETA, no score.
- **No actions**: it never stops, retries, compacts or sends anything.
- **No network**: it only reads `~/.dsh/sessions/**/session.v4.jsonl.zstd` and writes nothing.
- No balance or spend (the bottom info bar already covers that).

## Install

In DSH: **Plugins → Add plugin**, then paste one of:

```
dsh-session-health                                 # npm, after publishing
https://github.com/kingrenqi-wq/dsh-session-health # git
/absolute/path/to/dsh-session-health               # local directory
```

Enable it. With a linked directory, refresh the page after editing the Client half; restart DSH after editing the Host half.

## Usage

Drag the card anywhere (the position is remembered), click to open the evidence panel, `Esc` closes. Keyboard: Tab, Enter/Space.

## How it decides

- Context fill = `totalTokens − outputTokens` / `contextWindow` of the latest request.
- A failure needs a **structured** signal: `tool/result.data.error`; shell tools additionally count a trailing `[exit code: N]`.
- Cancellations are not failures.
- Long-task hints appear between 300s and 30min; after that they retire into history.
- Replaced, truncated or rewritten session files are detected via inode plus a prefix hash of the consumed bytes.

## Known limits

Restart, clock jumps, multiple windows, timeout coalescing and pagination are **unverified** (see `docs/PRD.md` §15). The Client half depends on DSH's `shell.overlay` slot and the root `useSessions` hook; a breaking upgrade can make the card disappear without affecting DSH itself. Only session format v4 is supported; other formats degrade to "unavailable".

## Tests

`91` behavioural assertions across rule replays, a fault matrix, UI states and three rounds of review counter-examples:

```bash
node tools/session-health-rules.test.mjs
node tools/session-health-faults.test.mjs
node tools/session-health-regressions.test.mjs
node tools/session-health-ui.test.mjs
node tools/session-health-ui-regressions.test.mjs
node tools/session-health-readonly.test.mjs
```

## License

MIT.
