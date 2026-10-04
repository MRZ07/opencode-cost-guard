# opencode-cost-guard

A flexible cost guard for [opencode](https://opencode.ai). It tracks each
session's LLM spend and **warns** or **hard-stops** the session when it exceeds
a configurable USD limit — so a runaway session can't silently cost you $50.

## Why

Agentic sessions can spiral: a large context, a frontier model, many loops. The
guard puts a hard ceiling on it and can stop tool calls / cap output the moment
the limit is crossed.

## Install

### From npm (once published)

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugin": [
    ["opencode-cost-guard", { "limit": 5, "action": "block" }]
  ]
}
```

### From a local checkout

Copy `index.js` into your global plugin directory (loaded automatically):

```bash
cp index.js ~/.config/opencode/plugins/opencode-cost-guard.js
```

or reference this repo's folder from the `plugin` array.

## Configuration

Options are passed as the second element of the plugin tuple. All optional:

| Option | Type | Default | Meaning |
|---|---|---|---|
| `limit` / `limits` | number \| object | `5` | USD per session, or a per-agent map `{ "agentGlob": usd, "*": usd }` |
| `action` | `"warn"` \| `"block"` | `"warn"` | warn = log only; block = cap output + stop tool calls |
| `warnRatio` | number `0..1` | `0.8` | fraction of a session's limit at which a warning is logged |
| `agents` | string[] globs | `["*"]` | agents to enforce |
| `exclude` | string[] globs | `[]` | agents to skip |
| `maxOutputTokensOnBlock` | number | `1` | output cap once blocked |
| `onBlock` | `"stop"` \| `"ask"` | `"stop"` | on limit: stop immediately, or ask you and extend |
| `notify` | boolean | `true` | emit logs (errors always log) |

Env overrides: `OPENCODE_COST_GUARD_LIMIT`, `OPENCODE_COST_GUARD_ACTION`.

### Examples

Warn only, global $10 ceiling:

```jsonc
"plugin": [["opencode-cost-guard", { "limit": 10 }]]
```

Hard-stop the cheap/frontier split — block everything except cheap agents:

```jsonc
"plugin": [["opencode-cost-guard", {
  "limit": 5,
  "action": "block",
  "exclude": ["fusion-*"],       // fusion sidekicks are already cheap
  "warnRatio": 0.5
}]]
```

### Per-agent limits

Pass an object to give each agent its own ceiling. The **first matching glob
wins**, and `*` / `default` is the fallback:

```jsonc
"plugin": [["opencode-cost-guard", {
  "action": "block",
  "limit": {
    "fusion-planner": 2,          // frontier lead: tight
    "fusion-code-worker": 3,      // implementation: a bit more
    "fusion-ops": 0.5,            // shell sidekick: almost nothing
    "fusion-review-deep": 5,      // frontier review: allow more
    "fusion-*": 2,                // any other fusion agent
    "*": 5                        // everything else
  }
}]]
```

Subagents run in their own session, so every `fusion-*` subagent is metered
individually — `fusion-ops` can't burn the planner's budget.

### Ask before stopping

By default a block is a hard stop. With `onBlock: "ask"` the guard instead
pauses and asks **you**:

```jsonc
"plugin": [["opencode-cost-guard", {
  "limit": { "fusion-planner": 2, "fusion-ops": 0.5, "*": 5 },
  "action": "block",
  "onBlock": "ask"
}]]
```

Flow when the limit is hit:

1. Normal tool calls are blocked (output is **not** capped, so the agent can
   still talk).
2. The agent is told to ask you via the `question` tool ("continue?").
3. You approve → the agent calls the `cost_guard_extend` tool, which raises
   this session's limit (default: one more limit; `{ "usd": 2 }` adds $2).
4. Work resumes. If you decline, the agent stops.

`question` and `cost_guard_extend` stay callable while blocked — everything
else is stopped.

### Why it hit the limit

Every block/ask message, log line, and the `cost_guard_extend` result ends with
a one-line cause analysis:

```
why: large context + many turns — model github-copilot/claude-opus-5.5;
30 turns, 3.0M in / 100k out, 700k reasoning, 4.0M cache-read, ~10 min;
12.00 USD > limit 5 (agent fusion-planner)
```

It summarises turns, input/output/reasoning/cache-read tokens, duration,
model(s), and the inferred driver — `large context`, `many turns`,
`heavy reasoning`, `output-heavy`, or `frequent frontier calls` — so you can
see *why* it broke the budget before deciding to extend.

### Local install (no npm)

Copy `index.js` into `~/.config/opencode/plugins/` and configure via
`~/.config/opencode/cost-guard.json` (or `$OPENCODE_COST_GUARD_CONFIG`):

```json
{ "action": "block", "onBlock": "ask", "limit": { "fusion-planner": 3, "fusion-ops": 0.5, "*": 5 } }
```

The plugin tuple wins over the file when both are present; env vars override
both.

## How it works

opencode plugin hooks:

- `event` → `message.updated`: sums `AssistantMessage.cost` per session
  (`Map<sessionID, Map<messageID, cost>>`, latest value per message).
- `chat.params`: on limit, caps `maxOutputTokens` (block mode).
- `tool.execute.before`: on limit, throws to stop the tool call (block mode).
- `chat.message`: records the session's agent for `agents`/`exclude` scoping.
- `session.deleted`: clears state.

State is in-memory per process; nothing is persisted.

## Limitations

- Cost comes from opencode's per-message accounting; a session with a provider
  that reports no cost will stay at `0`.
- `block` is cooperative: it stops tool calls and caps output, but opencode owns
  session lifecycle. Lower `maxOutputTokensOnBlock` for a harder stop.
- Subagent spend is counted in the child session id unless your provider rolls
  it into the parent.

## Test

```bash
node test/smoke.mjs
```

## License

MIT
