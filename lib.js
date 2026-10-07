import os from "node:os";
import { randomUUID } from "node:crypto";
import { aggregate, canonicalRoot, createStore, descendants, newLedger, recordMessage, recordSession, tombstoneSession, addApproval, addConfig, mergeRecord, mergeLedger, deltaLedger, hasChanges, projectKey, effectiveBudgetLimits, globMatch } from "./accounting.js";
export { globMatch } from "./accounting.js";

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
 * Compact number formatting (1234 -> 1.2k, 1900000 -> 1.9M).
 * @param {number} n
 */
export function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(0) + "k";
  return String(v);
}

/**
 * One-line, human-readable explanation of *why* a session hit its budget.
 * @param {{cost:number, limit?:number, tokens?:{input:number,output:number,reasoning:number,cacheRead:number,cacheWrite:number}, turnCount?:number, models?:Set<string>|string[], first?:number, last?:number, agent?:string}} s
 */
export function explainCost(s) {
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
    onBlock: options.onBlock === "ask" ? "ask" : "stop",
    notify: options.notify !== false,
    tokenLimit: Number.isSafeInteger(options.tokenLimit) && options.tokenLimit > 0 ? options.tokenLimit : null,
    runLimit: Number.isFinite(options.runLimit) && options.runLimit > 0 ? options.runLimit : null,
    runTokenLimit: Number.isSafeInteger(options.runTokenLimit) && options.runTokenLimit > 0 ? options.runTokenLimit : null,
    usdEnabled: options.usdEnabled !== false,
    persist: options.persist !== false,
    stateDirectory: typeof options.stateDirectory === "string" ? options.stateDirectory : null,
  };
  return cfg;
}

/**
 * Build the guard controller: hooks plus an `extend` handle used by the
 * `cost_guard_extend` tool and by tests.
 * @returns {{hooks: import("@opencode-ai/plugin").Hooks, extend: (sessionID: string, usd?: number) => number}}
 */
