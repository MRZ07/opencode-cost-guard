/**
 * Build a single-file local plugin: dist/opencode-cost-guard.js
 *
 * opencode (v1 and v2) auto-loads every .js file and package directory under
 * ~/.config/opencode/plugins/ and treats every exported function as a plugin.
 * Shipping one bundled file that exports only CostGuard avoids double-loading
 * and helper registration, and inlines zod so no node_modules is needed.
 *
 * Requires Bun (opencode ships it): bun build.
 */
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { statSync } from "node:fs";

const dir = dirname(fileURLToPath(import.meta.url));

execFileSync(
  "bun",
  ["build", "index.js", "--outfile", "dist/opencode-cost-guard.js", "--target", "node", "--format", "esm"],
  { cwd: dir, stdio: "inherit" },
);

const out = `${dir}/dist/opencode-cost-guard.js`;
console.log(`wrote dist/opencode-cost-guard.js (${statSync(out).size} bytes)`);
