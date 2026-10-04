# opencode-cost-guard

Cap an opencode session's USD spend. Warn at a threshold, or block the session and ask you before continuing. Works on opencode v1 and v2.

## Install

npm, v1:

```jsonc
"plugin": [["opencode-cost-guard", { "action": "block", "onBlock": "ask", "limit": 5 }]]
```

npm, v2:

```jsonc
"plugins": [{ "package": "opencode-cost-guard", "options": { "action": "block", "onBlock": "ask", "limit": 5 } }]
```

Local install (both versions): copy `dist/opencode-cost-guard.js` into `~/.config/opencode/plugins/` and configure with `~/.config/opencode/cost-guard.json`:

```json
{ "action": "block", "onBlock": "ask", "limit": { "fusion-planner": 3, "fusion-ops": 0.5, "*": 5 } }
```

Explicit options win over the config file; env vars win over both.

## Config

| Option | Default | Meaning |
|---|---|---|
| `limit` | `5` | USD per session, or a per-agent map `{ "agentGlob": usd, "*": usd }` |
| `action` | `"warn"` | `warn` logs; `block` caps output and stops tools |
| `onBlock` | `"stop"` | `stop` ends the session; `ask` prompts you first |
| `warnRatio` | `0.8` | fraction of the limit that triggers a warning |
| `agents` / `exclude` | `["*"]` / `[]` | agent globs to enforce or skip |
| `maxOutputTokensOnBlock` | `1` | output cap once blocked |
| `notify` | `true` | emit logs |

Env: `OPENCODE_COST_GUARD_LIMIT`, `OPENCODE_COST_GUARD_ACTION`, `OPENCODE_COST_GUARD_CONFIG`.

Per-agent limits use the first matching glob, so list specific agents before `*`:

```json
{ "limit": { "fusion-ops": 0.5, "fusion-planner": 3, "fusion-*": 2, "*": 5 } }
```

## On the limit

`block` + `stop` ends the session. `block` + `ask` stops normal tools, asks you via the `question` tool, and raises the budget through `cost_guard_extend` if you approve. `question` and `cost_guard_extend` stay callable while blocked.

Every block, warn, and extend reports why:

```
why: large context + many turns — model github-copilot/claude-opus-5.5;
30 turns, 3.0M in / 100k out, 700k reasoning, 4.0M cache-read, ~10 min;
12.00 USD > limit 5 (agent fusion-planner)
```

Drivers it reports: large context, many turns, heavy reasoning, output-heavy, frequent frontier calls.

## Compatibility

v1 (`plugin`, tuple options) and v2 (`plugins`, `{ package, options }`) share the same hook API. Local installs load from `~/.config/opencode/plugins/` on both. Ship the single `dist/opencode-cost-guard.js` file — opencode registers every exported function as a plugin, so a single file that exports only `CostGuard` avoids double-loading.

## Test

```bash
node test/smoke.mjs
```

## License

MIT
