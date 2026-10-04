// GENERATED FILE — do not edit. Build with: node build-local.mjs
/**
 * opencode-cost-guard
 *
 * Warn or hard-stop an opencode session when its accumulated LLM spend
 * exceeds a configurable USD limit. Flexible by design: per-agent scoping,
 * warn vs block, and a configurable block behaviour.
 *
 * Usage (opencode.json):
 *   "plugin": [["opencode-cost-guard", { "limit": 5, "action": "block" }]]
 *
 * All options (with defaults):
 *   limit                   number   USD per session                 (5)
 *   action                  string   "warn" | "block"                ("warn")
 *   warnRatio               number   0..1, warn at limit*ratio       (0.8)
 *   agents                  string[] agent globs to enforce          (["*"])
 *   exclude                 string[] agent globs to skip             ([])
 *   maxOutputTokensOnBlock  number   output cap once blocked         (1)
 *   notify                  boolean  emit logs                       (true)
 *
 * Env overrides: OPENCODE_COST_GUARD_LIMIT, OPENCODE_COST_GUARD_ACTION.
 */

/** @typedef {import("@opencode-ai/plugin").Plugin} Plugin */
/** @typedef {import("@opencode-ai/plugin").PluginOptions} PluginOptions */

/**
 * Minimal glob matcher: `*` matches any run of characters, `?` one char.
 * @param {string} pattern
 * @param {string} value
 */
function globMatch(pattern, value) {
  if (pattern === "*" || pattern === value) return true;
  const re = new RegExp(
    "^" +
      pattern
        .split("")
        .map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
        .join("") +
      "$",
  );
  return re.test(value);
}

/** @param {string[]} patterns @param {string|undefined} value */
function anyMatch(patterns, value) {
  if (!patterns || patterns.length === 0) return false;
  if (value == null) return patterns.includes("*");
  return patterns.some((p) => globMatch(p, value));
}

/**
 * Parse a global or per-agent limit spec.
 * Accepts: number | { "agentGlob": number, ... , "*": number }
 * Keys `*` / `default` set the fallback; other keys are per-agent patterns.
 * @param {unknown} raw
 * @param {number} fallback
 */
function parseLimits(raw, fallback = 5) {
  const isUsd = (n) => Number.isFinite(n) && n > 0;
  if (raw == null) return { default: fallback, perAgent: [] };
  if (typeof raw === "number") return { default: isUsd(raw) ? raw : fallback, perAgent: [] };
  if (typeof raw === "object") {
    let def = fallback;
    /** @type {Array<[string, number]>} */
    const perAgent = [];
    for (const [key, value] of Object.entries(raw)) {
      const n = Number(value);
      if (!isUsd(n)) continue;
      if (key === "*" || key === "default") def = n;
      else perAgent.push([key, n]);
    }
    return { default: def, perAgent };
  }
  return { default: fallback, perAgent: [] };
}

/**
 * Resolve the effective USD limit for an agent (first matching pattern wins,
 * then the fallback).
 * @param {{ limits?: Array<[string, number]>, limit: number }} cfg
 * @param {string|undefined} agent
 */
function resolveLimit(cfg, agent) {
  if (agent && cfg.limits && cfg.limits.length) {
    for (const [pattern, n] of cfg.limits) {
      if (globMatch(pattern, agent)) return n;
    }
  }
  return cfg.limit;
}

/**
 * Compact number formatting (1234 -> 1.2k, 1900000 -> 1.9M).
 * @param {number} n
 */
function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(0) + "k";
  return String(v);
}

/**
 * One-line, human-readable explanation of *why* a session hit its budget.
 * @param {{cost:number, limit?:number, tokens?:{input:number,output:number,reasoning:number,cacheRead:number,cacheWrite:number}, turnCount?:number, models?:Set<string>|string[], first?:number, last?:number, agent?:string}} s
 */
