import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CostGuard } from '../index.js';
import { createCostGuardController, normalizeOptions } from '../lib.js';
import { aggregate, createStore, newLedger, recordMessage, canonicalRoot, recordSession } from '../accounting.js';
import { createApprovalGate } from '../approval.js';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cost-guard-regression-'));
test.after(() => fs.rm(temporary, { recursive: true, force: true }));
const metadata = (id) => ({ id, directory: temporary, projectID: 'audit', parentID: id === 'child' ? 'root' : null });
const client = { app: { log: async () => {} }, session: {
  get: async ({ path: { id } }) => ({ data: metadata(id) }), messages: async () => ({ data: [] }),
} };
const options = { persist: false, limit: 1, action: 'block', onBlock: 'ask', subagentTokenLimit: 10 };
const info = (sessionID, id, cost = 2) => ({ role: 'assistant', sessionID, id, cost,
  tokens: { input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});
const message = (sessionID, id, cost) => ({ event: { type: 'message.updated', properties: { info: info(sessionID, id, cost) } } });
const approved = async (guard, extension, answer = 'Approve') => {
  const question = await guard.requestExtension(...extension);
  await guard.hooks.event({ event: { type: 'question.asked', properties: { id: 'request', sessionID: extension[0], ...question } } });
  await guard.hooks.event({ event: { type: 'question.replied', properties: { requestID: 'request', sessionID: extension[0], answers: [[answer]] } } });
  return guard.extend(...extension);
};

test('root authority and native approval bind exact target, amount and scope once', async () => {
  const guard = createCostGuardController(normalizeOptions(options), client, temporary);
  await guard.hooks.event(message('child', 'first'));
  await assert.rejects(() => guard.extend('child', 10, 10), /verified parent root/);
  await assert.rejects(() => guard.extend('root', 10, 10, 'session', 'child'), /native user approval/);
  assert.equal(guard._ledger().approvals.length, 0);
  await assert.rejects(() => approved(guard, ['root', 10, 10, 'session', 'child'], 'Reject'), /native user approval/);
  const question = await guard.requestExtension('root', 10, 10, 'session', 'child');
  await guard.hooks.event({ event: { type: 'question.asked', properties: { id: 'approved', sessionID: 'root', ...question } } });
  await guard.hooks.event({ event: { type: 'question.replied', properties: { requestID: 'approved', sessionID: 'child', answers: [['Approve']] } } });
  await assert.rejects(() => guard.extend('root', 10, 10, 'session', 'child'), /native user approval/);
  await approved(guard, ['root', 10, 10, 'session', 'child']);
  await guard.hooks['tool.execute.before']({ sessionID: 'child', tool: 'bash' });
  await assert.rejects(() => guard.extend('root', 10, 10, 'session', 'child'), /native user approval/);
  await guard.hooks.event({ event: { type: 'question.replied', properties: { requestID: 'request', sessionID: 'root', answers: [['Approve']] } } });
  await assert.rejects(() => guard.extend('root', 10, 10, 'session', 'child'), /native user approval/);
  const pending = await guard.requestExtension('root', 1, 1);
  await guard.hooks['tool.execute.after']({ tool: 'question', sessionID: 'root', args: pending }, { metadata: { answers: [['Approve']] } });
  await assert.rejects(() => guard.extend('root', 2, 1), /native user approval/);
  await assert.rejects(() => guard.extend('root', 1, 1, 'run'), /budget is not active/);
  assert.equal(guard._ledger().approvals.length, 1);
});

test('approval expires, rejects cancellation and cannot cross targets', () => {
  let now = 0;
  const gate = createApprovalGate({ now: () => now });
  const plan = { callerSessionID: 'root', targetSessionID: 'child', usd: 1, tokens: 10, scope: 'session' };
  const question = gate.prepare(plan);
  gate.event({ type: 'question.asked', properties: { id: 'q', sessionID: 'root', ...question } });
  gate.event({ type: 'question.rejected', properties: { requestID: 'q', sessionID: 'root' } });
  assert.throws(() => gate.consume(plan), /native user approval/);
  gate.afterQuestion({ sessionID: 'root', args: gate.prepare(plan) }, { metadata: { answers: [['Approve']] } });
  assert.throws(() => gate.consume({ ...plan, targetSessionID: 'other' }), /native user approval/);
  now = 300000;
  assert.throws(() => gate.consume(plan), /native user approval/);
  const oldQuestion = gate.prepare(plan);
  gate.event({ type: 'question.asked', properties: { id: 'late-reply', sessionID: 'root', ...oldQuestion } });
  gate.afterQuestion({ sessionID: 'root', args: oldQuestion }, { metadata: { answers: [['Approve']] } });
  gate.consume(plan);
  const newQuestion = gate.prepare(plan);
  assert.notEqual(newQuestion.questions[0].question, oldQuestion.questions[0].question);
  gate.event({ type: 'question.replied', properties: { requestID: 'late-reply', sessionID: 'root', answers: [['Approve']] } });
  assert.throws(() => gate.consume(plan), /native user approval/, 'late event cannot approve a new identical intent');
});

test('actual extension tool asks before mutation; exact blocked-tool whitelist', async () => {
  const hooks = await CostGuard({ client, directory: temporary }, options);
  await hooks.event(message('root', 'over'));
  await assert.rejects(() => hooks['tool.execute.before']({ sessionID: 'root', tool: 'unrelated_cost_guard_exec' }), /cost-guard/);
  const text = await hooks.tool.cost_guard_extend.execute({ usd: 3 }, { sessionID: 'root' });
  assert.match(text, /no budget changed/);
  await assert.rejects(() => hooks['tool.execute.before']({ sessionID: 'root', tool: 'bash' }), /cost-guard/);
  const question = JSON.parse(text.match(/with (.*), then retry/)[1]);
  await hooks['tool.execute.after']({ tool: 'question', sessionID: 'root', args: question }, { metadata: { answers: [['Approve']] } });
  assert.match(await hooks.tool.cost_guard_extend.execute({ usd: 3 }, { sessionID: 'root' }), /extension recorded/);
  await hooks['tool.execute.before']({ sessionID: 'root', tool: 'bash' });
});

test('invalid settings and explicit malformed or missing files fail visibly', async () => {
  for (const setting of [{ action: 'blok' }, { tokenLimit: '500000' }, { subagentTokenLimit: -1 },
    { runTokenLimit: 1.5 }, { limit: { '*': '5' } }, { limit: 0 }, { agents: [] },
    { notify: 'false' }, { warnRatio: 2 }, { unexpected: true }]) {
    assert.throws(() => normalizeOptions(setting), /invalid configuration/);
  }
  assert.equal(normalizeOptions({ runLimit: null, runTokenLimit: null }).runLimit, null);
  const old = process.env.OPENCODE_COST_GUARD_CONFIG;
  try {
    process.env.OPENCODE_COST_GUARD_CONFIG = path.join(temporary, 'invalid.json');
    await fs.writeFile(process.env.OPENCODE_COST_GUARD_CONFIG, '{');
    await assert.rejects(() => CostGuard({ client, directory: temporary }), /cannot load configuration/);
    await fs.writeFile(process.env.OPENCODE_COST_GUARD_CONFIG, JSON.stringify({ limits: 0.01 }));
    const explicit = await CostGuard({ client, directory: temporary }, { ...options, limit: 100 });
    await explicit.event(message('root', 'alias', 1));
    await explicit['tool.execute.before']({ sessionID: 'root', tool: 'bash' });
    await fs.unlink(process.env.OPENCODE_COST_GUARD_CONFIG);
    await assert.rejects(() => CostGuard({ client, directory: temporary }), /cannot load configuration/);
  } finally {
    if (old === undefined) delete process.env.OPENCODE_COST_GUARD_CONFIG;
    else process.env.OPENCODE_COST_GUARD_CONFIG = old;
  }
});

test('recovery preserves 500-message pages, follows host cursor, retries incomplete coverage', async () => {
  const history = Array.from({ length: 500 }, (_, i) => ({ info: info('root', `old-${i}`, 0.001) }));
  const calls = [];
  const sdk = { ...client, session: { ...client.session, messages: async ({ query }) => {
    calls.push(query.before);
    return query.before ? { data: [{ info: info('root', 'oldest', 0.001) }], response: { headers: new Headers() } }
      : { data: history, response: { headers: new Headers({ 'x-next-cursor': 'opaque-cursor' }) } };
  } } };
  const guard = createCostGuardController(normalizeOptions({ ...options, subagentTokenLimit: null, limit: 1 }), sdk, temporary);
  await guard.hooks.event(message('root', 'new', 0.1));
  assert.equal(aggregate(guard._ledger(), ['root']).turns, 502);
  assert.ok(Math.abs(aggregate(guard._ledger(), ['root']).cost - 0.601) < 1e-8);
  assert.deepEqual(calls, [undefined, 'opaque-cursor']);
  await guard.hooks['tool.execute.before']({ sessionID: 'root', tool: 'bash' });
  const exactPage = createCostGuardController(normalizeOptions({ ...options, subagentTokenLimit: null }), {
    ...client, session: { ...client.session, messages: async () => ({ data: history, response: { headers: new Headers() } }) },
  }, temporary);
  await exactPage.hooks['tool.execute.before']({ sessionID: 'root', tool: 'bash' });
  assert.equal(aggregate(exactPage._ledger(), ['root']).turns, 500, 'native full final page is complete without a next cursor');
  let broken = true;
  const retry = createCostGuardController(normalizeOptions(options), { ...client, session: { ...client.session,
    messages: async () => broken ? { data: history } : { data: [] },
  } }, temporary);
  await retry.hooks.event(message('root', 'live', 0.1));
  assert.equal(aggregate(retry._ledger(), ['root']).turns, 501, 'known history retained without cursor');
  await assert.rejects(() => retry.hooks['tool.execute.before']({ sessionID: 'root', tool: 'bash' }), /history coverage incomplete/);
  broken = false;
  await retry.hooks['tool.execute.before']({ sessionID: 'root', tool: 'bash' });
  const repeated = createCostGuardController(normalizeOptions({ ...options, historyMaxPages: 2 }), {
    ...client, session: { ...client.session, messages: async () => ({ data: history,
      response: { headers: new Headers({ 'x-next-cursor': 'same' }) } }) },
  }, temporary);
  await assert.rejects(() => repeated.hooks['tool.execute.before']({ sessionID: 'root', tool: 'bash' }), /repeated history cursor/);
  const hung = createCostGuardController(normalizeOptions({ ...options, historyTimeoutMs: 10 }), {
    ...client, session: { ...client.session, messages: async () => new Promise(() => {}) },
  }, temporary);
  await assert.rejects(() => hung.hooks['tool.execute.before']({ sessionID: 'root', tool: 'bash' }), /host request timed out/);

});

test('controller recovers queue after disk repair, caches replay, observes other writers and revisions', async () => {
  const directory = path.join(temporary, 'state');
  const guard = createCostGuardController(normalizeOptions({ ...options, persist: true, stateDirectory: directory }), client, temporary);
  await guard.ready;
  const store = await guard._store();
  const broken = path.join(store.file, 'broken.event');
  await fs.writeFile(broken, '{');
  await assert.rejects(() => guard.refresh(), /invalid journal event/);
  await fs.unlink(broken);
  await guard.refresh();
  const writer = await createStore({ directory, filename: 'cost-guard.json', projectDirectory: temporary });
  const payload = newLedger(); recordMessage(payload, info('root', 'foreign', 0.1));
  await writer.append({ payload });
  await guard.refresh();
  assert.equal(aggregate(guard._ledger(), ['root']).cost, 0.1);
  const reads = store.stats().eventReads;
  await guard.refresh(); await guard.refresh();
  assert.equal(store.stats().eventReads, reads, 'unchanged event files are not reread');
  assert.throws(() => { guard._ledger().messages.extra = {}; }, /extensible|read only|readonly/);
  await guard.publishConfig(); await guard.publishConfig();
  assert.equal(guard._ledger().configs.length, 1, 'unchanged config lease is throttled');
  const mutable = newLedger();
  recordMessage(mutable, { ...info('root', 'same', 2), time: { updated: 1 } });
  assert.equal(aggregate(mutable, ['root']).cost, 2);
  recordMessage(mutable, { ...info('root', 'same', 0.1), time: { updated: 2 } });
  assert.equal(aggregate(mutable, ['root']).cost, 0.1, 'totals index invalidates on revision');
  recordSession(mutable, { id: 'root', parentID: null }, { metadataVerified: true, projectKey: 'foreign' });
  assert.equal(canonicalRoot(mutable, 'root', 'expected').reason, 'project-mismatch');
});

test('USD and token run limits each block first, while null leaves both unlimited', async () => {
  for (const limits of [{ runLimit: 0.1, runTokenLimit: 100 }, { runLimit: 100, runTokenLimit: 10 }]) {
    const guard = createCostGuardController(normalizeOptions({ ...options, limit: 100, subagentTokenLimit: null, ...limits }), client, temporary);
    await guard.hooks.event(message('root', 'one', 0.1));
    await assert.rejects(() => guard.hooks['tool.execute.before']({ sessionID: 'root', tool: 'bash' }), /cost-guard/);
  }
  const guard = createCostGuardController(normalizeOptions({ ...options, limit: 100, subagentTokenLimit: null,
    runLimit: null, runTokenLimit: null }), client, temporary);
  await guard.hooks.event(message('root', 'one', 0.1));
  await guard.hooks['tool.execute.before']({ sessionID: 'root', tool: 'bash' });
});
