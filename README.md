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

Pin a release with `github:MRZ07/opencode-cost-guard#v0.7.0`. The package exports only `CostGuard`, so opencode registers it once.

Local install (both versions): copy `dist/opencode-cost-guard.js` into `~/.config/opencode/plugins/` and configure with `~/.config/opencode/cost-guard.json`:

```json
{ "action": "block", "onBlock": "ask", "limit": { "fusion-planner": 3, "fusion-ops": 0.5, "*": 5 } }
```

Plugin tuple options win over the config file; the config file supplies options not provided by the tuple. USD/action environment overrides retain their normal precedence.

### Initialize a token budget

The optional initializer prints a proposed JSON configuration to stdout and does not write files by default:

```bash
npm run init:budget
```

To create `~/.config/opencode/cost-guard.json` only when it does not already exist:

```bash
npm run init:budget -- --write
```

Or run the packaged script directly with Node:

```bash
node scripts/init-budget.mjs --write --config /path/to/cost-guard.json \
  --primary-tokens 500000 --subagent-tokens 250000
```

The preset is `action: "block"`, `onBlock: "ask"`, `tokenLimit: 500000`, and `subagentTokenLimit: 250000`; the two token caps can be overridden with positive safe integers. `--config` changes the destination. Writes are create-only: any existing file, malformed file, or symlink is refused without modification. The initializer never merges, activates a plugin, changes your OpenCode plugin pin, or runs at startup. Plugin tuple options take precedence over this config file, so remove any tuple option you want supplied by the file; restart OpenCode after configuration changes. Token totals are lifetime input + output + reasoning (cache excluded); the primary cap applies per session, while the child cap applies only to completely verified child sessions. These are independent from USD limits, and primary usage is not aggregated across root and child sessions.

## Config

| Option | Default | Meaning |
|---|---|---|
| `limit` | `5` | USD per session, or a per-agent map `{ "agentGlob": usd, "*": usd }` |
| `action` | `"warn"` | `warn` logs; `block` caps output and stops tools |
| `onBlock` | `"stop"` | `stop` ends the session; `ask` prompts you first |
| `warnRatio` | `0.8` | fraction of an active budget threshold that triggers one warning; dropping below all active thresholds rearms it |
| `agents` / `exclude` | `["*"]` / `[]` | agent globs to enforce or skip |
| `maxOutputTokensOnBlock` | `1` | output cap once blocked |
| `notify` | `true` | emit logs |
| `tokenLimit` | unset | session budget tokens: input + output + reasoning (cache excluded) |
| `subagentTokenLimit` | unset | lifetime verified-child cap for input + output + reasoning; root exempt |
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

`tokenLimit`, `subagentTokenLimit`, and `runTokenLimit` are positive-integer opt-ins; totals count lifetime input + output + reasoning (including repeated context), not cache-read/write. A threshold blocks at `usage >= limit`. The root is exempt only when same-project ancestry is completely verified. `cost_guard_extend` accepts `usd`, `tokens`, `scope` (`session` by default or `run`), and an optional child `sessionID` for verified parent approvals; cross-session run extensions are rejected. Explicit child token increments are additive approvals to the active base cap; they never change recorded usage. Evaluation consumes parent-model tokens, while automatic checkpoint formatting does not invoke a model. User approval remains necessary before extension or restart; a fresh child session is a distinct lifetime accounting instance but does not erase prior session history or evade a configured run cap. Lifetime cache-read/write tokens are excluded, and the primary session cap is not an aggregate root-plus-child cap.

The `stop` mode caps future generated output at the smaller of the existing provider cap and `maxOutputTokensOnBlock`; it cannot undo dispatched requests or cap input/reasoning on every provider. The practical `ask` mode leaves generation uncapped for recovery; a child checkpoint directs the parent to ask the user: (1) Evaluate stuck first by inspecting available task results, prior errors, repeated failed checks, and evidence of no progress, then explain the evidence and recommend Continue or Stop/a distinct fresh attempt, (2) Continue with the stated token increment using `cost_guard_extend` and the child `sessionID`, or (3) Stop. Evaluation is a recommendation, not approval or an unlock; obtain final user approval before extension or restart. A token extension may leave USD/session or run blockers active. Task-return notices depend on the host invoking `tool.execute.after`, which may not occur on a failed task; rejection text also contains the checkpoint. This is not a guaranteed modal, provider cancellation, or billing guarantee. In-flight usage can overshoot.

Token counts are OpenCode telemetry. Incomplete USD records contribute no fabricated cost, but known costs remain a lower bound and can still trigger a cap; below the cap, unknown usage is never treated as safe. Unknown USD does not disable token checks. Persistent state contains normalized usage, IDs, ancestry, timestamps, and approvals only—no prompts or session titles. Project/worktree-keyed immutable journal events publish through unique temporary files and atomic rename; readers ignore leftovers. Replay is idempotent and permutation-invariant. Journal limits fail explicitly; this release does not compact/delete history. `persist: false` performs no persistence. Active configuration visibility uses per-instance five-minute leases; cross-process aggregate enforcement remains non-transactional. Existing installs and global config are untouched: source edits do not update installed pinned plugin versions. Install a future release or build/copy the local bundle, then restart OpenCode.

Journal events contain only newly published message/session candidates, approvals, or configuration changes; they do not republish cumulative ledger snapshots. Agent selectors retain full glob behavior (`*` anywhere and single-character `?`).

Example opt-in: `{ "action": "block", "onBlock": "ask", "subagentTokenLimit": 250000 }`. Existing pinned installations do not receive source changes automatically; build/copy this bundle or install a future release, then restart OpenCode. No global configuration is changed automatically.

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
node test/init-budget.mjs
```

## Disposable host smoke recipe

This is a manual, no-model check; it was not run as part of source implementation. First verify the host's documented support for `OPENCODE_CONFIG_DIR`, `XDG_CONFIG_HOME`, and `XDG_STATE_HOME` for your exact OpenCode version. If any setting is unsupported or its isolation behavior is unclear, stop rather than use a live profile. Use a temporary HOME/config/state/cache directory, install only a copied local bundle and a minimal test config there, disable all unrelated plugins, and select an already-available provider/model without submitting a prompt. Start the host only far enough to confirm the plugin loads and its hooks register, then stop it and remove only the directories created for this test. Do not copy credentials, edit global config, activate a pinned install, call a model, or infer accounting correctness from this load check.

## Journal replay measurement

Run `npm run bench:journal` to create private temporary journals with 100, 1,000, and 5,000 distinct message events, then measure one initial and exactly three sequential reloads per corpus. Corpus generation and semantic assertions are outside the timed interval. The output includes event counts, bytes, OS/Node environment, and elapsed times; it makes no hardware-independent speed claim. The harness deletes only its own temporary root.

## License

MIT
