# opencode-cost-guard

Cap an opencode session's USD spend. Warn at a threshold, or block the session and ask you before continuing. Works on opencode v1 and v2.

## Install

Straight from GitHub — no npm publish needed. opencode installs it with Bun at startup.

v1:

```jsonc
"plugin": [["github:MRZ07/opencode-cost-guard", { "action": "block", "onBlock": "ask", "limit": 5 }]]
```

v2:

```jsonc
"plugins": [{ "package": "github:MRZ07/opencode-cost-guard", "options": { "action": "block", "onBlock": "ask", "limit": 5 } }]
```

Pin a release with `github:MRZ07/opencode-cost-guard#v0.5.0`. The package exports only `CostGuard`, so opencode registers it once.

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

`block` + `stop` ends the session. `block` + `ask` stops normal tools and asks you via the `question` tool. The agent asks whether to continue and how much extra USD to grant, then calls `cost_guard_extend` with that amount:

```
cost-guard: session limit is now 13.00 USD.
```

`question` and `cost_guard_extend` stay callable while blocked. Omit the amount to add one more limit.

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
