import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createStore } from '../accounting.js';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cost-guard-native-'));
const project = path.join(temporary, 'project');
await fs.mkdir(project);
spawnSync('git', ['init', '-q', project]);
const seen = [];
let step = 0, questionArgs;
const model = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  for (const message of body.messages || []) if (message.role === 'tool') {
    seen.push(String(message.content));
    const match = String(message.content).match(/with (\{"questions":.*\}), then retry/);
    if (match) questionArgs = JSON.parse(match[1]);
  }
  const main = body.tools?.some((tool) => tool.function?.name === "cost_guard_extend");
  if (main) step++;
  let tool, args;
  if (main && [1, 4, 6].includes(step)) { tool = 'cost_guard_extend'; args = { usd: 2, tokens: 100 }; }
  if (main && [2, 7].includes(step)) { tool = 'bash'; args = { command: 'node -e "require(\'fs\').writeFileSync(\'completed.txt\', \'done\')"', description: 'Write owned native fixture', timeout: 10000 }; }
  if (main && [3, 5].includes(step)) { tool = 'question'; args = questionArgs; }
  const delta = tool ? { tool_calls: [{ index: 0, id: `call_${step}`, type: 'function',
    function: { name: tool, arguments: JSON.stringify(args) } }] } : { content: 'Native approval integration complete' };
  const chunk = (choices) => ({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'mock', choices });
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write('data: ' + JSON.stringify(chunk([{ index: 0, delta, finish_reason: null }])) + '\n\n');
  response.write('data: ' + JSON.stringify({ ...chunk([{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }]),
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }) + '\n\n');
  response.end('data: [DONE]\n\n');
});
await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
const reserve = createServer();
await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const configDirectory = path.join(temporary, 'config', 'opencode');
await fs.mkdir(configDirectory, { recursive: true });
const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const stateDirectory = path.join(temporary, 'accounting');
const config = {
  plugin: [[pathToFileURL(process.env.COST_GUARD_PLUGIN_PATH || path.join(repository, 'index.js')).href,
    { action: 'block', onBlock: 'ask', tokenLimit: 1, persist: true, stateDirectory }]],
  model: 'cost_test/gpt-6.1', small_model: 'cost_test/gpt-6.1', default_agent: 'fusion-planner',
  autoupdate: false, lsp: false, formatter: false, permission: { '*': 'allow' },
  agent: { 'fusion-planner': { mode: 'primary', permission: { '*': 'allow' }, prompt: 'Run the deterministic native test sequence.' } },
  provider: { cost_test: { npm: '@ai-sdk/openai-compatible', name: 'Local cost test',
    options: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'local-test-only' },
    models: { 'gpt-6.1': { name: 'gpt-6.1', limit: { context: 128000, output: 8192 }, tool_call: true } } } },
};
await fs.writeFile(path.join(configDirectory, 'opencode.json'), JSON.stringify(config));
const budgetConfig = path.join(configDirectory, 'budget.json');
await fs.writeFile(budgetConfig, '{}');
const env = { ...process.env, XDG_CONFIG_HOME: path.dirname(configDirectory),
  XDG_DATA_HOME: path.join(temporary, 'data'), XDG_CACHE_HOME: path.join(temporary, 'cache'),
  XDG_STATE_HOME: path.join(temporary, 'state'), OPENCODE_CONFIG_DIR: configDirectory };
delete env.OPENCODE_CONFIG; delete env.OPENCODE_CONFIG_CONTENT;
env.OPENCODE_COST_GUARD_CONFIG = budgetConfig; delete env.OPENCODE_COST_GUARD_ACTION; delete env.OPENCODE_COST_GUARD_LIMIT;
const resolved = spawnSync('opencode', ['debug', 'config'], { cwd: project, env, encoding: 'utf8', timeout: 30000 });
assert.equal(resolved.status, 0, resolved.stderr.slice(-1000));
assert.equal(JSON.parse(resolved.stdout).plugin.length, 1, 'never load live user plugins');
const host = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port)],
  { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
let errors = ''; host.stderr.on('data', (chunk) => { errors += chunk; });
host.stdout.resume();
const baseURL = `http://127.0.0.1:${port}`;
const api = async (route, method = 'GET', body) => {
  const response = await fetch(baseURL + route + (route.includes('?') ? '&' : '?') + 'directory=' + encodeURIComponent(project), {
    method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  assert.ok(response.ok, `${method} ${route}: ${response.status} ${await response.clone().text()}`);
  return response.status === 204 ? null : response.json();
};
const deadline = Date.now() + 60000;
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
try {
  while (true) {
    try { await api('/global/health'); break; }
    catch (error) { if (Date.now() > deadline || host.exitCode != null) throw new Error(errors.slice(-1000) || error.message); await pause(); }
  }
  const session = await api('/session', 'POST', {});
  await api(`/session/${session.id}/prompt_async`, 'POST', { parts: [{ type: 'text', text: 'COST_GUARD_NATIVE_TEST' }], agent: 'fusion-planner' });
  let replies = 0;
  const replied = new Set();
  while (Date.now() < deadline) {
    const questions = await api('/question');
    for (const question of questions) {
      if (question.sessionID !== session.id || replied.has(question.id)) continue;
      assert.match(question.questions[0].question, /Approve budget extension/);
      const store = await createStore({ directory: stateDirectory, filename: 'cost-guard.json', projectDirectory: project });
      assert.equal((await store.load()).approvals.length, 0, 'no increase before explicit native reply');
      replied.add(question.id);
      await api(`/question/${question.id}/reply`, 'POST', { answers: [[replies++ === 0 ? 'Reject' : 'Approve']] });
    }
    if (step >= 8) break;
    await pause();
  }
  assert.ok(step >= 8, `native sequence stalled at step ${step}: ${errors.slice(-1000)}; tool results ${JSON.stringify(seen.slice(-3))}`);
  assert.equal(replies, 2, 'one declined, one approved native user question: ' + JSON.stringify(seen.slice(-4)));
  assert.ok(seen.some((text) => text.includes('cost-guard: active budget exceeded')), 'normal tool blocked before approval');
  assert.ok(seen.some((text) => text.includes('approved session budget extension recorded')), 'native approved extension consumed');
  assert.equal(await fs.readFile(path.join(project, 'completed.txt'), 'utf8'), 'done');
  const store = await createStore({ directory: stateDirectory, filename: 'cost-guard.json', projectDirectory: project });
  assert.equal((await store.load()).approvals.length, 1, 'only one extension persisted');
  console.log('Native OpenCode approval integration passed: blocked, declined, approved once, resumed; local mock only.');
} finally {
  host.kill('SIGTERM');
  if (host.exitCode == null) await new Promise((resolve) => host.once('close', resolve));
  await new Promise((resolve) => model.close(resolve));
  await fs.rm(temporary, { recursive: true, force: true });
}
