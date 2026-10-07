/** Canonical dependency-free usage model and immutable event journal. Vendor byte-identical in run-stats. */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";

export const STATE_VERSION = 1;
export const JOURNAL_VERSION = 1;
export const MAX_STATE_BYTES = 8 * 1024 * 1024;
export const MAX_JOURNAL_RECORDS = 100_000;
export const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
export const CONFIG_LEASE_MS = 5 * 60_000;
const finite = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;

export function normalizeUsage(info = {}) {
  const t = info.tokens || {};
  const fields = [t.input, t.output, t.reasoning, t.cache?.read, t.cache?.write];
  const tokens = { input: finite(fields[0]) ? fields[0] : 0, output: finite(fields[1]) ? fields[1] : 0,
    reasoning: finite(fields[2]) ? fields[2] : 0, cacheRead: finite(fields[3]) ? fields[3] : 0,
    cacheWrite: finite(fields[4]) ? fields[4] : 0 };
  return { cost: finite(info.cost) ? info.cost : 0, costKnown: finite(info.cost), tokens,
    tokensComplete: fields.every(finite), budgetTokens: tokens.input + tokens.output + tokens.reasoning };
}
export function newLedger() { return { version: STATE_VERSION, messages: {}, sessions: {}, approvals: [], configs: [] }; }
export function messageKey(sessionID, id) { return `${encodeURIComponent(sessionID)}:${encodeURIComponent(id)}`; }
const versionValue = (record) => record.updatedAt ?? record.revision ?? null;
const sourceRank = (record) => record.recovered ? 0 : 1;
const receiptOrder = (a, b) => ((a.receivedAt ?? a.timestamp ?? 0) - (b.receivedAt ?? b.timestamp ?? 0)) ||
  String(a.writerID || "").localeCompare(String(b.writerID || "")) || ((a.writerSeq ?? 0) - (b.writerSeq ?? 0)) || String(a.eventID || "").localeCompare(String(b.eventID || ""));
