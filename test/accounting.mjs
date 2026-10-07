import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aggregate, createStore, newLedger, normalizeUsage, recordMessage, recordSession, mergeLedger, resolveActiveGuardConfig, globMatch, effectiveBudgetLimits, canonicalRoot, projectKey } from "../accounting.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createCostGuardController, normalizeOptions } from "../lib.js";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cost-guard-accounting-"));
try {
  const here = path.dirname(fileURLToPath(import.meta.url));
  assert.equal(await fs.readFile(path.join(here, "../accounting.js"), "utf8"),
    await fs.readFile(path.resolve(here, "../../opencode-run-stats/accounting.js"), "utf8"), "vendored accounting implementations stay identical");
  const ledger = newLedger();
  const event = (sessionID, id, cost = 0, tokens = {}) => ({ sessionID, id, cost, role: "assistant", tokens: {
    input: 100, output: 20, reasoning: 5, cache: { read: 50, write: 10 }, ...tokens,
  } });
  recordMessage(ledger, event("a", "m", 2));
  assert.equal(aggregate(ledger, ["a"]).totalTokens, 125);
  assert.equal(aggregate(ledger, ["a"]).cacheRead, 50);
  recordMessage(ledger, event("a", "m", 1));
  assert.equal(aggregate(ledger, ["a"]).cost, 1);
  recordMessage(ledger, { ...event("a", "unknown", 0), cost: null });
  assert.equal(normalizeUsage({ cost: 0 }).costKnown, true);
  assert.equal(aggregate(ledger, ["a"]).costAvailable, false);
  assert.equal(aggregate(ledger, ["a"]).costKnownLowerBound, 1, "known pricing subtotal survives unknown records");
  const incomplete = newLedger();
  recordMessage(incomplete, event("scope", "known", 1.2));
  recordMessage(incomplete, { ...event("scope", "unknown", 0), cost: null });
  assert.equal(aggregate(incomplete, ["scope"]).costKnownLowerBound, 1.2);
  assert.equal(aggregate(incomplete, ["scope"]).costAvailable, false);
  const revisions = newLedger();
  recordMessage(revisions, { ...event("revision", "m", 2), time: { updated: 30 } }, { receivedAt: 30 });
  recordMessage(revisions, { ...event("revision", "m", 1), time: { updated: 20 } }, { receivedAt: 40 });
  assert.equal(aggregate(revisions, ["revision"]).cost, 2, "comparable source revisions dominate receipt order");
  recordMessage(revisions, { ...event("revision", "m", 3), time: {} }, { receivedAt: 25 });
  assert.equal(aggregate(revisions, ["revision"]).cost, 1, "mixed version-kind groups use receipt order as a whole");
  const mixed = [
    [{ ...event("mixed", "m", 1), time: { updated: 100 } }, { receivedAt: 10, writerID: "a", eventID: "a" }],
    [{ ...event("mixed", "m", 2), revision: 200 }, { receivedAt: 10, writerID: "b", eventID: "b" }],
    [{ ...event("mixed", "m", 3), time: {} }, { receivedAt: 10, writerID: "c", eventID: "c" }],
  ];
  const outputs = [];
  for (const order of [[0, 1, 2], [2, 1, 0], [1, 0, 2], [1, 2, 0], [0, 2, 1], [2, 0, 1]]) {
    const candidates = newLedger();
    for (const index of order) recordMessage(candidates, mixed[index][0], mixed[index][1]);
    outputs.push(aggregate(candidates, ["mixed"]).cost);
  }
  assert.equal(new Set(outputs).size, 1, "three-way mixed revision candidates choose the same winner for every insertion order");
  const equalReceipt = newLedger();
  for (const [index, record] of mixed.entries()) recordMessage(equalReceipt, record[0], { ...record[1], receivedAt: 50, writerSeq: index });
  assert.equal(aggregate(equalReceipt, ["mixed"]).cost, 3, "equal receipts use writer-local sequence and stable IDs");
  const lateOlder = newLedger();
  recordMessage(lateOlder, { ...event("older", "m", 0.2), time: { updated: 20 } }, { receivedAt: 100, eventID: "newer-revision" });
  recordMessage(lateOlder, { ...event("older", "m", 0.9), time: { updated: 10 } }, { receivedAt: 200, eventID: "older-revision" });
  assert.equal(aggregate(lateOlder, ["older"]).cost, 0.2, "older trustworthy live revision cannot overwrite newer memory telemetry");
  assert.equal(globMatch("agent*mid?tail", "agent-x-midZtail"), true);
  assert.equal(globMatch("agent*mid?tail", "agent-x-midZZtail"), false);
  const tieCandidates = newLedger();
  recordMessage(tieCandidates, event("ties", "m", 0.1), { receivedAt: 20, writerID: "same", writerSeq: 1, eventID: "one" });
  recordMessage(tieCandidates, event("ties", "m", 0.2), { receivedAt: 20, writerID: "same", writerSeq: 2, eventID: "two" });
  assert.equal(aggregate(tieCandidates, ["ties"]).cost, 0.2, "equal receipt times use actual writer-local sequence before stable event ID");

  const ancestryLedger = newLedger();
  const projectKeyForTest = await projectKey(temp);
  recordSession(ancestryLedger, { id: "true-root", directory: temp, parentID: null }, { metadataVerified: true, projectKey: projectKeyForTest });
  recordSession(ancestryLedger, { id: "verified-child", directory: temp, parentID: "true-root" }, { metadataVerified: true, projectKey: projectKeyForTest });
  recordMessage(ancestryLedger, { ...event("verified-child", "at-cap", 0), tokens: { input: 200000, output: 40000, reasoning: 10000, cache: { read: 999999, write: 0 } } });
  const ancestry = canonicalRoot(ancestryLedger, "verified-child", projectKeyForTest);
  const childLimits = effectiveBudgetLimits({ tokenLimit: 100000, subagentTokenLimit: 250000, agents: ["*"], exclude: ["excluded-child"] },
    { agent: "excluded-child", sessionID: "verified-child", rootID: ancestry.id, approvals: [], ancestry });
  assert.equal(childLimits.effectiveSessionTokenLimit, 250000, "excluded agent retains the independent child limit");
  assert.equal(childLimits.subagentEffectiveLimit, 250000);
  const mixedLimits = effectiveBudgetLimits({ tokenLimit: 100000, subagentTokenLimit: 250000, agents: ["*"], exclude: [] },
    { agent: "included-child", sessionID: "verified-child", rootID: ancestry.id, approvals: [], ancestry });
  assert.equal(mixedLimits.effectiveSessionTokenLimit, 100000, "active legacy and child caps combine by minimum");
  assert.equal(aggregate(ancestryLedger, ["verified-child"]).totalTokens, 250000, "cache usage is excluded from the lifetime cap");
  assert.equal(canonicalRoot(ancestryLedger, "true-root", projectKeyForTest).isRoot, true);
  assert.equal(canonicalRoot(ancestryLedger, "unknown-child", projectKeyForTest).complete, false);
  const messageOnly = newLedger();
  recordMessage(messageOnly, { ...event("message-only", "m", 0), directory: temp });
  assert.equal(canonicalRoot(messageOnly, "message-only", projectKeyForTest).complete, false,
    "message directory alone cannot establish a verified synthetic root");
  recordSession(ancestryLedger, { id: "unverified-root", parentID: null }, { metadataVerified: false, projectKey: projectKeyForTest });
  recordSession(ancestryLedger, { id: "unverified-child", parentID: "unverified-root" }, { metadataVerified: true, projectKey: projectKeyForTest });
  assert.equal(canonicalRoot(ancestryLedger, "unverified-child", projectKeyForTest).reason, "unverified-session");

  recordSession(ledger, { id: "root", parentID: null });
  recordSession(ledger, { id: "child1", parentID: "root" });
  recordSession(ledger, { id: "child2", parentID: "root" });
  recordMessage(ledger, { ...event("child1", "spend", 0.6), tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } });
  recordMessage(ledger, { ...event("child2", "spend", 0.6), tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } });
  const client = { app: { log: async () => {} }, session: { get: async ({ path: { id } }) => ({ data: { id, directory: temp, projectID: "project" } }) } };
  const guard = createCostGuardController(normalizeOptions({ limit: 1, runLimit: 1, action: "block", persist: false, agents: ["*"], runLimit: 1 }), client, temp, { projectKey: await projectKey(temp), instanceID: "root-guard" });
  await guard.ready;
  await guard.hooks.event({ event: { type: "session.created", properties: { info: { id: "root", parentID: null, directory: temp } } } });
  for (const id of ["child1", "child2"]) await guard.hooks.event({ event: { type: "session.created", properties: { info: { id, parentID: "root", directory: temp } } } });
  await guard.hooks.event({ event: { type: "message.updated", properties: { info: { ...event("child1", "one", 0.6), time: { updated: 2 } } } } });
  await guard.hooks.event({ event: { type: "message.updated", properties: { info: { ...event("child2", "two", 0.6), time: { updated: 2 } } } } });
  await assert.rejects(() => guard.hooks["tool.execute.before"]({ tool: "bash", sessionID: "child2" }), /active budget/);

  const knownPlusUnknown = createCostGuardController(normalizeOptions({ limit: 1, action: "block", persist: false }), client);
  await knownPlusUnknown.ready;
  await knownPlusUnknown.hooks.event({ event: { type: "message.updated", properties: { info: { ...event("partial", "priced", 1.2) } } } });
  await knownPlusUnknown.hooks.event({ event: { type: "message.updated", properties: { info: { ...event("partial", "unpriced", 0), cost: null } } } });
  await assert.rejects(() => knownPlusUnknown.hooks["tool.execute.before"]({ tool: "bash", sessionID: "partial" }), /active budget/);
  const belowKnown = createCostGuardController(normalizeOptions({ limit: 1, action: "block", persist: false }), client);
  await belowKnown.ready;
  await belowKnown.hooks.event({ event: { type: "message.updated", properties: { info: { ...event("partial-low", "priced", 0.6) } } } });
  await belowKnown.hooks.event({ event: { type: "message.updated", properties: { info: { ...event("partial-low", "unpriced", 0), cost: null } } } });
  await belowKnown.hooks["tool.execute.before"]({ tool: "bash", sessionID: "partial-low" });
  assert.equal(aggregate(belowKnown._ledger(), ["partial-low"]).costKnownLowerBound, 0.6, "below-cap incomplete cost stays a lower bound, not a false block");

  const tokensOnly = createCostGuardController(normalizeOptions({ tokenLimit: 125, usdEnabled: false, action: "block", persist: false }), client);
  await tokensOnly.ready;
  await tokensOnly.hooks.event({ event: { type: "message.updated", properties: { info: { ...event("token", "m", undefined), cost: null } } } });
  await assert.rejects(() => tokensOnly.hooks["tool.execute.before"]({ tool: "bash", sessionID: "token" }), /active budget/);

  const revisable = createCostGuardController(normalizeOptions({ tokenLimit: 125, action: "block", persist: false }), client);
  await revisable.ready;
  const revised = { ...event("revise", "m", 0), time: { updated: 20 } };
  await revisable.hooks.event({ event: { type: "message.updated", properties: { info: revised } } });
  await assert.rejects(() => revisable.hooks["tool.execute.before"]({ tool: "bash", sessionID: "revise" }), /active budget/);
  await revisable.hooks.event({ event: { type: "message.updated", properties: { info: { ...revised, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, time: { updated: 21 } } } } });
  await revisable.hooks["tool.execute.before"]({ tool: "bash", sessionID: "revise" });

  const directory = path.join(temp, "state");
  const first = await createStore({ directory, filename: "test.json" });
  const second = await createStore({ directory, filename: "test.json" });
  const left = newLedger(), right = newLedger();
  recordMessage(left, event("a", "left", 0)); recordMessage(right, event("b", "right", 0));
  await Promise.all([first.merge(left), second.merge(right)]);
  const loaded = await first.load();
  assert.equal(Object.keys(loaded.messages).length, 2, "concurrent merges retain disjoint messages");
  await first.update((state) => { state.approvals.push({ id: "approval-a", sessionID: "a", dimensions: [{ usd: 1 }] }); return state; });
  await second.update((state) => { state.approvals.push({ id: "approval-b", sessionID: "b", dimensions: [{ tokens: 10 }] }); return state; });
  assert.equal((await first.load()).approvals.length, 2);
  const workerConfig = createCostGuardController(normalizeOptions({ limit: 2, runLimit: 1, limits: { "agent-a": 0.5 }, agents: ["*"], exclude: ["agent-b"], persist: true, stateDirectory: directory }), client,
    temp, { projectKey: await projectKey(temp), instanceID: "instance" });
  await workerConfig.ready;
  await workerConfig.publishConfig();
  assert.equal((await workerConfig._ledger()).configs.length, 1, "persistent guard publishes one active config lease");

  const killedJournal = await createStore({ directory, filename: "killed.json" });
  const modulePath = path.resolve(here, "../accounting.js");
  await Promise.all(Array.from({ length: 6 }, (_, i) => killedJournal.append({ payload: { version: 1, messages: {}, sessions: {}, approvals: [{ id: `approval-${i}`, eventID: `approval-${i}` }], configs: [] } })));
  assert.equal((await killedJournal.load()).approvals.length, 6, "writer death and concurrent immutable publications preserve all approvals");
  const temporary = path.join(killedJournal.file, ".orphaned.tmp");
  await fs.writeFile(temporary, "not an event");
  assert.equal((await killedJournal.load()).approvals.length, 6, "unfinished temporaries are ignored");
  for (const boundary of ["beforeRename", "afterRename"]) {
    const marker = path.join(temp, `${boundary}-${randomUUID()}.marker`);
    const filename = `killed-${boundary}-${randomUUID()}.json`;
    const childSource = `import {createStore} from ${JSON.stringify(`file://${modulePath}`)};const store=await createStore({directory:${JSON.stringify(directory)},filename:${JSON.stringify(filename)},publication:{${boundary}:async()=>{await (await import('node:fs/promises')).writeFile(${JSON.stringify(marker)},'${boundary}');await new Promise(()=>setInterval(()=>{},1000));}}});await store.append({eventID:'${boundary}-${randomUUID()}',payload:{version:1,messages:{},sessions:{},approvals:[{id:'${boundary}'}],configs:[]}});`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", childSource], { stdio: "ignore" });
    const exited = new Promise((resolve, reject) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", reject);
    });
    for (let attempt = 0; attempt < 200; attempt++) { try { await fs.access(marker); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); } }
    assert.equal(await fs.readFile(marker, "utf8"), boundary, `child acknowledged the ${boundary} publication boundary`);
    child.kill("SIGKILL");
    assert.deepEqual(await exited, { code: null, signal: "SIGKILL" }, `writer exited at ${boundary} checkpoint`);
    const result = await createStore({ directory, filename });
    assert.equal((await result.load()).approvals.length, boundary === "afterRename" ? 1 : 0, `kill ${boundary} boundary is atomic`);
  }
  const bounded = createCostGuardController(normalizeOptions({ persist: true, stateDirectory: directory }), client, temp, { projectKey: "bounded", instanceID: "bounded-writer" });
  await bounded.ready;
  for (let index = 0; index < 80; index++) await bounded.hooks.event({ event: { type: "message.updated", properties: { info: event("many", `m${index}`, 0.001) } } });
  const boundedStore = await bounded._store();
  const boundedFiles = (await fs.readdir(boundedStore.file)).filter((name) => name.endsWith(".event"));
  const eventBytes = await Promise.all(boundedFiles.map(async (name) => (await fs.stat(path.join(boundedStore.file, name))).size));
  assert.ok(eventBytes.reduce((sum, size) => sum + size, 0) < 80 * 3000, "journal publications grow linearly in event count, not cumulative ledger snapshots");
  const idempotent = newLedger();
  recordMessage(idempotent, event("dedupe", "same", 0.5), { eventID: "stable-candidate", receivedAt: 1 });
  const duplicate = newLedger();
  recordMessage(duplicate, event("dedupe", "same", 0.1), { eventID: "stable-candidate", receivedAt: 2 });
  assert.equal(aggregate(mergeLedger(idempotent, duplicate), ["dedupe"]).cost, 0.1, "stable event IDs select one deterministic duplicate publication");
  const versioned = newLedger(), unversioned = newLedger();
  recordMessage(versioned, { ...event("perm", "m", 1), time: { updated: 10 } }, { receivedAt: 40, writerID: "z", eventID: "v" });
  recordMessage(unversioned, event("perm", "m", 2), { receivedAt: 50, writerID: "a", eventID: "u" });
  assert.equal(aggregate(mergeLedger(versioned, unversioned), ["perm"]).cost, aggregate(mergeLedger(unversioned, versioned), ["perm"]).cost,
    "mixed revisions replay permutation-invariant by deterministic receipt order");
  assert.equal(aggregate(mergeLedger(versioned, unversioned), ["perm"]).cost, 2);
  const configBase = { schema: "opencode-cost-guard-budget-v1", sessionLimit: 1 };
  const configEntry = (fingerprint, id, eventID, publishedAt) => ({ fingerprint, instanceID: id, eventID, projectKey: "p", hostname: "host", pid: process.pid,
    generation: 1, publishedAt, config: configBase });
  assert.equal(resolveActiveGuardConfig({ configs: [configEntry("a", "a", "a", 100), configEntry("b", "b", "b", 100)] },
    { projectKey: "p", hostname: "host", now: 200, isAlive: () => true }).conflict, true);
  const globConfig = { sessionLimit: 1, runLimit: 2, usdEnabled: true, agents: ["agent*mid?tail"], exclude: ["agent*midXtail"] };
  assert.equal(effectiveBudgetLimits(globConfig, { agent: "agent-a-midZtail", sessionID: "child", rootID: "root", approvals: [] }).sessionUsdLimit, 1);
  assert.equal(effectiveBudgetLimits(globConfig, { agent: "agent-a-midXtail", sessionID: "child", rootID: "root", approvals: [] }).sessionUsdLimit, null);
  assert.equal(effectiveBudgetLimits(globConfig, { agent: "other", sessionID: "child", rootID: "root", approvals: [] }).runUsdLimit, 2,
    "excluded session selector does not suppress descendant root run cap");
  const projectA = await createStore({ directory, filename: "project-isolation.json", projectDirectory: temp });
  const secondProject = path.join(temp, "second-project"); await fs.mkdir(secondProject);
  const projectB = await createStore({ directory, filename: "project-isolation.json", projectDirectory: secondProject });
  assert.notEqual(projectA.file, projectB.file, "project context, not process cwd, owns ledger isolation");
  const badEvent = path.join(first.file, "bad.event");
  await fs.writeFile(badEvent, "{broken");
  await assert.rejects(() => first.load(), /invalid journal event/);

  const persistenceOff = createCostGuardController(normalizeOptions({ persist: false, stateDirectory: path.join(temp, "disabled"), limit: 1 }), client);
  await persistenceOff.ready;
  await persistenceOff.hooks.event({ event: { type: "message.updated", properties: { info: event("off", "m", 0.2) } } });
  await assert.rejects(() => fs.access(path.join(temp, "disabled")), { code: "ENOENT" });

  for (const persist of [false, true]) {
  const recoveryOnly = createCostGuardController(normalizeOptions({ persist, stateDirectory: directory, limit: 1, action: "block" }), {
      ...client, session: { messages: async () => ({ data: [{ info: event("recover-guard", "old", 1.2) }] }) },
    }, temp, { projectKey: `recover-${persist}`, instanceID: `recover-${persist}` });
    await recoveryOnly.ready;
    await recoveryOnly.hooks.event({ event: { type: "message.updated", properties: { info: event("recover-guard", "new", 0.1) } } });
    await assert.rejects(() => recoveryOnly.hooks["tool.execute.before"]({ tool: "bash", sessionID: "recover-guard" }), /active budget/,
      `recovery-only spend is enforced in persist=${persist} mode`);
  }

  let releaseHistory;
  const stalled = createCostGuardController(normalizeOptions({ persist: false, action: "block", limit: 1 }), {
    ...client, session: { messages: async () => ({ data: await new Promise((resolve) => { releaseHistory = resolve; }) }) },
  });
  const recoveryEvent = stalled.hooks.event({ event: { type: "message.updated", properties: { info: event("race", "m", 0.7) } } });
  for (let attempt = 0; attempt < 20 && !releaseHistory; attempt++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof releaseHistory, "function", "recovery request started before the concurrent live event");
  const concurrentEvent = stalled.hooks.event({ event: { type: "message.updated", properties: { info: event("race", "other", 0.4) } } });
  releaseHistory([{ info: event("race", "m", 0.1) }]);
  await Promise.all([recoveryEvent, concurrentEvent]);
  assert.equal(aggregate(stalled._ledger(), ["race"]).cost, 1.1, "recovery candidates remain available while live message keys merge");
} finally { await fs.rm(temp, { recursive: true, force: true }); }
console.log("accounting: assertions passed");
