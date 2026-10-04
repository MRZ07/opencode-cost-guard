/**
 * opencode-cost-guard — plugin entry.
 *
 * Only plugin functions are exported from this file: opencode treats every
 * exported function in a plugin file as a plugin, so the helper logic lives in
 * ./lib.js and is imported here. (Named + default point at the same function,
 * matching opencode's own plugin examples.)
 */
import { z } from "zod";
import { createCostGuardController, normalizeOptions } from "./lib.js";

/** Optional config file for local installs, where the plugin tuple can't pass options. */
async function loadFileOptions() {
  try {
    const fs = await import("node:fs/promises");
    const p =
      process.env.OPENCODE_COST_GUARD_CONFIG ||
      (process.env.HOME ? `${process.env.HOME}/.config/opencode/cost-guard.json` : null);
    if (!p) return null;
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return null;
  }
}

/** @type {import("@opencode-ai/plugin").Plugin} */
export const CostGuard = async ({ client }, options) => {
  const fileOptions = await loadFileOptions();
  const cfg = normalizeOptions({ ...(fileOptions || {}), ...(options || {}) });
  const { hooks, extend, describe } = createCostGuardController(cfg, client);

  if (cfg.onBlock === "ask") {
    hooks.tool = {
      cost_guard_extend: {
        description:
          "Cost guard: grant extra USD to this session after the user approves continuing. " +
          "Pass the amount the user granted; omit it to add one more limit.",
        args: {
          usd: z.number().positive().optional().describe("USD to add to the session limit (default: one more limit)"),
        },
        async execute(args, context) {
          const limit = extend(context.sessionID, args?.usd);
          return `cost-guard: session limit is now ${limit.toFixed(2)} USD.\n${describe(context.sessionID)}`;
        },
      },
    };
  }

  return hooks;
};

export default CostGuard;
