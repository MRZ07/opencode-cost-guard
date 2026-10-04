import assert from "node:assert/strict";
import {
  createCostGuard,
  createCostGuardController,
  explainCost,
  fmtNum,
  normalizeOptions,
  resolveLimit,
} from "../lib.js";

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
  assert.equal(extend("a", 2), 3);
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
