import { validateOptions } from "./options.js";
import { createApprovalGate } from "./approval.js";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { aggregate, canonicalRoot, createStore, descendants, newLedger, recordMessage, recordSession, tombstoneSession, addApproval, addConfig, mergeRecord, mergeLedger, deltaLedger, hasChanges, projectKey, effectiveBudgetLimits, formatSubagentCheckpoint, appendSubagentCheckpoints, globMatch } from "./accounting.js";
export { globMatch } from "./accounting.js";

/**
 * opencode-cost-guard
 *
 * Warn or block normal tools in an opencode session when its accumulated LLM spend
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
/** Bound SDK waits even when an adapter ignores AbortSignal. */
export async function guardRequest(method, args, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => method({ ...args, signal: controller.signal }, { signal: controller.signal })),
      new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(new Error("host request timed out"));
      }, timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
const projectKeyForDirectory = (directory) => projectKey(directory);

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
  const effective = validateOptions({ ...options,
    ...(envLimit != null ? { limit: Number(envLimit), limits: undefined } : {}),
    ...(envAction != null ? { action: envAction.toLowerCase() } : {}),
  });
  const parsed = parseLimits(effective.limits ?? effective.limit, 5);
  return { ...effective, limit: parsed.default, limits: parsed.perAgent,
    tokenLimit: effective.tokenLimit ?? null, subagentTokenLimit: effective.subagentTokenLimit ?? null,
    runLimit: effective.runLimit ?? null, runTokenLimit: effective.runTokenLimit ?? null,
    stateDirectory: effective.stateDirectory ?? null };
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
  const approvalGate = createApprovalGate();
  const historyCoverage = new Map();
  let storePromise = cfg.persist ? createStore({ directory: cfg.stateDirectory, filename: "cost-guard.json", projectDirectory }) : Promise.resolve(null);
  let writeQueue = Promise.resolve();
  let writerSeq = 0;
  const transientTitles = new Map();
  const metadataParents = new Map();
  let projectKey = projectContext.projectKey || null;
  const projectIdentity = projectKey ? Promise.resolve(projectKey) : projectKeyForDirectory(projectDirectory);
  const ready = Promise.all([storePromise, projectIdentity]).then(async ([store, key]) => { projectKey = key; if (store) ledger = await store.load(); });
  let recoveredSessions = new Map();
  const verifiedMetadataRequests = new Map();
  const enqueue = (mutation) => {
    writeQueue = writeQueue.catch(() => {}).then(async () => {
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
  const verifySessionMetadata = async (sessionID) => {
    if (verifiedMetadataRequests.has(sessionID)) return verifiedMetadataRequests.get(sessionID);
    const pending = (async () => {
      if (typeof client?.session?.get !== "function") return false;
      try {
        const response = await guardRequest(client.session.get.bind(client.session), { path: { id: sessionID } }, cfg.historyTimeoutMs);
        const info = response?.data;
        if (!info || response.error || info.id !== sessionID || typeof info.directory !== "string" ||
          await projectKeyForDirectory(info.directory) !== projectKey || typeof info.projectID !== "string") return false;
        if (typeof info.title === "string") transientTitles.set(sessionID, info.title.slice(0, 512));
        metadataParents.set(sessionID, Object.hasOwn(info, "parentID") ? info.parentID : null);
        await enqueue((current, eventID) => recordSession(current, info, { eventID, writerID: projectContext.instanceID || `${process.pid}`,
          metadataVerified: true, projectKey }));
        return ledger.sessions[sessionID]?.metadataVerified === true && ledger.sessions[sessionID]?.projectKey === projectKey;
      } catch { return false; }
    })();
    verifiedMetadataRequests.set(sessionID, pending);
    const verified = await pending;
    if (!verified) verifiedMetadataRequests.delete(sessionID);
    return verified;
  };
  const recoverAncestry = async (sessionID) => {
    await ready;
    const existing = canonicalRoot(ledger, sessionID, projectKey);
    if (existing.complete) return existing;
    let current = sessionID;
    const seen = new Set();
    for (let depth = 0; depth < 128; depth++) {
      if (seen.has(current)) return { id: current, complete: false, reason: "cycle", isRoot: false };
      seen.add(current);
      if (!(await verifySessionMetadata(current))) return canonicalRoot(ledger, sessionID, projectKey);
      await refresh();
      const session = ledger.sessions[current];
      const sdkParent = metadataParents.get(current);
      if (!session || session.metadataVerified !== true || session.projectKey !== projectKey || sdkParent === undefined)
        return canonicalRoot(ledger, sessionID, projectKey);
      if (sdkParent == null) return canonicalRoot(ledger, sessionID, projectKey);
      if (typeof sdkParent !== "string" || !sdkParent) return canonicalRoot(ledger, sessionID, projectKey);
      current = sdkParent;
    }
    return { id: current, complete: false, reason: "depth-limit", isRoot: false };
  };
  const ensureRecovered = async (sessionID) => {
    if (recoveredSessions.has(sessionID)) return recoveredSessions.get(sessionID);
    const recovery = (async () => {
      await ready;
      let before;
      const seen = new Set();
      try {
        if (typeof client?.session?.messages !== "function") throw new Error("session.messages API unavailable");
        for (let page = 0; page < cfg.historyMaxPages; page++) {
          const response = await guardRequest(client.session.messages.bind(client.session), { path: { id: sessionID },
            query: { limit: cfg.historyPageSize, ...(before ? { before } : {}) } }, cfg.historyTimeoutMs);
          if (response?.error) throw new Error("session.messages API failed");
          const entries = response?.data ?? response;
          if (!Array.isArray(entries)) throw new Error("invalid message page");
          const recovered = newLedger();
          for (const entry of entries) {
            const info = entry?.info;
            if (!info?.id || info.sessionID !== sessionID) throw new Error("invalid or cross-session message page");
            if (info.role === "assistant") recordMessage(recovered, info,
              { recovered: true, writerID: projectContext.instanceID || `${process.pid}` });
          }
          if (hasChanges(recovered)) await enqueue((current) => mergeLedger(current, recovered));
          const headers = response?.response?.headers ?? response?.headers;
          const cursor = headers?.get?.("x-next-cursor") ?? headers?.["x-next-cursor"];
          if (!cursor && (entries.length < cfg.historyPageSize || (headers && entries.length === cfg.historyPageSize))) {
            historyCoverage.set(sessionID, { complete: true });
            return;
          }
          // A full page without a cursor cannot prove complete recovery on older hosts.
          if (!cursor || seen.has(cursor)) throw new Error("missing or repeated history cursor");
          seen.add(cursor);
          before = cursor;
        }
        throw new Error("history page bound reached");
      } catch (error) {
        historyCoverage.set(sessionID, { complete: false, reason: error.message });
        await log("warn", `history coverage incomplete: ${error.message}`, { sessionID });
      }
    })();
    recoveredSessions.set(sessionID, recovery);
    await recovery;
    if (!historyCoverage.get(sessionID)?.complete) recoveredSessions.delete(sessionID);
  };
  const refresh = async () => {
    await ready;
    writeQueue = writeQueue.catch(() => {}).then(async () => {
      const store = await storePromise;
      if (store) ledger = await store.replaceFromDisk();
    });
    await writeQueue;
  };
  const verifiedTaskEntries = async (callerSessionID) => {
    await recoverAncestry(callerSessionID);
    await refresh();
    const caller = canonicalRoot(ledger, callerSessionID, projectKey);
    if (!caller.complete || caller.isRoot !== true) return [];
    const candidates = descendants(ledger, callerSessionID).filter((id) => id !== callerSessionID);
    const eligible = [];
    for (const childID of candidates) {
      const ancestry = canonicalRoot(ledger, childID, projectKey);
      if (!ancestry.complete || ancestry.id !== callerSessionID) continue;
      const totals = aggregate(ledger, [childID]);
      const child = ledger.sessions[childID];
      const agent = [...Object.values(ledger.messages)].find((message) => message.sessionID === childID)?.mode || "unknown";
      const effective = effectiveBudgetLimits({ subagentTokenLimit: cfg.subagentTokenLimit, tokenLimit: cfg.tokenLimit,
        agents: cfg.agents, exclude: cfg.exclude, usdEnabled: cfg.usdEnabled }, { agent, sessionID: childID, rootID: callerSessionID,
        approvals: ledger.approvals, ancestry });
      if (effective.subagentEffectiveLimit == null || totals.totalTokens < effective.subagentEffectiveLimit) continue;
      eligible.push({ id: childID, title: transientTitles.get(childID), totalTokens: totals.totalTokens,
        input: totals.input, output: totals.output, reasoning: totals.reasoning, limit: effective.subagentEffectiveLimit,
        approvalTokens: effective.subagentBaseLimit });
    }
    return eligible;
  };
  const verifiedTaskNotice = async (callerSessionID, limit = 8) =>
    appendSubagentCheckpoints("", await verifiedTaskEntries(callerSessionID), { limit });
  let generation = 0;
  let lastConfigPublication = 0;
  const budgetSnapshot = () => ({ schema: "opencode-cost-guard-budget-v1", version: 1, projectKey: null, sessionLimit: cfg.limit,
    limits: cfg.limits, agents: cfg.agents, exclude: cfg.exclude, tokenLimit: cfg.tokenLimit, subagentTokenLimit: cfg.subagentTokenLimit, runLimit: cfg.runLimit, runTokenLimit: cfg.runTokenLimit,
    usdEnabled: cfg.usdEnabled });
  const publishConfig = async () => {
    if (!cfg.persist || Date.now() - lastConfigPublication < cfg.configRefreshMs) return;
    const instanceID = projectContext.instanceID || `${os.hostname()}:${process.pid}`;
    const config = budgetSnapshot();
    const fingerprint = JSON.stringify({ ...config, approvals: undefined });
    const eventID = randomUUID();
    const leaseEvent = { eventID, projectKey, instanceID, pid: process.pid, hostname: os.hostname(),
      generation: ++generation, fingerprint, config, publishedAt: Date.now() };
    await enqueue((current) => addConfig(current, leaseEvent));
    lastConfigPublication = Date.now();
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
    const ancestry = canonicalRoot(ledger, sessionID, projectKey);
    const effective = effectiveBudgetLimits({ sessionLimit: cfg.limit, limits: cfg.limits, agents: cfg.agents, exclude: cfg.exclude,
      tokenLimit: cfg.tokenLimit, subagentTokenLimit: cfg.subagentTokenLimit, runLimit: cfg.runLimit, runTokenLimit: cfg.runTokenLimit, usdEnabled: cfg.usdEnabled },
    { agent: s.agent || "?", sessionID, rootID: ancestry.id, approvals: ledger.approvals, ancestry });
    const limit = effective.sessionUsdLimit ?? resolveLimit(cfg, s.agent);
    s.limit = limit;
    const totals = sessionTotals(sessionID);
    s.cost = totals.cost ?? 0;
    s.tokens = { input: totals.input, output: totals.output, reasoning: totals.reasoning, cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite };
    const tokenLimit = effective.sessionTokenLimit;
    const legacyOver = enforceSession && ((cfg.usdEnabled && effective.sessionUsdLimit != null && totals.cost >= effective.sessionUsdLimit) ||
      (effective.legacyTokenLimit != null && totals.totalTokens >= effective.legacyTokenLimit + effective.sessionExtensionTokens));
    const subagentOver = effective.subagentEffectiveLimit != null && totals.totalTokens >= effective.subagentEffectiveLimit;
    const usageOver = legacyOver || subagentOver;
    const root = ancestry;
    const run = aggregate(ledger, descendants(ledger, root.id));
    const runLimit = effective.runUsdLimit;
    const runTokenLimit = effective.runTokenLimit;
    const runOver = root.complete && ((runLimit != null && run.cost >= runLimit) ||
      (runTokenLimit != null && run.totalTokens >= runTokenLimit));
    const threshold = (cfg.usdEnabled && effective.sessionUsdLimit != null && totals.cost >= effective.sessionUsdLimit * cfg.warnRatio) ||
      (effective.sessionTokenLimit != null && totals.totalTokens >= effective.sessionTokenLimit * cfg.warnRatio) ||
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
    if (usageOver || runOver) return true;
    if (cfg.incompleteHistory === "block" && historyCoverage.get(sessionID)?.complete !== true) return true;
    if (s.blocked) s.blocked = false;
    return false;
  };

  /** Validate and bind an extension before asking the user. */
  const planExtension = async (callerSessionID, usd, tokens, scope = "session", targetSessionID = callerSessionID) => {
    await recoverAncestry(callerSessionID);
    if (targetSessionID !== callerSessionID) await recoverAncestry(targetSessionID);
    await refresh();
    const callerAncestry = canonicalRoot(ledger, callerSessionID, projectKey);
    const targetAncestry = canonicalRoot(ledger, targetSessionID, projectKey);
    if (targetSessionID !== callerSessionID && (!callerAncestry.complete || callerAncestry.isRoot !== true || callerAncestry.id !== callerSessionID ||
      !targetAncestry.complete || targetAncestry.id !== callerSessionID || targetAncestry.isRoot || !targetAncestry.projectKey ||
      targetAncestry.projectKey !== callerAncestry.projectKey || targetAncestry.projectKey !== projectKey))
      throw new Error("cost-guard: target session is not a verified descendant in the caller's project");
    if (scope === "run" && !targetAncestry.complete) throw new Error("cost-guard: run extension requires verified root ancestry");
    if (!callerAncestry.complete || !callerAncestry.isRoot || callerAncestry.projectKey !== projectKey)
      throw new Error("cost-guard: only the verified parent root may approve a budget extension; return this blocker to the parent");
    if (!["session", "run"].includes(scope)) throw new Error("cost-guard: invalid budget scope");
    if (targetSessionID !== callerSessionID && scope === "run") throw new Error("cost-guard: cross-session run extensions are not allowed");
    await ensureRecovered(callerSessionID);
    if (targetSessionID !== callerSessionID) await ensureRecovered(targetSessionID);
    if (cfg.incompleteHistory === "block" && [callerSessionID, targetSessionID].some((id) => historyCoverage.get(id)?.complete !== true))
      throw new Error("cost-guard: history coverage incomplete; repair history access before requesting a budget extension");
    const s = refreshSession(targetSessionID);
    const root = scope === "run" ? targetAncestry.id : targetSessionID;
    const dimensions = [];
    if (usd != null) {
      if (!cfg.usdEnabled || (scope === "run" ? cfg.runLimit == null : false)) throw new Error(`cost-guard: ${scope} USD budget is not active`);
      if (!Number.isFinite(usd) || usd <= 0) throw new Error("cost-guard: USD extension must be positive");
      dimensions.push({ usd });
    }
    if (tokens != null) {
      if (!Number.isSafeInteger(tokens) || tokens <= 0 || (scope === "run" ? cfg.runTokenLimit == null : cfg.tokenLimit == null && cfg.subagentTokenLimit == null)) throw new Error(`cost-guard: ${scope} token budget is not active or extension is invalid`);
      dimensions.push({ tokens });
    }
      if (!dimensions.length) {
      if (scope === "run") throw new Error("cost-guard: specify a USD and/or token amount for a run extension");
      const effective = effectiveBudgetLimits({ tokenLimit: cfg.tokenLimit, subagentTokenLimit: cfg.subagentTokenLimit,
        agents: cfg.agents, exclude: cfg.exclude, usdEnabled: cfg.usdEnabled }, { agent: s.agent, sessionID: targetSessionID,
        rootID: targetAncestry.id, approvals: ledger.approvals, ancestry: targetAncestry });
      if (cfg.usdEnabled) dimensions.push({ usd: resolveLimit(cfg, s.agent) });
      else {
        const activeTokenBases = [effective.legacyTokenLimit, effective.subagentBaseLimit].filter((value) => value != null);
        if (activeTokenBases.length) dimensions.push({ tokens: Math.min(...activeTokenBases) });
        else throw new Error("cost-guard: no active budget dimension to extend");
      }
    }
    return { callerSessionID, targetSessionID, scope,
      usd: dimensions.find((item) => item.usd != null)?.usd ?? null,
      tokens: dimensions.find((item) => item.tokens != null)?.tokens ?? null };
  };
  const requestExtension = async (...args) => approvalGate.prepare(await planExtension(...args));
  const extend = async (...args) => {
    const plan = await planExtension(...args);
    approvalGate.consume(plan);
    const { callerSessionID, targetSessionID, usd, tokens, scope } = plan;
    const targetAncestry = canonicalRoot(ledger, targetSessionID, projectKey);
    const s = refreshSession(targetSessionID);
    const root = scope === "run" ? targetAncestry.id : targetSessionID;
    const dimensions = [...(usd == null ? [] : [{ usd }]), ...(tokens == null ? [] : [{ tokens }])];
    const approval = { id: `${process.pid}:${Date.now()}:${Math.random()}`, scope, sessionID: root, dimensions, createdAt: Date.now() };
    await enqueue((current, eventID) => addApproval(current, { ...approval, id: eventID, eventID }));
    s.blocked = false;
    s.warned = false;
    return scope === "run" ? root : targetSessionID === callerSessionID ? resolveLimit(cfg, s.agent) + approved(targetSessionID, "session").usd : effectiveBudgetLimits({ tokenLimit: cfg.tokenLimit,
      subagentTokenLimit: cfg.subagentTokenLimit, agents: cfg.agents, exclude: cfg.exclude, usdEnabled: cfg.usdEnabled }, { agent: s.agent,
      sessionID: targetSessionID, rootID: root, approvals: ledger.approvals, ancestry: targetAncestry }).effectiveSessionTokenLimit;
  };

  const isAskTool = (tool) => tool === "question" || tool === "cost_guard_extend";

  /** One-line why for a session (used by the extend tool). */
  const describe = (sessionID) => explainCost(get(sessionID));

    const hooks = {
    event: async ({ event }) => {
      await ready;
      approvalGate.event(event);
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
        const info = event.properties.info;
        verifiedMetadataRequests.delete(info.id);
        if (typeof info.title === "string") transientTitles.set(info.id, info.title.slice(0, 512));
        let verified = false;
        try { verified = typeof info.directory === "string" && await projectKeyForDirectory(info.directory) === projectKey; }
        catch { verified = false; }
        await enqueue((current, eventID) => { recordSession(current, info, { eventID, writerID: projectContext.instanceID || `${process.pid}`, writerSeq: ++writerSeq,
          metadataVerified: verified, projectKey: verified ? projectKey : null }); });
      } else if (event.type === "session.idle") {
        await refresh();
        await publishConfig();
      } else if (event.type === "session.deleted") {
        await enqueue((current, eventID) => { tombstoneSession(current, event.properties.info.id, { eventID, writerID: projectContext.instanceID || `${process.pid}` }); });
      }
    },

    "chat.message": async (input) => {
      const s = get(input.sessionID);
      if (input.agent) s.agent = input.agent;
    },

    "chat.params": async (input, output) => {
      await ensureRecovered(input.sessionID);
      await recoverAncestry(input.sessionID);
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
      await ensureRecovered(input.sessionID);
      await recoverAncestry(input.sessionID);
      await refresh();
      const s = refreshSession(input.sessionID);
      const ancestry = canonicalRoot(ledger, input.sessionID, projectKey);
      const totals = sessionTotals(input.sessionID);
      const effective = effectiveBudgetLimits({ sessionLimit: cfg.limit, limits: cfg.limits, agents: cfg.agents, exclude: cfg.exclude,
        tokenLimit: cfg.tokenLimit, subagentTokenLimit: cfg.subagentTokenLimit, runLimit: cfg.runLimit, runTokenLimit: cfg.runTokenLimit, usdEnabled: cfg.usdEnabled },
      { agent: s.agent || "?", sessionID: input.sessionID, rootID: ancestry.id, approvals: ledger.approvals, ancestry });
      const over = await overLimit(input.sessionID);
      if (!over || cfg.action !== "block") return;
      if (cfg.onBlock === "ask" && isAskTool(input.tool)) return;
      const coverage = historyCoverage.get(input.sessionID);
      if (cfg.incompleteHistory === "block" && coverage?.complete !== true)
        throw new Error(`cost-guard: history coverage incomplete (${coverage?.reason || "not recovered"}). Repair host/history access or recovery bounds, then retry. Budget extensions do not repair coverage; subagents must return this blocker to their parent.`);

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
        const title = transientTitles.get(input.sessionID)?.replace(/[\\r\\n<>]/g, " ").slice(0, 80);
        const checkpoint = effective.subagentEffectiveLimit != null
          ? `${formatSubagentCheckpoint({ id: input.sessionID, title, totalTokens: totals.totalTokens, input: totals.input, output: totals.output,
            reasoning: totals.reasoning, limit: effective.subagentEffectiveLimit, approvalTokens: effective.subagentBaseLimit })} Parent root ${ancestry.id} is the authority for this decision. `
          : "Ask the user whether to continue and how much extra USD or tokens to grant, then call cost_guard_extend and resume; otherwise stop. The existing question tool remains available when permitted. ";
        throw new Error(`cost-guard: active budget exceeded or history coverage incomplete (${historyCoverage.get(input.sessionID)?.reason || "coverage available"}). ${checkpoint}input ${totals.input} + output ${totals.output} + reasoning ${totals.reasoning} = ${totals.totalTokens} budget tokens (cache excluded). ${explainCost(s)}`);
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
    "tool.execute.after": async (input, output) => {
      const { tool, sessionID } = input;
      if (tool === "question") approvalGate.afterQuestion(input, output);
      if (tool !== "task" || !output || typeof output !== "object") return;
      const entries = await verifiedTaskEntries(sessionID);
      if (!entries.length) return;
      output.output = appendSubagentCheckpoints(output.output, entries);
    },
    "session.idle": async () => { await refresh(); await publishConfig(); },
  };

  return { hooks, extend, requestExtension, describe, ready, refresh, publishConfig, verifiedTaskNotice, verifiedTaskEntries, recoverAncestry,
    ingestSession: async (info) => {
      if (typeof info?.title === "string") transientTitles.set(info.id, info.title.slice(0, 512));
      if (Object.hasOwn(info || {}, "parentID")) metadataParents.set(info.id, info.parentID);
      const verified = typeof info?.directory === "string" && typeof info.projectID === "string" &&
        await projectKeyForDirectory(info.directory) === projectKey;
      await enqueue((current, eventID) => recordSession(current, info, { eventID, writerID: projectContext.instanceID || `${process.pid}`,
        metadataVerified: verified, projectKey: verified ? projectKey : null }));
    }, _ledger: () => ledger, _store: () => storePromise, budgetSnapshot, setBudget };
}

/** @returns {import("@opencode-ai/plugin").Hooks} */
export function createCostGuard(cfg, client) {
  return createCostGuardController(cfg, client).hooks;
}