function explainCost(s) {
  const t = s.tokens || { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  const causes = [];
  if ((t.cacheRead || 0) > 2_000_000 || (t.input || 0) > 500_000) causes.push("large context");
  if ((s.turnCount || 0) >= 15) causes.push("many turns");
  if ((t.reasoning || 0) > 500_000) causes.push("heavy reasoning");
  if ((t.output || 0) > (t.input || 0)) causes.push("output-heavy");
  if (!causes.length) causes.push("frequent frontier calls");

  const mins = s.first && s.last ? Math.max(1, Math.round((s.last - s.first) / 60000)) : null;
  const bits = [`${s.turnCount || 0} turns`, `${fmtNum(t.input)} in / ${fmtNum(t.output)} out`];
  if (t.reasoning) bits.push(`${fmtNum(t.reasoning)} reasoning`);
  if (t.cacheRead) bits.push(`${fmtNum(t.cacheRead)} cache-read`);
  if (mins) bits.push(`~${mins} min`);

  const models = [...(s.models || [])].join(", ") || "unknown";
  return (
    `why: ${causes.join(" + ")} — model ${models}; ${bits.join(", ")}; ` +
    `${(s.cost || 0).toFixed(2)} USD${s.limit ? ` > limit ${s.limit}` : ""}` +
    `${s.agent ? ` (agent ${s.agent})` : ""}`
  );
}

/**
 * @param {PluginOptions|undefined} options
 */
function normalizeOptions(options = {}) {
  const envLimit = process.env.OPENCODE_COST_GUARD_LIMIT;
  const envAction = process.env.OPENCODE_COST_GUARD_ACTION;

  const spec = envLimit != null ? Number(envLimit) : (options.limits ?? options.limit);
  const parsed = parseLimits(spec, 5);
  const action = String(envAction ?? options.action ?? "warn").toLowerCase();

  const cfg = {
    limit: parsed.default,
    limits: parsed.perAgent,
    action: action === "block" ? "block" : "warn",
    warnRatio:
      typeof options.warnRatio === "number" && options.warnRatio > 0 && options.warnRatio <= 1
        ? options.warnRatio
        : 0.8,
    agents: Array.isArray(options.agents) && options.agents.length ? options.agents.map(String) : ["*"],
    exclude: Array.isArray(options.exclude) ? options.exclude.map(String) : [],
    maxOutputTokensOnBlock:
      typeof options.maxOutputTokensOnBlock === "number" && options.maxOutputTokensOnBlock >= 1
        ? options.maxOutputTokensOnBlock
        : 1,
    onBlock: options.onBlock === "ask" ? "ask" : "stop",
    notify: options.notify !== false,
  };
  return cfg;
}

/**
 * Build the guard controller: hooks plus an `extend` handle used by the
 * `cost_guard_extend` tool and by tests.
 * @returns {{hooks: import("@opencode-ai/plugin").Hooks, extend: (sessionID: string, usd?: number) => number}}
 */
function createCostGuardController(cfg, client) {
  /** @type {Map<string, {messages: Map<string, number>, cost: number, agent?: string, model?: string, warned: boolean, blocked: boolean}>} */
  const sessions = new Map();

  const get = (id) => {
    let s = sessions.get(id);
    if (!s) {
      s = {
        messages: new Map(),
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        turnCount: 0,
        models: new Set(),
        first: undefined,
        last: undefined,
        agent: undefined,
        model: undefined,
        warned: false,
        blocked: false,
        limit: undefined,
        extra: 0,
      };
      sessions.set(id, s);
    }
    return s;
  };

  const recompute = (s) => {
    let cost = 0;
    const tok = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    const models = new Set();
    for (const m of s.messages.values()) {
      cost += m.cost || 0;
      const t = m.tokens;
      if (t) {
        tok.input += t.input || 0;
        tok.output += t.output || 0;
        tok.reasoning += t.reasoning || 0;
        if (t.cache) {
          tok.cacheRead += t.cache.read || 0;
          tok.cacheWrite += t.cache.write || 0;
        }
      }
      if (m.model) models.add(m.model);
    }
    s.cost = cost;
    s.tokens = tok;
    s.turnCount = s.messages.size;
    s.models = models;
  };

  const applies = (agent) => anyMatch(cfg.agents, agent) && !anyMatch(cfg.exclude, agent);

  const log = async (level, message, extra) => {
    if (!cfg.notify && level !== "error") return;
    try {
      await client.app.log({ body: { service: "cost-guard", level, message, extra } });
    } catch {
      /* logging must never break the session */
    }
  };

  const overLimit = async (sessionID) => {
    const s = get(sessionID);
    if (!applies(s.agent)) return false;
    const limit = resolveLimit(cfg, s.agent) + (s.extra || 0);
    s.limit = limit;
    if (s.cost >= limit) return true;
    if (!s.warned && s.cost >= limit * cfg.warnRatio) {
      s.warned = true;
      await log(
        "warn",
        `cost ${s.cost.toFixed(2)} USD reached ${Math.round(cfg.warnRatio * 100)}% of limit ${limit}` +
          `${s.agent ? ` (agent ${s.agent})` : ""}`,
        { sessionID, agent: s.agent, cost: s.cost, limit },
      );
    }
    return false;
  };

  /** Raise a session's limit and clear the blocked/warned flags. */
  const extend = (sessionID, usd) => {
    const s = get(sessionID);
    const base = resolveLimit(cfg, s.agent);
    const add = Number.isFinite(usd) && usd > 0 ? usd : base;
    s.extra = (s.extra || 0) + add;
    s.limit = base + s.extra;
    s.blocked = false;
    s.warned = false;
    return s.limit;
  };

  const isAskTool = (tool) => tool === "question" || String(tool).includes("cost_guard");

  /** One-line why for a session (used by the extend tool). */
  const describe = (sessionID) => explainCost(get(sessionID));

  const hooks = {
    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const info = event.properties.info;
        if (info.role === "assistant") {
          const s = get(info.sessionID);
          s.messages.set(info.id, {
            cost: typeof info.cost === "number" ? info.cost : 0,
            tokens: info.tokens || null,
            model: info.modelID ? `${info.providerID}/${info.modelID}` : null,
          });
          if (info.modelID) s.model = `${info.providerID}/${info.modelID}`;
          const created = info.time && info.time.created;
          if (created) {
            s.first = s.first == null ? created : Math.min(s.first, created);
            s.last = s.last == null ? created : Math.max(s.last, created);
          }
          recompute(s);
          await overLimit(info.sessionID);
        }
      } else if (event.type === "session.deleted") {
        sessions.delete(event.properties.info.id);
      }
    },

    "chat.message": async (input) => {
      const s = get(input.sessionID);
      if (input.agent) s.agent = input.agent;
    },

    "chat.params": async (input, output) => {
      const s = get(input.sessionID);
      if (input.agent) s.agent = input.agent;
      const over = await overLimit(input.sessionID);
      if (over && cfg.action === "block" && cfg.onBlock === "stop") {
        output.maxOutputTokens = cfg.maxOutputTokensOnBlock;
        if (!s.blocked) {
          s.blocked = true;
          await log("error", `limit ${s.limit} USD exceeded; capping output`, {
            sessionID: input.sessionID,
            agent: s.agent,
            cost: s.cost,
            why: explainCost(s),
          });
        }
      }
    },

    "tool.execute.before": async (input) => {
      const s = get(input.sessionID);
      const over = await overLimit(input.sessionID);
      if (!over || cfg.action !== "block") return;

      if (cfg.onBlock === "ask") {
        if (isAskTool(input.tool)) return; // let the agent ask and extend
        if (!s.blocked) {
          s.blocked = true;
          await log("error", `limit ${s.limit} USD exceeded; awaiting user approval`, {
            sessionID: input.sessionID,
            tool: input.tool,
            agent: s.agent,
            cost: s.cost,
            why: explainCost(s),
          });
        }
        throw new Error(
          `cost-guard: session cost ${s.cost.toFixed(2)} USD exceeded limit ${s.limit} USD` +
            `${s.agent ? ` (agent ${s.agent})` : ""}. Ask the user with the \`question\` tool whether to` +
            ` continue; if approved, call \`cost_guard_extend\` (optionally {"usd": <amount>}) and resume;` +
            ` otherwise stop.\n${explainCost(s)}`,
        );
      }

      if (!s.blocked) {
        s.blocked = true;
        await log("error", `limit ${s.limit} USD exceeded; stopping tool calls`, {
          sessionID: input.sessionID,
          tool: input.tool,
          agent: s.agent,
          cost: s.cost,
          why: explainCost(s),
        });
      }
      throw new Error(
        `cost-guard: session cost ${s.cost.toFixed(2)} USD exceeded limit ${s.limit} USD` +
          `${s.agent ? ` (agent ${s.agent})` : ""}. Raise the limit or switch to a cheaper model.\n` +
          explainCost(s),
      );
    },
  };

  return { hooks, extend, describe };
}

