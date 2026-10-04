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
| `limit` | number | `5` | USD per session before acting |
| `action` | `"warn"` \| `"block"` | `"warn"` | warn = log only; block = cap output + stop tool calls |
| `warnRatio` | number `0..1` | `0.8` | fraction of `limit` at which a warning is logged |
| `agents` | string[] globs | `["*"]` | agents to enforce |
| `exclude` | string[] globs | `[]` | agents to skip |
| `maxOutputTokensOnBlock` | number | `1` | output cap once blocked |
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
