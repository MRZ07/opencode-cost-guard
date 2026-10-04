/**
 * Build a single-file local plugin: dist/opencode-cost-guard.js
 *
 * opencode (v1 and v2) auto-loads every .js file and package directory under
 * ~/.config/opencode/plugins/ and treats every exported function as a plugin.
 * Shipping one file that exports only CostGuard avoids double-loading and
 * helper functions being registered as plugins.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const lib = readFileSync(new URL("./lib.js", import.meta.url), "utf8");
const entry = readFileSync(new URL("./index.js", import.meta.url), "utf8");

const stripExports = (src) => src.replace(/^export /gm, "");
const stripImport = (src) => src.replace(/^import .*? from "\.\/lib\.js";\n/m, "");

const banner = "// GENERATED FILE — do not edit. Build with: node build-local.mjs\n";
const out = banner + stripExports(lib) + "\n" + stripImport(entry);

mkdirSync(new URL("./dist/", import.meta.url), { recursive: true });
writeFileSync(new URL("./dist/opencode-cost-guard.js", import.meta.url), out);
console.log("wrote dist/opencode-cost-guard.js (" + out.length + " bytes)");