const candidatesOf = (record) => record ? record.candidates || [record] : [];
const uniqueCandidates = (records) => {
  const byID = new Map();
  for (const record of records.flatMap(candidatesOf)) {
    const id = record.eventID || JSON.stringify(record);
    const prior = byID.get(id);
    if (!prior || JSON.stringify(record) < JSON.stringify(prior)) byID.set(id, record);
  }
  return [...byID.values()];
};
const winner = (records) => {
  const candidates = uniqueCandidates(records);
  const live = candidates.filter((record) => sourceRank(record) === 1);
  const eligible = live.length ? live : candidates;
  const kinds = new Set(eligible.map((record) => record.versionKind));
  const comparable = eligible.every((record) => versionValue(record) != null) && kinds.size === 1 && !kinds.has(null);
  const selected = [...eligible].sort((a, b) => {
    if (comparable && versionValue(a) !== versionValue(b)) return versionValue(a) < versionValue(b) ? -1 : 1;
    return receiptOrder(a, b);
  }).at(-1);
  return { ...selected, candidates };
};
export function recordMessage(ledger, info, { recovered = false, receivedAt = Date.now(), writerID = "local", writerSeq, eventID = randomUUID() } = {}) {
  if (!info || typeof info.sessionID !== "string" || !info.sessionID || typeof info.id !== "string" || !info.id) return false;
  writerSeq ??= Math.max(0, ...Object.values(ledger.messages).flatMap(candidatesOf).filter((record) => record.writerID === writerID).map((record) => record.writerSeq || 0)) + 1;
  const record = { sessionID: info.sessionID, id: info.id, usage: normalizeUsage(info), mode: typeof info.mode === "string" ? info.mode : null,
    model: info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : null,
    createdAt: Number.isFinite(info.time?.created) ? info.time.created : null,
    updatedAt: Number.isFinite(info.time?.updated) ? info.time.updated : null,
    revision: Number.isFinite(info.revision) ? info.revision : null,
    versionKind: Number.isFinite(info.time?.updated) ? "updated" : Number.isFinite(info.revision) ? "revision" : null,
     receivedAt, writerID, writerSeq, eventID, recovered };
  return mergeRecord(ledger, record);
}
export function mergeRecord(target, incoming) {
  const key = messageKey(incoming.sessionID, incoming.id);
  const prior = target.messages[key];
  target.messages[key] = winner([...(prior ? [prior] : []), incoming]);
  return target.messages[key].eventID === incoming.eventID;
}
export function recordSession(ledger, info, event = {}) {
  if (!info || typeof info.id !== "string" || !info.id) return;
  const prior = ledger.sessions[info.id] || { parentID: null, startAt: null, metadata: {} };
  const timestamp = Number.isFinite(info.time?.updated) ? info.time.updated : Number.isFinite(info.time?.created) ? info.time.created : event.receivedAt ?? Date.now();
  const fields = {};
  if (Object.hasOwn(info, "parentID")) fields.parentID = info.parentID;
  if (Number.isFinite(info.time?.created)) fields.startAt = info.time.created;
  for (const field of ["projectID", "directory"]) if (Object.hasOwn(info, field) && typeof info[field] === "string") fields[field] = info[field];
  const candidates = uniqueCandidates([...(prior.candidates || []),
    { fields, timestamp, receivedAt: event.receivedAt ?? Date.now(), publishedAt: event.publishedAt ?? Date.now(), updatedAt: Number.isFinite(info.time?.updated) ? info.time.updated : null,
      revision: Number.isFinite(info.revision) ? info.revision : null,
      versionKind: Number.isFinite(info.time?.updated) ? "updated" : Number.isFinite(info.revision) ? "revision" : null,
      writerID: event.writerID || "local", writerSeq: event.writerSeq || 0, eventID: event.eventID || randomUUID() }]);
  ledger.sessions[info.id] = { ...prior, metadata: { ...prior.metadata }, candidates };
  for (const field of new Set(candidates.flatMap((candidate) => Object.keys(candidate.fields || {})))) {
    const selected = winner(candidates.filter((candidate) => Object.hasOwn(candidate.fields || {}, field)));
    if (selected) ledger.sessions[info.id][field] = selected.fields[field];
  }
  ledger.sessions[info.id].candidates = candidates;
}
export function tombstoneSession(ledger, id, event = {}) {
  if (typeof id !== "string" || !id) return;
  (ledger.tombstones ||= []).push({ id, timestamp: event.timestamp ?? Date.now(), writerID: event.writerID || "local", eventID: event.eventID || randomUUID() });
}
export function addApproval(ledger, approval) {
  if (approval && typeof approval.id === "string" && approval.id && !ledger.approvals.some((item) => item.id === approval.id)) ledger.approvals.push(approval);
}
export function addConfig(ledger, config) {
  if (config && typeof config.eventID === "string" && !ledger.configs.some((item) => item.eventID === config.eventID)) ledger.configs.push(config);
}
export function hasChanges(delta) {
  return Object.keys(delta.messages || {}).length > 0 || Object.keys(delta.sessions || {}).length > 0 ||
    (delta.approvals || []).length > 0 || (delta.configs || []).length > 0 || (delta.tombstones || []).length > 0 || delta.budget != null;
}
export function normalizeLedger(input) {
  const ledger = newLedger();
  if (!input) return ledger;
  if (input.version !== STATE_VERSION) throw new Error("accounting state has an unsupported schema");
  const groups = new Map();
  for (const record of Object.values(input.messages || {})) {
    const key = messageKey(record.sessionID, record.id);
    const list = groups.get(key) || []; list.push(...candidatesOf(record)); groups.set(key, list);
  }
  for (const [key, records] of groups) ledger.messages[key] = winner(records);
  for (const [id, old] of Object.entries(input.sessions || {})) {
    const candidates = old.candidates || [{ fields: { parentID: old.parentID, startAt: old.startAt }, timestamp: old.timestamp ?? 0, writerID: old.writerID || "legacy", eventID: old.eventID || `legacy:${id}` }];
    const fields = {};
    const fieldNames = [...new Set(candidates.flatMap((candidate) => Object.keys(candidate.fields || {})))];
    for (const name of fieldNames) {
      const selected = winner(candidates.filter((candidate) => Object.hasOwn(candidate.fields || {}, name)));
      if (selected) fields[name] = selected.fields[name];
    }
    const unique = uniqueCandidates(candidates), resolved = {};
    for (const field of new Set(unique.flatMap((candidate) => Object.keys(candidate.fields || {})))) {
      const selected = winner(unique.filter((candidate) => Object.hasOwn(candidate.fields || {}, field)));
      if (selected) resolved[field] = selected.fields[field];
    }
    ledger.sessions[id] = { parentID: null, startAt: null, metadata: {}, ...resolved, candidates: unique.sort(receiptOrder) };
  }
  ledger.approvals = [...(input.approvals || [])];
  ledger.configs = [...(input.configs || [])];
  ledger.tombstones = [...(input.tombstones || [])];
  ledger.budget = input.budget || null;
  return ledger;
}
export function mergeLedger(...sources) {
  const ledger = newLedger(), msgs = new Map(), sessions = {}, approvals = new Map(), configs = new Map(), tombstones = new Map();
  for (const source of sources) {
    if (!source) continue;
    for (const record of Object.values(source.messages || {})) { const key = messageKey(record.sessionID, record.id); (msgs.get(key) || msgs.set(key, []).get(key)).push(record); }
    for (const [id, data] of Object.entries(source.sessions || {})) {
      sessions[id] ||= { candidates: [] };
      sessions[id].candidates.push(...(data.candidates || [{ fields: { parentID: data.parentID, startAt: data.startAt }, timestamp: 0, writerID: "legacy", eventID: `legacy:${id}` }]));
    }
    for (const item of source.approvals || []) approvals.set(item.eventID || item.id, item);
    for (const item of source.configs || []) configs.set(item.eventID, item);
    for (const item of source.tombstones || []) tombstones.set(item.eventID, item);
  }
  for (const [key, records] of msgs) ledger.messages[key] = winner(records);
  for (const [id, data] of Object.entries(sessions)) {
    const fields = {};
    const names = [...new Set(data.candidates.flatMap((candidate) => Object.keys(candidate.fields || {})))];
    for (const name of names) {
      const selected = winner(data.candidates.filter((candidate) => Object.hasOwn(candidate.fields || {}, name)));
      if (selected) fields[name] = selected.fields[name];
    }
    const candidates = uniqueCandidates(data.candidates), resolved = {};
    for (const field of new Set(candidates.flatMap((candidate) => Object.keys(candidate.fields || {})))) {
      const selected = winner(candidates.filter((candidate) => Object.hasOwn(candidate.fields || {}, field)));
      if (selected) resolved[field] = selected.fields[field];
    }
    ledger.sessions[id] = { parentID: null, startAt: null, metadata: {}, ...resolved, candidates: candidates.sort(receiptOrder) };
  }
  ledger.approvals = [...approvals.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  ledger.configs = [...configs.values()].sort((a, b) => a.eventID.localeCompare(b.eventID));
  ledger.tombstones = [...tombstones.values()].sort((a, b) => a.eventID.localeCompare(b.eventID));
  for (const record of Object.values(ledger.messages)) if (Number.isFinite(record.createdAt)) {
    const session = ledger.sessions[record.sessionID] ||= { parentID: null, startAt: null, metadata: {}, candidates: [] };
    session.startAt = session.startAt == null ? record.createdAt : Math.min(session.startAt, record.createdAt);
  }
  return ledger;
}
export function deltaLedger(before, after) {
  const delta = newLedger();
  for (const [key, value] of Object.entries(after.messages || {})) {
    const seen = new Set(candidatesOf(before.messages?.[key]).map((candidate) => candidate.eventID));
    const additions = candidatesOf(value).filter((candidate) => !seen.has(candidate.eventID));
    if (additions.length) delta.messages[key] = { ...winner(additions), candidates: additions };
  }
  for (const [id, session] of Object.entries(after.sessions || {})) {
    const previous = before.sessions?.[id];
    const priorEvents = new Set((previous?.candidates || []).map((candidate) => candidate.eventID));
    const additions = (session.candidates || []).filter((candidate) => !priorEvents.has(candidate.eventID));
    if (additions.length) delta.sessions[id] = { parentID: null, startAt: null, metadata: {}, candidates: additions };
    else if (!previous && !session.candidates?.length) delta.sessions[id] = session;
  }
  delta.approvals = (after.approvals || []).filter((item) => !(before.approvals || []).some((prior) => (prior.eventID || prior.id) === (item.eventID || item.id)));
  delta.configs = (after.configs || []).filter((item) => !(before.configs || []).some((prior) => prior.eventID === item.eventID));
  delta.tombstones = (after.tombstones || []).filter((item) => !(before.tombstones || []).some((prior) => prior.eventID === item.eventID));
  if (JSON.stringify(before.budget) !== JSON.stringify(after.budget)) delta.budget = after.budget;
  return delta;
}
export function aggregate(ledger, sessionIDs) {
  const ids = new Set(sessionIDs), out = { cost: 0, costKnownLowerBound: 0, costAvailable: true, tokensComplete: true, input: 0, output: 0, reasoning: 0,
    cacheRead: 0, cacheWrite: 0, totalTokens: 0, turns: 0, first: null, last: null, models: new Set() };
  const normalized = normalizeLedger(ledger);
  for (const record of Object.values(normalized.messages)) if (ids.has(record.sessionID)) {
    out.turns++; out.costAvailable &&= record.usage.costKnown; if (record.usage.costKnown) out.cost += record.usage.cost;
    out.tokensComplete &&= record.usage.tokensComplete; out.input += record.usage.tokens.input; out.output += record.usage.tokens.output;
    out.reasoning += record.usage.tokens.reasoning; out.cacheRead += record.usage.tokens.cacheRead; out.cacheWrite += record.usage.tokens.cacheWrite;
    out.totalTokens += record.usage.budgetTokens;
    if (record.createdAt != null) { out.first = out.first == null ? record.createdAt : Math.min(out.first, record.createdAt); out.last = out.last == null ? record.createdAt : Math.max(out.last, record.createdAt); }
    if (record.model) out.models.add(record.model);
  }
  out.costKnownLowerBound = out.cost; return out;
}
export function descendants(ledger, root) {
  const value = normalizeLedger(ledger), result = [], seen = new Set(), stack = [root];
  while (stack.length) { const id = stack.pop(); if (seen.has(id)) continue; seen.add(id); result.push(id);
    for (const [child, session] of Object.entries(value.sessions)) if (session.parentID === id && !seen.has(child)) stack.push(child); }
  return result;
}
export function canonicalRoot(ledger, id) {
  const value = normalizeLedger(ledger), seen = new Set(); let current = id;
  while (value.sessions[current]?.parentID) { if (seen.has(current)) return { id: current, complete: false }; seen.add(current); current = value.sessions[current].parentID; }
  return { id: current, complete: !seen.has(current) };
}
export function resolveActiveGuardConfig(ledger, { projectKey, hostname = os.hostname(), now = Date.now(), isAlive } = {}) {
  const alive = isAlive || ((pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } });
    const active = (ledger.configs || []).filter((config) => config.projectKey === projectKey && config.hostname === hostname &&
    now - (config.publishedAt ?? config.timestamp) <= CONFIG_LEASE_MS && now >= (config.publishedAt ?? config.timestamp) && alive(config.pid));
  if (!active.length) return { available: false, conflict: false };
  const latestByInstance = new Map();
  for (const config of active) {
    const prior = latestByInstance.get(config.instanceID);
    if (!prior || config.generation > prior.generation || (config.generation === prior.generation && config.eventID > prior.eventID)) latestByInstance.set(config.instanceID, config);
  }
  const fingerprints = new Set([...latestByInstance.values()].map((record) => record.fingerprint));
  if (fingerprints.size !== 1) return { available: false, conflict: true };
  return { available: true, conflict: false, config: [...latestByInstance.values()].sort((a, b) => a.instanceID.localeCompare(b.instanceID))[0].config,
    activeInstances: [...latestByInstance.values()] };
}
export function effectiveBudgetLimits(config, { agent, sessionID, rootID, approvals = [] }) {
  const matches = (pattern) => agent == null ? pattern === "*" : globMatch(pattern, agent);
  const resolve = (fallback, perAgent) => { for (const [pattern, value] of perAgent || []) if (matches(pattern)) return value; return fallback; };
  const applies = !(config.exclude || []).some(matches) && (!(config.agents || []).length || (config.agents || []).some(matches));
  const extra = (scope, id, key) => approvals.filter((item) => item.scope === scope && item.sessionID === id)
    .flatMap((item) => item.dimensions || []).reduce((sum, dimension) => sum + (dimension[key] || 0), 0);
  const usd = config.usdEnabled === false || !applies ? null : resolve(config.sessionLimit, config.limits);
  const tokens = !applies || !Number.isFinite(config.tokenLimit) ? null : config.tokenLimit;
  const sessionExtensionUsd = extra("session", sessionID, "usd"), sessionExtensionTokens = extra("session", sessionID, "tokens");
  const runExtensionUsd = extra("run", rootID, "usd"), runExtensionTokens = extra("run", rootID, "tokens");
  return { applies, excluded: (config.exclude || []).some(matches), sessionExtensionUsd, sessionExtensionTokens, runExtensionUsd, runExtensionTokens,
    sessionUsdLimit: usd == null ? null : usd + sessionExtensionUsd,
    sessionTokenLimit: tokens == null ? null : tokens + sessionExtensionTokens,
    runUsdLimit: config.usdEnabled === false || !Number.isFinite(config.runLimit) ? null : config.runLimit + runExtensionUsd,
    runTokenLimit: !Number.isFinite(config.runTokenLimit) ? null : config.runTokenLimit + runExtensionTokens };
}
export function globMatch(pattern, value) {
  if (typeof pattern !== "string" || typeof value !== "string") return false;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(value);
}
export async function projectKey(projectDirectory = process.cwd()) {
  try { return createHash("sha256").update(await fs.realpath(projectDirectory)).digest("hex").slice(0, 24); }
  catch (error) { throw new Error(`cannot resolve OpenCode project directory ${projectDirectory}: ${error.message}`, { cause: error }); }
}
export async function defaultStateDirectory(projectDirectory = process.cwd()) {
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "opencode-accounting", await projectKey(projectDirectory));
}
async function ensureDirectory(directory) { await fs.mkdir(directory, { recursive: true, mode: 0o700 }); await fs.chmod(directory, 0o700); }
function serializeRecord(record) { const text = JSON.stringify(record); if (Buffer.byteLength(text) > MAX_STATE_BYTES) throw new Error("accounting journal event exceeds 8 MiB"); return text; }
export async function createStore({ directory, filename, projectDirectory = process.cwd(), persist = true, publication = {} }) {
  const project = await projectKey(projectDirectory), base = directory || await defaultStateDirectory(projectDirectory);
  const journalDir = path.join(base, `${project}-${filename}.journal`);
  const legacyFile = path.join(base, `${project}-${filename}`);
  if (persist) await ensureDirectory(journalDir);
  const read = async () => {
    if (!persist) return newLedger();
    const names = await fs.readdir(journalDir).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
    const events = names.filter((name) => name.endsWith(".event")).sort();
    if (events.length > MAX_JOURNAL_RECORDS) throw new Error(`accounting journal exceeds ${MAX_JOURNAL_RECORDS} events; usage is incomplete`);
    let bytes = 0; const ledgers = [];
    try {
      const legacyStat = await fs.stat(legacyFile);
      if (legacyStat.size > MAX_STATE_BYTES) throw new Error("legacy accounting snapshot exceeds 8 MiB");
      ledgers.push(normalizeLedger(JSON.parse(await fs.readFile(legacyFile, "utf8"))));
    } catch (error) { if (error.code !== "ENOENT") throw new Error(`cannot import legacy snapshot ${legacyFile}: ${error.message}`, { cause: error }); }
    for (const name of events) {
      const file = path.join(journalDir, name), stat = await fs.stat(file); bytes += stat.size;
      if (bytes > MAX_JOURNAL_BYTES) throw new Error(`accounting journal exceeds ${MAX_JOURNAL_BYTES} bytes; usage is incomplete`);
      let event; try { event = JSON.parse(await fs.readFile(file, "utf8")); } catch (error) { throw new Error(`invalid journal event ${name}: ${error.message}`, { cause: error }); }
      if (event.version !== JOURNAL_VERSION || !event.payload || typeof event.eventID !== "string") throw new Error(`invalid journal event schema: ${name}`);
      ledgers.push(event.payload);
    }
    return mergeLedger(...ledgers);
  };
  return {
    file: journalDir, load: read, replaceFromDisk: read,
    async append(event) {
      if (!persist) return;
      const eventID = event.eventID || randomUUID(), name = `${eventID}-${randomUUID()}.event`, final = path.join(journalDir, name);
      const temporary = path.join(journalDir, `.${eventID}.${process.pid}.${randomUUID()}.tmp`), content = serializeRecord({ version: JOURNAL_VERSION, eventID, payload: event.payload });
       try { await fs.writeFile(temporary, content, { mode: 0o600, flag: "wx" }); await publication.beforeRename?.({ temporary, final }); await fs.rename(temporary, final); await publication.afterRename?.({ final }); }
      catch (error) { await fs.unlink(temporary).catch(() => {}); if (error.code !== "EEXIST") throw error; }
    },
    async update(mutation) {
      if (!persist) return newLedger();
      if (typeof mutation !== "function") { await this.append(mutation); return read(); }
       const before = await read();
       const draft = mergeLedger(before);
       await mutation(draft);
       for (const session of Object.values(draft.sessions)) delete session.title;
       const delta = deltaLedger(before, draft);
       if (hasChanges(delta)) await this.append({ payload: delta });
       return read();
     },
    async merge(local) { if (!persist) return local; const before = await read(); const after = mergeLedger(before, normalizeLedger(local)); const delta = deltaLedger(before, after); if (hasChanges(delta)) await this.append({ payload: delta }); return read(); },
  };
}
export async function readStore(options) {
  if (options.persist === false) return null;
  const project = await projectKey(options.projectDirectory || process.cwd());
  const base = options.directory || await defaultStateDirectory(options.projectDirectory || process.cwd());
  const journalDir = path.join(base, `${project}-${options.filename}.journal`);
  const legacyFile = path.join(base, `${project}-${options.filename}`);
  const ledgers = [];
  try {
    const stat = await fs.stat(legacyFile);
    if (stat.size > MAX_STATE_BYTES) throw new Error("legacy accounting snapshot exceeds 8 MiB");
    ledgers.push(normalizeLedger(JSON.parse(await fs.readFile(legacyFile, "utf8"))));
  } catch (error) { if (error.code !== "ENOENT") throw new Error(`cannot read legacy snapshot ${legacyFile}: ${error.message}`, { cause: error }); }
  const names = await fs.readdir(journalDir).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
  const events = names.filter((name) => name.endsWith(".event")).sort();
  if (events.length > MAX_JOURNAL_RECORDS) throw new Error(`accounting journal exceeds ${MAX_JOURNAL_RECORDS} events; usage is incomplete`);
  let bytes = 0;
  for (const name of events) {
    const file = path.join(journalDir, name), stat = await fs.stat(file); bytes += stat.size;
    if (bytes > MAX_JOURNAL_BYTES) throw new Error(`accounting journal exceeds ${MAX_JOURNAL_BYTES} bytes; usage is incomplete`);
    try {
      const event = JSON.parse(await fs.readFile(file, "utf8"));
      if (event.version !== JOURNAL_VERSION || !event.payload || typeof event.eventID !== "string") throw new Error("unsupported event schema");
      ledgers.push(event.payload);
    } catch (error) { throw new Error(`invalid journal event ${name}: ${error.message}`, { cause: error }); }
  }
  return mergeLedger(...ledgers);
}
