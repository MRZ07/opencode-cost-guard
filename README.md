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
| `tokenLimit` | unset | session budget tokens: input + output + reasoning (cache excluded) |
| `runLimit` | unset | USD cap across the root session and all descendants |
| `runTokenLimit` | unset | run-wide input + output + reasoning token cap |
| `usdEnabled` | `true` | enable USD enforcement; tokens still enforce independently |
| `persist` | `true` | persist normalized usage/ancestry/approvals across restart |
| `stateDirectory` | project-isolated default | optional private directory override |

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

`tokenLimit` and `runTokenLimit` are positive-integer opt-ins; totals count input + output + reasoning, not cache-read/write. A threshold blocks at `usage >= limit`. `cost_guard_extend` accepts `usd`, `tokens`, and `scope` (`session` by default or `run`). Run extensions affect only the canonical root's explicitly named run dimension; they never change session caps. Run extensions require an explicit amount. In USD-disabled token-only mode, omitting the session extension amount adds one configured session token limit. Approvals are recorded separately and survive corrected telemetry.

The `stop` mode caps future generated output at the smaller of the existing provider cap and `maxOutputTokensOnBlock`; it cannot undo dispatched requests or cap input/reasoning on every provider. The practical `ask` mode leaves generation uncapped so the agent can ask for approval; it enforces at the tool boundary and is not strict generation cancellation. Usage updates can race across concurrent in-flight calls and overshoot; telemetry is not a billing guarantee.

Token counts are OpenCode telemetry. Incomplete USD records contribute no fabricated cost, but known costs remain a lower bound and can still trigger a cap; below the cap, unknown usage is never treated as safe. Unknown USD does not disable token checks. Persistent state contains normalized usage, IDs, ancestry, timestamps, and approvals only—no prompts or session titles. Project/worktree-keyed immutable journal events publish through unique temporary files and atomic rename; readers ignore leftovers. Replay is idempotent and permutation-invariant. Journal limits fail explicitly; this release does not compact/delete history. `persist: false` performs no persistence. Active configuration visibility uses per-instance five-minute leases; cross-process aggregate enforcement remains non-transactional. Existing installs and global config are untouched: source edits do not update installed pinned plugin versions. Install a future release or build/copy the local bundle, then restart OpenCode.

Journal events contain only newly published message/session candidates, approvals, or configuration changes; they do not republish cumulative ledger snapshots. Agent selectors retain full glob behavior (`*` anywhere and single-character `?`).

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
