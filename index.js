/**
 * opencode-cost-guard — plugin entry.
 *
 * Only plugin functions are exported from this file: opencode treats every
 * exported function in a plugin file as a plugin, so the helper logic lives in
 * ./lib.js and is imported here. (Named + default point at the same function,
 * matching opencode's own plugin examples.)
 */
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
    try {
      const { tool } = await import("@opencode-ai/plugin");
      hooks.tool = {
        cost_guard_extend: tool({
          description:
            "Cost guard: extend this session's USD budget after the user approves continuing. " +
            "Call this once the user has agreed to continue past the cost limit.",
          args: {
            usd: tool.schema.number().optional().describe("USD to add to the session limit (default: one more limit)"),
          },
          async execute(args, context) {
            const newLimit = extend(context.sessionID, args?.usd);
            return `cost-guard: budget extended to ${newLimit.toFixed(2)} USD for this session.\n${describe(context.sessionID)}`;
          },
        }),
      };
    } catch {
      /* @opencode-ai/plugin runtime unavailable; ask flow still works without auto-extend */
    }
  }

  return hooks;
};

export default CostGuard;
