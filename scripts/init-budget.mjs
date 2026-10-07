#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULTS = Object.freeze({ action: "block", onBlock: "ask", tokenLimit: 500_000, subagentTokenLimit: 250_000 });
const DEFAULT_PATH = path.join(os.homedir(), ".config", "opencode", "cost-guard.json");

function parseArgs(args) {
  let write = false;
  let configPath = DEFAULT_PATH;
  let primaryTokens = DEFAULTS.tokenLimit;
  let subagentTokens = DEFAULTS.subagentTokenLimit;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--write") write = true;
    else if (arg === "--config" || arg === "--primary-tokens" || arg === "--subagent-tokens") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--config") configPath = path.resolve(value);
      else {
        const number = Number(value);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number <= 0) {
          throw new Error(`${arg} must be a positive safe integer`);
        }
        if (arg === "--primary-tokens") primaryTokens = number;
        else subagentTokens = number;
      }
    } else throw new Error(`unknown option: ${arg}`);
  }

  return { write, configPath, options: { ...DEFAULTS, tokenLimit: primaryTokens, subagentTokenLimit: subagentTokens } };
}

async function assertOwnedDirectory(directory, allowAppParentCreation) {
  if (allowAppParentCreation) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const resolved = await fs.realpath(directory);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error(`configuration parent is not an owned directory: ${directory}`);
  }
  return resolved;
}

async function createOnly(target, content, allowAppParentCreation) {
  const directory = await assertOwnedDirectory(path.dirname(target), allowAppParentCreation);
  const finalPath = path.join(directory, path.basename(target));
  const temporary = path.join(directory, `.cost-guard-${process.pid}-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    // A same-directory hard link publishes atomically and fails if any path entry exists.
    await fs.link(temporary, finalPath);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`refusing to replace existing configuration: ${target}`);
    throw new Error(`could not create configuration ${target}: ${error.message}`, { cause: error });
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

try {
  const { write, configPath, options } = parseArgs(process.argv.slice(2));
  const json = `${JSON.stringify(options, null, 2)}\n`;
  if (!write) process.stdout.write(json);
  else {
    await createOnly(configPath, json, configPath === DEFAULT_PATH);
    process.stdout.write(`Created ${configPath}\n`);
  }
} catch (error) {
  process.stderr.write(`init-budget: ${error.message}\n`);
  process.exitCode = 1;
}
