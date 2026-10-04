import assert from "node:assert/strict";
import { createCostGuard, normalizeOptions } from "../index.js";

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

console.log("smoke: all assertions passed");