export function createCostGuardController(cfg, client, projectDirectory, projectContext = {}) {
  /** @type {Map<string, {messages: Map<string, number>, cost: number, agent?: string, model?: string, warned: boolean, blocked: boolean}>} */
  const sessions = new Map();
  let ledger = newLedger();
  let storePromise = cfg.persist ? createStore({ directory: cfg.stateDirectory, filename: "cost-guard.json", projectDirectory }) : Promise.resolve(null);
  let writeQueue = Promise.resolve();
  let writerSeq = 0;
  const ready = storePromise.then(async (store) => { if (store) ledger = await store.load(); });
  let recoveredSessions = new Map();
  const enqueue = (mutation) => {
    writeQueue = writeQueue.then(async () => {
      await ready;
      const store = await storePromise;
      if (store) {
        const eventID = randomUUID();
        const before = await store.load();
        ledger = before;
        const draft = mergeLedger(before);
        const returned = mutation(draft, eventID);
        const changed = returned && returned.version ? mergeLedger(draft, returned) : draft;
        const delta = deltaLedger(before, changed);
        if (hasChanges(delta)) await store.append({ eventID, payload: delta });
        ledger = changed;
      } else {
        const returned = mutation(ledger, randomUUID());
        if (returned && returned.version) ledger = returned;
      }
    });
    return writeQueue;
  };
  const ensureRecovered = async (sessionID) => {
    if (recoveredSessions.has(sessionID)) return recoveredSessions.get(sessionID);
    const recovery = (async () => {
      await ready;
      if (typeof client?.session?.messages !== "function") return;
      try {
        const response = await client.session.messages({ path: { id: sessionID }, query: { limit: 500 } });
        const entries = response?.data ?? response;
        if (!Array.isArray(entries) || entries.length >= 500) return;
        const recovered = newLedger();
        for (const entry of entries) {
          const info = entry?.info;
          if (info?.role === "assistant") recordMessage(recovered, { ...info, sessionID: info.sessionID || sessionID }, { recovered: true, writerID: projectContext.instanceID || `${process.pid}` });
        }
        await enqueue((current) => mergeLedger(current, recovered));
      } catch { /* history is optional; missing coverage must not be described as complete */ }
    })();
    recoveredSessions.set(sessionID, recovery);
    return recovery;
  };
  const refresh = async () => {
    await ready;
    writeQueue = writeQueue.then(async () => {
      const store = await storePromise;
      if (store) ledger = await store.replaceFromDisk();
    });
    await writeQueue;
  };
  let generation = 0;
  const budgetSnapshot = () => ({ schema: "opencode-cost-guard-budget-v1", version: 1, projectKey: null, sessionLimit: cfg.limit,
    limits: cfg.limits, agents: cfg.agents, exclude: cfg.exclude, tokenLimit: cfg.tokenLimit, runLimit: cfg.runLimit, runTokenLimit: cfg.runTokenLimit,
    usdEnabled: cfg.usdEnabled });
  const publishConfig = async () => {
    if (!cfg.persist) return;
    const instanceID = projectContext.instanceID || `${os.hostname()}:${process.pid}`;
    const config = budgetSnapshot();
    const fingerprint = JSON.stringify({ ...config, approvals: undefined });
    const eventID = randomUUID();
    const leaseEvent = { eventID, projectKey: projectContext.projectKey, instanceID, pid: process.pid, hostname: os.hostname(),
      generation: ++generation, fingerprint, config, publishedAt: Date.now() };
    await enqueue((current) => addConfig(current, leaseEvent));
  };
  const setBudget = async (budget) => enqueue((current) => { current.budget = { ...budget, approvals: current.approvals }; });
  const sessionTotals = (id) => aggregate(ledger, [id]);
  const approved = (id, scope) => {
    const target = scope === "run" ? canonicalRoot(ledger, id).id : id;
    return ledger.approvals.reduce((sum, item) => {
      if (item.scope !== scope || item.sessionID !== target) return sum;
      for (const dimension of item.dimensions || []) {
        sum.usd += dimension.usd || 0;
        sum.tokens += dimension.tokens || 0;
      }
      return sum;
    }, { usd: 0, tokens: 0 });
  };

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
  const refreshSession = (id) => {
    const session = get(id);
    const totals = aggregate(ledger, [id]);
    session.cost = totals.cost;
    session.tokens = { input: totals.input, output: totals.output, reasoning: totals.reasoning,
      cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite };
    session.turnCount = totals.turns;
    session.models = totals.models;
    session.messages.clear();
    for (const record of Object.values(ledger.messages)) if (record.sessionID === id) {
      session.messages.set(record.id, { cost: record.usage.cost, tokens: { input: record.usage.tokens.input,
        output: record.usage.tokens.output, reasoning: record.usage.tokens.reasoning,
        cache: { read: record.usage.tokens.cacheRead, write: record.usage.tokens.cacheWrite } }, model: record.model });
    }
    return session;
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
    const s = refreshSession(sessionID);
    const enforceSession = applies(s.agent);
    const effective = effectiveBudgetLimits({ sessionLimit: cfg.limit, limits: cfg.limits, agents: cfg.agents, exclude: cfg.exclude,
      tokenLimit: cfg.tokenLimit, runLimit: cfg.runLimit, runTokenLimit: cfg.runTokenLimit, usdEnabled: cfg.usdEnabled },
    { agent: s.agent || "?", sessionID, rootID: canonicalRoot(ledger, sessionID).id, approvals: ledger.approvals });
    const limit = effective.sessionUsdLimit ?? resolveLimit(cfg, s.agent);
    s.limit = limit;
    const totals = sessionTotals(sessionID);
    s.cost = totals.cost ?? 0;
    s.tokens = { input: totals.input, output: totals.output, reasoning: totals.reasoning, cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite };
    const tokenLimit = effective.sessionTokenLimit;
    const usageOver = enforceSession && ((cfg.usdEnabled && effective.sessionUsdLimit != null && totals.cost >= effective.sessionUsdLimit) ||
      (tokenLimit != null && totals.totalTokens >= tokenLimit));
    const root = canonicalRoot(ledger, sessionID);
    const run = aggregate(ledger, descendants(ledger, root.id));
    const runLimit = effective.runUsdLimit;
    const runTokenLimit = effective.runTokenLimit;
      const runOver = root.complete && ((runLimit != null && run.cost >= runLimit) ||
      (runTokenLimit != null && run.totalTokens >= runTokenLimit));
    if (usageOver || runOver) return true;
    if (s.blocked) s.blocked = false;
    const threshold = (cfg.usdEnabled && effective.sessionUsdLimit != null && totals.cost >= effective.sessionUsdLimit * cfg.warnRatio) ||
      (tokenLimit != null && totals.totalTokens >= tokenLimit * cfg.warnRatio) ||
      (runLimit != null && run.cost >= runLimit * cfg.warnRatio) ||
      (runTokenLimit != null && run.totalTokens >= runTokenLimit * cfg.warnRatio);
    if (!threshold && s.warned) s.warned = false;
    if (!s.warned && threshold) {
      s.warned = true;
      await log(
        "warn",
        `usage reached ${Math.round(cfg.warnRatio * 100)}% of a configured budget` +
          `${s.agent ? ` (agent ${s.agent})` : ""}`,
        { sessionID, agent: s.agent, cost: totals.cost, limit, totalTokens: totals.totalTokens },
      );
    }
    return false;
  };

  /** Raise a session's limit and clear the blocked/warned flags. */
  const extend = async (sessionID, usd, tokens, scope = "session") => {
    await refresh();
    const s = refreshSession(sessionID);
    const root = scope === "run" ? canonicalRoot(ledger, sessionID).id : sessionID;
    const dimensions = [];
    if (usd != null) {
      if (!cfg.usdEnabled || (scope === "run" ? cfg.runLimit == null : false)) throw new Error(`cost-guard: ${scope} USD budget is not active`);
      if (!Number.isFinite(usd) || usd <= 0) throw new Error("cost-guard: USD extension must be positive");
      dimensions.push({ usd });
    }
    if (tokens != null) {
      if (!Number.isSafeInteger(tokens) || tokens <= 0 || (scope === "run" ? cfg.runTokenLimit == null : cfg.tokenLimit == null)) throw new Error(`cost-guard: ${scope} token budget is not active or extension is invalid`);
      dimensions.push({ tokens });
    }
    if (!dimensions.length) {
      if (scope === "run") throw new Error("cost-guard: specify a USD and/or token amount for a run extension");
      if (!cfg.usdEnabled && cfg.tokenLimit != null) dimensions.push({ tokens: cfg.tokenLimit });
      else if (cfg.usdEnabled) dimensions.push({ usd: resolveLimit(cfg, s.agent) });
      else throw new Error("cost-guard: no active budget dimension to extend");
    }
    const approval = { id: `${process.pid}:${Date.now()}:${Math.random()}`, scope, sessionID: root, dimensions, createdAt: Date.now() };
    await enqueue((current, eventID) => addApproval(current, { ...approval, id: eventID, eventID }));
    s.blocked = false;
    s.warned = false;
    return scope === "run" ? root : resolveLimit(cfg, s.agent) + approved(sessionID, "session").usd;
  };

  const isAskTool = (tool) => tool === "question" || String(tool).includes("cost_guard");

  /** One-line why for a session (used by the extend tool). */
  const describe = (sessionID) => explainCost(get(sessionID));

    const hooks = {
    event: async ({ event }) => {
      await ready;
      if (event.type === "message.updated") {
        const info = event.properties.info;
        if (info.role === "assistant") {
          await ensureRecovered(info.sessionID);
          await enqueue((current, eventID) => recordMessage(current, info, { eventID, writerID: projectContext.instanceID || `${process.pid}`, writerSeq: ++writerSeq }));
          await publishConfig();
          const s = refreshSession(info.sessionID);
          await overLimit(info.sessionID);
        }
      } else if (event.type === "session.created" || event.type === "session.updated") {
        await enqueue((current, eventID) => { recordSession(current, event.properties.info, { eventID, writerID: projectContext.instanceID || `${process.pid}`, writerSeq: ++writerSeq }); });
      } else if (event.type === "session.deleted") {
        await enqueue((current, eventID) => { tombstoneSession(current, event.properties.info.id, { eventID, writerID: projectContext.instanceID || `${process.pid}` }); });
      }
    },

    "chat.message": async (input) => {
      const s = get(input.sessionID);
      if (input.agent) s.agent = input.agent;
    },

    "chat.params": async (input, output) => {
      await refresh();
      const s = refreshSession(input.sessionID);
      if (input.agent) s.agent = input.agent;
      const over = await overLimit(input.sessionID);
      if (over && cfg.action === "block" && cfg.onBlock === "stop") {
        output.maxOutputTokens = Math.min(output.maxOutputTokens || Infinity, cfg.maxOutputTokensOnBlock);
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
      await refresh();
      const s = refreshSession(input.sessionID);
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
      `cost-guard: session usage exceeded an active budget` +
            `${s.agent ? ` (agent ${s.agent})` : ""}. Ask the user with the \`question\` tool whether to` +
          ` continue and how much extra USD or tokens to grant, then call \`cost_guard_extend\` and resume; otherwise stop.\n${explainCost(s)}`,
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
      `cost-guard: session or run usage exceeded an active budget` +
          `${s.agent ? ` (agent ${s.agent})` : ""}. Raise the limit or switch to a cheaper model.\n` +
          explainCost(s),
      );
    },
    "session.idle": async () => { await refresh(); await publishConfig(); },
  };

  return { hooks, extend, describe, ready, refresh, publishConfig, _ledger: () => ledger, _store: () => storePromise, budgetSnapshot, setBudget };
}

/** @returns {import("@opencode-ai/plugin").Hooks} */
export function createCostGuard(cfg, client) {
  return createCostGuardController(cfg, client).hooks;
}