/** @returns {import("@opencode-ai/plugin").Hooks} */
function createCostGuard(cfg, client) {
  return createCostGuardController(cfg, client).hooks;
}

/**
 * opencode-cost-guard — plugin entry.
 *
 * Only plugin functions are exported from this file: opencode treats every
 * exported function in a plugin file as a plugin, so the helper logic lives in
 * ./lib.js and is imported here. (Named + default point at the same function,
 * matching opencode's own plugin examples.)
 */

/** Optional config file for local installs, where the plugin tuple can't pass options. */
async function loadFileOptions() {
  try {
    const fs = await import("node:fs/promises");
    const p =
      process.env.OPENCODE_COST_GUARD_CONFIG ||
      (process.env.HOME ? `${process.env.HOME}/.config/opencode/cost-guard.json` : null);
    if (!p) return null;
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return null;
  }
}

/** @type {import("@opencode-ai/plugin").Plugin} */
export const CostGuard = async ({ client }, options) => {
  const fileOptions = await loadFileOptions();
  const cfg = normalizeOptions({ ...(fileOptions || {}), ...(options || {}) });
  const { hooks, extend, describe } = createCostGuardController(cfg, client);

  if (cfg.onBlock === "ask") {
    let extendTool;
    try {
      const { tool } = await import("@opencode-ai/plugin");
      extendTool = tool({
        description:
          "Cost guard: extend this session's USD budget after the user approves continuing. " +
          "Call this once the user has agreed to continue past the cost limit.",
        args: {
          usd: tool.schema.number().optional().describe("USD to add to the session limit (default: one more limit)"),
        },
        async execute(args, context) {
          const limit = extend(context.sessionID, args?.usd);
          return `cost-guard: budget extended to ${limit.toFixed(2)} USD for this session.\n${describe(context.sessionID)}`;
        },
      });
    } catch {
      // Runtime without @opencode-ai/plugin resolvable (e.g. symlinked install):
      // register a dependency-free tool that adds one more limit.
      extendTool = {
        description:
          "Cost guard: extend this session's USD budget by one more limit after the user approves continuing.",
        args: {},
        async execute(_args, context) {
          const limit = extend(context.sessionID);
          return `cost-guard: budget extended to ${limit.toFixed(2)} USD for this session.\n${describe(context.sessionID)}`;
        },
      };
    }
    hooks.tool = { cost_guard_extend: extendTool };
  }

  return hooks;
};

export default CostGuard;
