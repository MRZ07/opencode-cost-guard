import assert from "node:assert/strict";
import {
  createCostGuard,
  createCostGuardController,
  explainCost,
  fmtNum,
  normalizeOptions as rawNormalizeOptions,
  resolveLimit,
} from "../lib.js";
import { projectKey } from "../accounting.js";
import { CostGuard } from "../index.js";

const normalizeOptions = (options = {}) => rawNormalizeOptions({ ...options, persist: false });

const logs = [];
const client = {
  app: {
    log: async ({ body }) => {
      logs.push(body);
    },
  },
};

function assistantEvent(sessionID, id, cost, extra = {}) {
  return {
    event: {
      type: "message.updated",
      properties: {
        info: { role: "assistant", sessionID, id, cost, providerID: "p", modelID: "m", ...extra },
      },
    },
  };
}

// 1. Normalization + env override
{
  const c = normalizeOptions({ limit: 3 });
  assert.equal(c.limit, 3);
  assert.equal(c.action, "warn");
  process.env.OPENCODE_COST_GUARD_ACTION = "block";
  assert.equal(normalizeOptions({}).action, "block");
  delete process.env.OPENCODE_COST_GUARD_ACTION;
}

// Native tool.execute.after output is output.output (a string), and checkpoint markers dedupe across plugin-order repeats.
{
  const hooks = await CostGuard({ client: { ...client, session: { get: async ({ path: { id } }) => ({ data: {
    id, directory: process.cwd(), projectID: "project", ...(id === "native-root" ? { parentID: null } : { parentID: "native-root" }),
  } }) } }, directory: { worktree: process.cwd() } }, { persist: false, subagentTokenLimit: 10, action: "block", onBlock: "ask" });
  await hooks.event({ event: { type: "session.created", properties: { info: { id: "native-root", parentID: null, directory: process.cwd(), projectID: "project" } } } });
  await hooks.event({ event: { type: "session.created", properties: { info: { id: "native-child", parentID: "native-root", directory: process.cwd(), projectID: "project" } } } });
  await hooks.event(assistantEvent("native-child", "native-cap", 0, { tokens: { input: 10, output: 0, reasoning: 0 } }));
  await assert.rejects(() => hooks["tool.execute.before"]({ tool: "bash", sessionID: "native-child" }), /active budget/);
  const nativeOutput = { title: "Completed", output: "task result", metadata: { kept: true } };
  await hooks["tool.execute.after"]({ tool: "task", sessionID: "native-root" }, nativeOutput);
  const once = nativeOutput.output;
  await hooks["tool.execute.after"]({ tool: "task", sessionID: "native-root" }, nativeOutput);
  assert.equal(nativeOutput.output, once, "stable child marker avoids duplicate on repeated native task hook");
  assert.match(nativeOutput.output, /Ask the user: \(1\) Evaluate stuck first/);
  assert.equal(nativeOutput.title, "Completed");
  assert.deepEqual(nativeOutput.metadata, { kept: true });
  assert.equal((nativeOutput.output.match(/<!-- cost-guard-checkpoint:native-child -->/g) || []).length, 1);

  for (let index = 1; index <= 9; index++) {
    const id = `bounded-child-${index}`;
    await hooks.event({ event: { type: "session.created", properties: { info: { id, parentID: "native-root", directory: process.cwd(), projectID: "project" } } } });
    await hooks.event(assistantEvent(id, "under-cap", 0, { tokens: { input: index === 9 ? 10 : 0, output: 0, reasoning: 0 } }));
  }
  const boundedController = createCostGuardController(normalizeOptions({ persist: false, subagentTokenLimit: 10, action: "block", onBlock: "ask" }), {
    ...client, session: { get: async ({ path: { id } }) => ({ data: { id, directory: process.cwd(), projectID: "project",
      ...(id === "native-root" ? { parentID: null } : { parentID: "native-root" }) } }) },
  }, process.cwd());
  await boundedController.hooks.event({ event: { type: "session.created", properties: { info: { id: "native-root", parentID: null, directory: process.cwd() } } } });
  for (let index = 1; index <= 9; index++) {
    const id = `bounded-child-${index}`;
    await boundedController.hooks.event({ event: { type: "session.created", properties: { info: { id, parentID: "native-root", directory: process.cwd(), projectID: "project" } } } });
    await boundedController.hooks.event(assistantEvent(id, "under-cap", 0, { tokens: { input: 10, output: 0, reasoning: 0 } }));
  }
  const bounded = await boundedController.verifiedTaskNotice("native-root");
  assert.match(await boundedController.verifiedTaskNotice("native-root"), /bounded-child-9/);
  assert.match(bounded, /bounded-child-9/);
  const shownCount = bounded.match(/<!-- cost-guard-checkpoint:bounded-child-\d+ -->/g)?.length || 0;
  assert.match(bounded, new RegExp(`showing ${shownCount} of 9 over-budget verified descendants; ${9 - shownCount} not shown`));
  assert.ok(shownCount <= 8);
  assert.ok(bounded.length <= 6000, "the entire visible checkpoint message fits the character bound");
  const segments = bounded.split(/(?=<!-- cost-guard-checkpoint:)/).slice(1).filter((segment) => /<!-- cost-guard-checkpoint:[^ >]+ -->/.test(segment));
  for (const segment of segments) {
    assert.match(segment, /Get final user approval before any extension or restart\./);
    assert.match(segment, /cost_guard_extend\(\{tokens:10, sessionID:"bounded-child-/);
    assert.ok(segment.includes("Evaluation does not approve or unlock"), "each marker belongs to a complete checkpoint instruction");
  }
  const nativeBoundedOutput = { title: "bounded task", output: "result", metadata: {} };
  await boundedController.hooks["tool.execute.after"]({ tool: "task", sessionID: "native-root" }, nativeBoundedOutput);
  const firstRenderedOutput = nativeBoundedOutput.output;
  await boundedController.hooks["tool.execute.after"]({ tool: "task", sessionID: "native-root" }, nativeBoundedOutput);
  assert.equal(nativeBoundedOutput.output, firstRenderedOutput, "repeated native hook does not duplicate entries or count summary");
  const nativeShown = nativeBoundedOutput.output.match(/<!-- cost-guard-checkpoint:bounded-child-\d+ -->/g)?.length || 0;
  assert.match(nativeBoundedOutput.output, new RegExp(`showing ${nativeShown} of 9 over-budget verified descendants; ${9 - nativeShown} not shown`));
}

// SDK ancestry recovery starts at the child and follows every parent; lifetime use remains enforced after restart.
{
  const metadata = {
    "resumed-root": { id: "resumed-root", parentID: null, directory: process.cwd(), projectID: "project" },
    "resumed-child": { id: "resumed-child", parentID: "resumed-root", directory: process.cwd(), projectID: "project" },
  };
  const calls = [];
  const recovered = await CostGuard({ client: { ...client, session: {
    get: async ({ path: { id } }) => { calls.push(id); return { data: { ...metadata[id], projectID: "project" } }; },
    messages: async ({ path: { id } }) => ({ data: id === "resumed-child" ? [{ info: {
      role: "assistant", sessionID: id, id: "old-cap", cost: 0, tokens: { input: 200000, output: 40000, reasoning: 10000 },
    } }] : [] }),
  } }, directory: { worktree: process.cwd() } }, { persist: false, subagentTokenLimit: 250000, action: "block", onBlock: "ask" });
  await recovered.event(assistantEvent("resumed-child", "new-small", 0, { tokens: { input: 0, output: 0, reasoning: 0 } }));
  await assert.rejects(() => recovered["tool.execute.before"]({ tool: "bash", sessionID: "resumed-child" }), /active budget/);
  assert.ok(calls.includes("resumed-child") && calls.includes("resumed-root"), "SDK recovery validated each ancestry link");
  const controller = createCostGuardController(normalizeOptions({ persist: false, subagentTokenLimit: 250000, action: "block", onBlock: "ask" }), {
    ...client, session: { get: async ({ path: { id } }) => ({ data: { ...metadata[id], projectID: "project" } }) },
  }, process.cwd());
  assert.equal(await controller.extend("resumed-root", undefined, 250000, "session", "resumed-child"), 500000,
    "parent extension independently recovers and validates child ancestry");
}

// No-amount session extensions preserve USD default; token-only configuration adds the active token base.
{
  const metadata = {
    root: { id: "extend-root", parentID: null, directory: process.cwd(), projectID: "project" },
    child: { id: "extend-child", parentID: "extend-root", directory: process.cwd(), projectID: "project" },
  };
  const sdk = { ...client, session: { get: async ({ path: { id } }) => ({ data: metadata[id === "extend-root" ? "root" : "child"] }) } };
  const usdGuard = createCostGuardController(normalizeOptions({ persist: false, limit: 5, subagentTokenLimit: 250000, onBlock: "ask" }), sdk, process.cwd());
  assert.equal(await usdGuard.extend("extend-root", undefined, undefined, "session", "extend-child"), 250000);
  assert.deepEqual(usdGuard._ledger().approvals.at(-1).dimensions, [{ usd: 5 }]);
  const tokenGuard = createCostGuardController(normalizeOptions({ persist: false, usdEnabled: false, tokenLimit: 100000, subagentTokenLimit: 250000, onBlock: "ask" }), sdk, process.cwd());
  assert.equal(await tokenGuard.extend("extend-root", undefined, undefined, "session", "extend-child"), 200000);
  assert.deepEqual(tokenGuard._ledger().approvals.at(-1).dimensions, [{ tokens: 100000 }]);
  const wrongProjectSDK = { ...client, session: { get: async ({ path: { id } }) => ({
    data: { ...metadata[id === "extend-root" ? "root" : "child"], projectID: "project", parentID: id === "extend-root" ? null : "unverified-parent" },
  }) } };
  const wrongProject = createCostGuardController(normalizeOptions({ persist: false, subagentTokenLimit: 250000 }), wrongProjectSDK, process.cwd());
  await assert.rejects(() => wrongProject.extend("extend-root", undefined, 250000, "session", "extend-child"), /verified descendant/);
  assert.equal(wrongProject._ledger().approvals.length, 0, "cross-project project IDs are rejected without ingestion");
  const failedMetadata = createCostGuardController(normalizeOptions({ persist: false, subagentTokenLimit: 250000 }), {
    ...client, session: { get: async ({ path: { id } }) => id === "extend-root" ? { error: new Error("unavailable") } : ({ data: metadata.child }) },
  }, process.cwd());
  await assert.rejects(() => failedMetadata.extend("extend-root", undefined, 250000, "session", "extend-child"), /verified descendant/);
  const cycleSDK = { ...client, session: { get: async ({ path: { id } }) => ({ data: {
    id, directory: process.cwd(), projectID: "project", parentID: id === "extend-root" ? "extend-child" : "extend-root",
  } }) } };
  const cycle = createCostGuardController(normalizeOptions({ persist: false, subagentTokenLimit: 250000 }), cycleSDK, process.cwd());
  await assert.rejects(() => cycle.extend("extend-root", undefined, 250000, "session", "extend-child"), /verified descendant/);
  const missingParent = createCostGuardController(normalizeOptions({ persist: false, subagentTokenLimit: 250000 }), {
    ...client, session: { get: async ({ path: { id } }) => ({ data: id === "extend-root"
      ? { ...metadata.root, projectID: "project" } : { id, directory: process.cwd(), projectID: "project" } }) },
  }, process.cwd());
  await assert.rejects(() => missingParent.extend("extend-root", undefined, 250000, "session", "extend-child"), /verified descendant/);
  const usdDisabled = createCostGuardController(normalizeOptions({ persist: false, usdEnabled: false, subagentTokenLimit: 250000, onBlock: "ask" }), sdk, process.cwd());
  assert.equal(await usdDisabled.extend("extend-root", undefined, undefined, "session", "extend-child"), 500000);
  assert.deepEqual(usdDisabled._ledger().approvals.at(-1).dimensions, [{ tokens: 250000 }], "token-only mode defaults to one active child token base");
  const mixedGuard = createCostGuardController(normalizeOptions({ persist: false, usdEnabled: false, tokenLimit: 100000,
    subagentTokenLimit: 250000, action: "block", onBlock: "ask" }), sdk, process.cwd());
  await mixedGuard.hooks.event({ event: { type: "session.created", properties: { info: metadata.root } } });
  await mixedGuard.hooks.event({ event: { type: "session.created", properties: { info: metadata.child } } });
  await mixedGuard.hooks.event(assistantEvent("extend-child", "legacy-cap", 0, { tokens: { input: 150000, output: 0, reasoning: 0 } }));
  await assert.rejects(() => mixedGuard.hooks["tool.execute.before"]({ tool: "bash", sessionID: "extend-child" }), /active budget/);
  assert.equal(await mixedGuard.extend("extend-root", undefined, undefined, "session", "extend-child"), 200000);
  await mixedGuard.hooks["tool.execute.before"]({ tool: "bash", sessionID: "extend-child" });
}

// Verified child lifetime token checkpoint; roots and excluded sessions remain independent.
{
  const cfg = normalizeOptions({ subagentTokenLimit: 250000, action: "block", onBlock: "ask" });
  assert.equal(cfg.subagentTokenLimit, 250000);
  const key = await projectKey(process.cwd());
  const { hooks, extend, verifiedTaskNotice } = createCostGuardController(cfg, { ...client,
    session: { get: async ({ path: { id } }) => ({ data: { id, directory: process.cwd(), projectID: "project" } }) },
  }, process.cwd(), { projectKey: key, instanceID: "checkpoint-smoke" });
  await hooks.event({ event: { type: "session.created", properties: { info: { id: "root", parentID: null, directory: process.cwd() } } } });
  await hooks.event({ event: { type: "session.created", properties: { info: { id: "child", parentID: "root", directory: process.cwd() } } } });
  await hooks["chat.message"]({ sessionID: "child", agent: "excluded-child" });
  await hooks.event(assistantEvent("child", "at-cap", 0.01, { tokens: { input: 200000, output: 40000, reasoning: 10000, cache: { read: 900000, write: 1 } } }));
  await assert.rejects(() => hooks["tool.execute.before"]({ tool: "bash", sessionID: "child" }), /Ask the user:.*Evaluate stuck first.*Parent root root/);
  assert.match(await verifiedTaskNotice("root"), /\(1\) Evaluate stuck first.*\(2\) Continue only after approval.*\(3\) Stop/);
  assert.match(await verifiedTaskNotice("root"), /cache excluded/);
  assert.equal(await extend("root", undefined, 250000, "session", "child"), 500000);
  await hooks.event(assistantEvent("child", "at-extended-cap", 0.01, { tokens: { input: 400000, output: 80000, reasoning: 20000, cache: { read: 0, write: 0 } } }));
  await assert.rejects(() => hooks["tool.execute.before"]({ tool: "bash", sessionID: "child" }), /Parent root root/);
  await hooks.event({ event: { type: "session.created", properties: { info: { id: "unknown-child", parentID: "root" } } } });
  await assert.rejects(() => extend("root", undefined, 250000, "session", "unknown-child"), /verified descendant/);
  await assert.rejects(() => extend("root", undefined, 250000, "session", "mismatch-child"), /verified descendant/);
  await assert.rejects(() => extend("root", undefined, 250000, "run", "child"), /cross-session run extensions/);
  await hooks.event(assistantEvent("root", "root-over", 0.01, { tokens: { input: 300000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }));
  await hooks["tool.execute.before"]({ tool: "bash", sessionID: "root" });
}

// 2. warn action: warns at ratio, never blocks
{
  logs.length = 0;
  const cfg = normalizeOptions({ limit: 10, action: "warn", warnRatio: 0.5, agents: ["*"] });
  const h = createCostGuard(cfg, client);
  await h.event(assistantEvent("s1", "m1", 4)); // 40% -> no warn
  assert.equal(logs.length, 0);
  await h.event(assistantEvent("s1", "m1", 6)); // 60% -> warn
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, "warn");
  await h.event(assistantEvent("s1", "m2", 20)); // 26 USD -> over
  await h["tool.execute.before"]({ tool: "bash", sessionID: "s1" }); // must NOT throw in warn mode
}

// 3. block action: throws on tool call, caps output
{
  const cfg = normalizeOptions({ limit: 5, action: "block" });
  const h = createCostGuard(cfg, client);
  await h.event(assistantEvent("s2", "m1", 3)); // under
  await h["tool.execute.before"]({ tool: "bash", sessionID: "s2" }); // ok
  await h.event(assistantEvent("s2", "m2", 3)); // 6 USD -> over
  await assert.rejects(() => h["tool.execute.before"]({ tool: "bash", sessionID: "s2" }), /cost-guard/);
  const output = { maxOutputTokens: 4096 };
  await h["chat.params"]({ sessionID: "s2", agent: "build", model: {} }, output);
  assert.equal(output.maxOutputTokens, 1);
}

// 4. exclude: agent skipped
{
  const cfg = normalizeOptions({ limit: 1, action: "block", exclude: ["meta"] });
  const h = createCostGuard(cfg, client);
  await h.event(assistantEvent("s3", "m1", 100));
  await h["chat.message"]({ sessionID: "s3", agent: "meta" });
  await h["tool.execute.before"]({ tool: "bash", sessionID: "s3" }); // must NOT throw (excluded)
}

// 5. deleted session cleanup
{
  const cfg = normalizeOptions({ limit: 5 });
  const h = createCostGuard(cfg, client);
  await h.event(assistantEvent("s4", "m1", 10));
  await h.event({ event: { type: "session.deleted", properties: { info: { id: "s4" } } } });
  await h.event(assistantEvent("s4", "m1", 0)); // fresh map after delete
}

// 6. per-agent limits
{
  const cfg = normalizeOptions({ limit: { "fusion-ops": 0.5, "fusion-*": 8, "*": 10 }, action: "block" });
  assert.equal(cfg.limit, 10, "fallback limit");
  assert.equal(resolveLimit(cfg, "fusion-ops"), 0.5);
  assert.equal(resolveLimit(cfg, "fusion-planner"), 8);
  assert.equal(resolveLimit(cfg, "build"), 10);
  assert.equal(resolveLimit(cfg, undefined), 10);

  // ops blocked at 0.5
  const h = createCostGuard(cfg, client);
  await h["chat.message"]({ sessionID: "o", agent: "fusion-ops" });
  await h.event(assistantEvent("o", "m1", 0.6));
  await assert.rejects(() => h["tool.execute.before"]({ tool: "bash", sessionID: "o" }), /cost-guard/);

  // planner allowed until 8
  const h2 = createCostGuard(cfg, client);
  await h2["chat.message"]({ sessionID: "p", agent: "fusion-planner" });
  await h2.event(assistantEvent("p", "m1", 3));
  await h2["tool.execute.before"]({ tool: "bash", sessionID: "p" }); // ok
  await h2.event(assistantEvent("p", "m2", 5)); // 8 -> over
  await assert.rejects(() => h2["tool.execute.before"]({ tool: "bash", sessionID: "p" }), /cost-guard/);
}

// 7. ask mode: normal tools blocked, question/cost_guard_extend exempt, extend resumes
{
  const cfg = normalizeOptions({ limit: 1, action: "block", onBlock: "ask" });
  assert.equal(cfg.onBlock, "ask");
  const { hooks: h, extend } = createCostGuardController(cfg, client);
  await h["chat.message"]({ sessionID: "a", agent: "fusion-planner" });
  await h.event(assistantEvent("a", "m1", 2)); // over limit

  // output is NOT capped in ask mode (the agent must be able to ask)
  const output = { maxOutputTokens: 4096 };
  await h["chat.params"]({ sessionID: "a", agent: "fusion-planner", model: {} }, output);
  assert.equal(output.maxOutputTokens, 4096);

  // normal tool blocked with an ask-instruction
  await assert.rejects(() => h["tool.execute.before"]({ tool: "bash", sessionID: "a" }), /question/);
  // question + extend tool are exempt
  await h["tool.execute.before"]({ tool: "question", sessionID: "a" });
  await h["tool.execute.before"]({ tool: "cost_guard_extend", sessionID: "a" });

  // user approved -> extend, then work resumes
  assert.equal(await extend("a", 2), 3);
  await h["tool.execute.before"]({ tool: "bash", sessionID: "a" });
}

// 8. why-analysis: tokens aggregated, reason appears in the block message
{
  assert.equal(fmtNum(4000000), "4.0M");
  const line = explainCost({
    cost: 12,
    limit: 5,
    turnCount: 30,
    models: new Set(["p/m"]),
    first: 0,
    last: 600000,
    tokens: { input: 3000000, output: 100000, reasoning: 700000, cacheRead: 4000000, cacheWrite: 0 },
    agent: "fusion-planner",
  });
  assert.match(line, /large context/);
  assert.match(line, /many turns/);
  assert.match(line, /4\.0M cache-read/);

  const cfg = normalizeOptions({ limit: 1, action: "block", onBlock: "stop" });
  const h = createCostGuard(cfg, client);
  await h.event(
    assistantEvent("t", "m1", 2, {
      tokens: { input: 3000000, output: 1000, reasoning: 0, cache: { read: 4000000, write: 0 } },
      time: { created: 0 },
    }),
  );
  try {
    await h["tool.execute.before"]({ tool: "bash", sessionID: "t" });
    assert.fail("should have thrown");
  } catch (e) {
    assert.match(e.message, /why: large context/);
  }
}

console.log("smoke: all assertions passed");
