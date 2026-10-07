import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizeOptions } from "../lib.js";
import { createCostGuardController } from "../lib.js";
import { effectiveBudgetLimits, newLedger, recordMessage, recordSession, canonicalAncestry } from "../accounting.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "cost-guard-init-"));
const script = fileURLToPath(new URL("../scripts/init-budget.mjs", import.meta.url));
const run = (args, env = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject);
  child.once("close", (code) => resolve({ code, stdout, stderr }));
});

try {
  const home = path.join(root, "home");
  await fs.mkdir(home);
  const printed = await run([], { HOME: home });
  assert.equal(printed.code, 0, printed.stderr);
  const preset = JSON.parse(printed.stdout);
  assert.deepEqual(preset, { action: "block", onBlock: "ask", tokenLimit: 500000, subagentTokenLimit: 250000 });
  await assert.rejects(() => fs.access(path.join(home, ".config")), { code: "ENOENT" }, "default invocation must not touch the filesystem");

  const defaultWrite = await run(["--write"], { HOME: home });
  assert.equal(defaultWrite.code, 0, defaultWrite.stderr);
  const defaultFile = path.join(home, ".config", "opencode", "cost-guard.json");
  assert.deepEqual(JSON.parse(await fs.readFile(defaultFile, "utf8")), preset);
  assert.equal((await fs.stat(defaultFile)).mode & 0o777, 0o600, "new config is owner-only");
  const defaultBefore = await fs.readFile(defaultFile);
  const repeat = await run(["--write"], { HOME: home });
  assert.notEqual(repeat.code, 0);
  assert.deepEqual(await fs.readFile(defaultFile), defaultBefore, "existing default config remains unchanged");

  const custom = path.join(root, "nested", "config.json");
  await fs.mkdir(path.dirname(custom));
  const customWrite = await run(["--write", "--config", custom, "--primary-tokens", "750000", "--subagent-tokens", "375000"]);
  assert.equal(customWrite.code, 0, customWrite.stderr);
  assert.deepEqual(JSON.parse(await fs.readFile(custom, "utf8")), {
    action: "block", onBlock: "ask", tokenLimit: 750000, subagentTokenLimit: 375000,
  });

  for (const [name, bytes] of [["malformed", "not json\n"], ["valid", "{\"private\":true}\n"]]) {
    const target = path.join(root, `${name}.json`);
    await fs.writeFile(target, bytes, { mode: 0o600 });
    const attempt = await run(["--write", "--config", target]);
    assert.notEqual(attempt.code, 0, `${name} destination must be refused`);
    assert.equal(await fs.readFile(target, "utf8"), bytes, `${name} destination stays byte-identical`);
  }

  const symlinkTarget = path.join(root, "symlink.json");
  const symlinkReal = path.join(root, "symlink-real.json");
  await fs.writeFile(symlinkReal, "preserve\n");
  await fs.symlink(symlinkReal, symlinkTarget);
  assert.notEqual((await run(["--write", "--config", symlinkTarget])).code, 0);
  assert.equal(await fs.readFile(symlinkReal, "utf8"), "preserve\n");

  const raceTarget = path.join(root, "race", "budget.json");
  await fs.mkdir(path.dirname(raceTarget));
  const racers = await Promise.all(Array.from({ length: 8 }, () => run(["--write", "--config", raceTarget])));
  assert.equal(racers.filter(({ code }) => code === 0).length, 1, "exactly one concurrent creator wins");
  assert.deepEqual(JSON.parse(await fs.readFile(raceTarget, "utf8")), preset);
  assert.deepEqual((await fs.readdir(path.dirname(raceTarget))).sort(), ["budget.json"], "no temp or partial files remain");

  const existingDirectory = path.join(root, "directory-target");
  await fs.mkdir(existingDirectory);
  assert.notEqual((await run(["--write", "--config", existingDirectory])).code, 0);
  assert.deepEqual(await fs.readdir(root).then((entries) => entries.filter((entry) => entry.includes(".tmp"))), []);

  for (const bad of ["0", "-1", "NaN", "1.5", "9007199254740992"]) {
    const rejected = await run(["--primary-tokens", bad]);
    assert.notEqual(rejected.code, 0, `invalid primary token value ${bad} must fail`);
  }
  assert.notEqual((await run(["--unknown"])).code, 0, "unknown flags fail closed");

  // The initializer preset flows through runtime normalization and enforces each lifetime boundary.
  const config = normalizeOptions({ ...preset, limit: Number.MAX_SAFE_INTEGER, persist: false });
  const client = { app: { log: async () => {} }, session: { get: async ({ path: { id } }) => ({ data: {
    id, directory: process.cwd(), projectID: "preset-project", parentID: id === "root" ? null : "root",
  } }) } };
  const guard = createCostGuardController(config, client, process.cwd());
  await guard.hooks.event({ event: { type: "session.created", properties: { info: { id: "root", parentID: null, directory: process.cwd(), projectID: "preset-project" } } } });
  await guard.hooks.event({ event: { type: "session.created", properties: { info: { id: "child", parentID: "root", directory: process.cwd(), projectID: "preset-project" } } } });
  const usage = (sessionID, id, input) => guard.hooks.event({ event: { type: "message.updated", properties: { info: {
    role: "assistant", sessionID, id, cost: 0, tokens: { input, output: 0, reasoning: 0, cache: { read: 900000, write: 0 } },
  } } } });
  await usage("root", "root-under", 499999);
  await guard.hooks["tool.execute.before"]({ tool: "bash", sessionID: "root" });
  await usage("root", "root-at", 1);
  await assert.rejects(() => guard.hooks["tool.execute.before"]({ tool: "bash", sessionID: "root" }), /active budget/);
  await usage("child", "child-under", 249999);
  await guard.hooks["tool.execute.before"]({ tool: "bash", sessionID: "child" });
  await usage("child", "child-at", 1);
  await assert.rejects(() => guard.hooks["tool.execute.before"]({ tool: "bash", sessionID: "child" }), /active budget/);
  assert.equal(config.action, "block");
  assert.equal(config.onBlock, "ask");

  const isolatedConfig = path.join(root, "loader-options.json");
  await fs.writeFile(isolatedConfig, JSON.stringify(preset));
  const previousHome = process.env.HOME;
  const previousConfig = process.env.OPENCODE_COST_GUARD_CONFIG;
  const previousLimit = process.env.OPENCODE_COST_GUARD_LIMIT;
  const previousAction = process.env.OPENCODE_COST_GUARD_ACTION;
  process.env.HOME = home;
  delete process.env.OPENCODE_COST_GUARD_CONFIG;
  delete process.env.OPENCODE_COST_GUARD_LIMIT;
  delete process.env.OPENCODE_COST_GUARD_ACTION;
  await fs.mkdir(path.join(home, ".config", "opencode"), { recursive: true });
  await fs.copyFile(isolatedConfig, path.join(home, ".config", "opencode", "cost-guard.json"));
  const { CostGuard } = await import(`../index.js?init-budget=${Date.now()}`);
  const initializedPlugin = await CostGuard({ client, directory: { worktree: process.cwd() } }, { limit: Number.MAX_SAFE_INTEGER, persist: false });
  await initializedPlugin.event({ event: { type: "session.created", properties: { info: { id: "loader-root", parentID: null, directory: process.cwd(), projectID: "loader-project" } } } });
  await initializedPlugin.event({ event: { type: "session.created", properties: { info: { id: "loader-child", parentID: "loader-root", directory: process.cwd(), projectID: "loader-project" } } } });
  await initializedPlugin.event({ event: { type: "message.updated", properties: { info: {
    role: "assistant", sessionID: "loader-child", id: "loader-cap", cost: 0,
    tokens: { input: 250000, output: 0, reasoning: 0, cache: { read: 900000, write: 0 } },
  } } } });
  await assert.rejects(() => initializedPlugin["tool.execute.before"]({ tool: "bash", sessionID: "loader-child" }), /active budget/,
    "the packaged initializer shape is consumed by the plugin file-options loader");
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (previousConfig === undefined) delete process.env.OPENCODE_COST_GUARD_CONFIG; else process.env.OPENCODE_COST_GUARD_CONFIG = previousConfig;
  if (previousLimit === undefined) delete process.env.OPENCODE_COST_GUARD_LIMIT; else process.env.OPENCODE_COST_GUARD_LIMIT = previousLimit;
  if (previousAction === undefined) delete process.env.OPENCODE_COST_GUARD_ACTION; else process.env.OPENCODE_COST_GUARD_ACTION = previousAction;

  const ledger = newLedger();
  recordSession(ledger, { id: "root", parentID: null }, { metadataVerified: true, projectKey: "preset-project" });
  recordSession(ledger, { id: "child", parentID: "root" }, { metadataVerified: true, projectKey: "preset-project" });
  recordMessage(ledger, { sessionID: "child", id: "cache-excluded", tokens: { input: 249999, output: 0, reasoning: 0, cache: { read: 900000, write: 0 } } });
  const ancestry = canonicalAncestry(ledger, "child");
  assert.equal(effectiveBudgetLimits(config, { agent: "build", sessionID: "child", rootID: "root", approvals: [], ancestry }).subagentEffectiveLimit, 250000);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("init-budget: all assertions passed");
