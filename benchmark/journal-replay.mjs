import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { aggregate, createStore, newLedger, recordMessage } from "../accounting.js";

const allowedSizes = [100, 1000, 5000];
const requested = process.argv.find((arg) => arg.startsWith("--sizes="))?.slice("--sizes=".length);
const sizes = requested ? requested.split(",").map(Number) : allowedSizes;
assert.ok(sizes.length > 0 && sizes.every((size) => allowedSizes.includes(size)), `--sizes must contain only ${allowedSizes.join(", ")}`);
const repeats = 3;
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-journal-bench-"));
const samples = [];
try {
  for (const size of sizes) {
    const stateDirectory = path.join(temporaryRoot, `corpus-${size}`);
    const store = await createStore({ directory: stateDirectory, filename: "benchmark.json", projectDirectory: temporaryRoot });
    for (let index = 0; index < size; index++) {
      const payload = newLedger();
      recordMessage(payload, { sessionID: "benchmark-session", id: `message-${index}`, role: "assistant", cost: 0.01,
        time: { created: index }, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 50, write: 10 } } },
      { receivedAt: index + 1, writerID: "journal-benchmark", writerSeq: index + 1, eventID: `benchmark-${size}-${index}` });
      await store.append({ eventID: `benchmark-${size}-${index}`, payload });
    }

    const journalFiles = (await fs.readdir(store.file)).filter((name) => name.endsWith(".event"));
    const bytes = (await Promise.all(journalFiles.map(async (name) => (await fs.stat(path.join(store.file, name))).size)))
      .reduce((sum, value) => sum + value, 0);
    assert.equal(journalFiles.length, size, "corpus contains exactly one event for each distinct message");
    const measurements = [];
    for (let sample = 0; sample <= repeats; sample++) {
      const start = process.hrtime.bigint();
      const ledger = await store.load();
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      const totals = aggregate(ledger, ["benchmark-session"]);
      assert.equal(totals.turns, size, "reload includes every benchmark message");
      assert.ok(Math.abs(totals.cost - size * 0.01) < 1e-8, "reload cost total is exact within floating-point tolerance");
      assert.equal(totals.totalTokens, size * 125, "reload budget token total is exact");
      assert.equal(totals.tokensComplete, true);
      measurements.push({ kind: sample === 0 ? "initial" : "repeat", elapsedMs });
    }
    samples.push({ size, eventCount: journalFiles.length, bytes, measurements });
  }
  process.stdout.write(`${JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
    os: `${os.type()} ${os.release()}`, repeats, samples }, null, 2)}\n`);
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
