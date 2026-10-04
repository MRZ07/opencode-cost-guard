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
export function globMatch(pattern, value) {
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
export function parseLimits(raw, fallback = 5) {
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
export function resolveLimit(cfg, agent) {
  if (agent && cfg.limits && cfg.limits.length) {
    for (const [pattern, n] of cfg.limits) {
      if (globMatch(pattern, agent)) return n;
    }
  }
  return cfg.limit;
}

/**
 * @param {PluginOptions|undefined} options
 */
export function normalizeOptions(options = {}) {
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
    notify: options.notify !== false,
  };
  return cfg;
}

/** @returns {import("@opencode-ai/plugin").Hooks} */
export function createCostGuard(cfg, client) {
  /** @type {Map<string, {messages: Map<string, number>, cost: number, agent?: string, model?: string, warned: boolean, blocked: boolean}>} */
  const sessions = new Map();

  const get = (id) => {
    let s = sessions.get(id);
    if (!s) {
      s = { messages: new Map(), cost: 0, agent: undefined, model: undefined, warned: false, blocked: false, limit: undefined };
      sessions.set(id, s);
    }
    return s;
  };

  const recompute = (s) => {
    let total = 0;
    for (const c of s.messages.values()) total += c;
    s.cost = total;
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
    const limit = resolveLimit(cfg, s.agent);
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

  return {
    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const info = event.properties.info;
        if (info.role === "assistant") {
          const s = get(info.sessionID);
          s.messages.set(info.id, typeof info.cost === "number" ? info.cost : 0);
          if (info.modelID) s.model = `${info.providerID}/${info.modelID}`;
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
      if ((await overLimit(input.sessionID)) && cfg.action === "block") {
        output.maxOutputTokens = cfg.maxOutputTokensOnBlock;
        if (!s.blocked) {
          s.blocked = true;
          await log("error", `limit ${s.limit} USD exceeded; capping output`, {
            sessionID: input.sessionID,
            agent: s.agent,
            cost: s.cost,
          });
        }
      }
    },

    "tool.execute.before": async (input) => {
      const s = get(input.sessionID);
      if ((await overLimit(input.sessionID)) && cfg.action === "block") {
        if (!s.blocked) {
          s.blocked = true;
          await log("error", `limit ${s.limit} USD exceeded; stopping tool calls`, {
            sessionID: input.sessionID,
            tool: input.tool,
            cost: s.cost,
          });
        }
        throw new Error(
          `cost-guard: session cost ${s.cost.toFixed(2)} USD exceeded limit ${s.limit} USD` +
            `${s.agent ? ` (agent ${s.agent})` : ""}. Raise the limit or switch to a cheaper model.`,
        );
      }
    },
  };
}

/** @type {Plugin} */
export const CostGuard = async ({ client }, options) => {
  const cfg = normalizeOptions(options || {});
  return createCostGuard(cfg, client);
};

export default CostGuard;
