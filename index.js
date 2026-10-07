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
import { projectKey } from "./accounting.js";
import { randomUUID } from "node:crypto";

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
export const CostGuard = async ({ client, directory }, options) => {
  const fileOptions = await loadFileOptions();
  const cfg = normalizeOptions({ ...(fileOptions || {}), ...(options || {}) });
  const projectDirectory = directory?.worktree || directory?.project || directory || process.cwd();
  const key = await projectKey(projectDirectory);
  const controller = createCostGuardController(cfg, client, projectDirectory, { projectKey: key, instanceID: randomUUID() });
  const { hooks, extend, describe } = controller;
  hooks.config = async () => {
    await controller.ready;
    await controller.refresh();
    await controller.publishConfig();
  };

  if (cfg.onBlock === "ask") {
    hooks.tool = {
      cost_guard_extend: {
        description:
          "Cost guard: after explicit user approval, add USD and/or total tokens to the session or run budget. " +
          "Without amounts, session scope retains the default USD extension; token-only mode adds one active base token limit.",
        args: {
          usd: z.number().positive().optional().describe("USD to add"),
          tokens: z.number().int().positive().optional().describe("Total session/run tokens to add"),
          scope: z.enum(["session", "run"]).optional().describe("Budget scope; default session"),
          sessionID: z.string().min(1).max(256).optional().describe("Optional verified child session target; requires canonical parent authority"),
        },
        async execute(args, context) {
          const requested = args?.sessionID || context.sessionID;
          let callerMetadata, targetMetadata;
          if (requested !== context.sessionID) {
            const [caller, target] = await Promise.all([
              client.session?.get?.({ path: { id: context.sessionID } }),
              client.session?.get?.({ path: { id: requested } }),
            ]);
            const valid = (result, id) => result && !result.error && result.data?.id === id &&
              typeof result.data.directory === "string" && typeof result.data.projectID === "string";
            if (!valid(caller, context.sessionID) || !valid(target, requested) ||
              await projectKey(caller.data.directory) !== await projectKey(projectDirectory) ||
              await projectKey(target.data.directory) !== await projectKey(projectDirectory))
              throw new Error("cost-guard: child extension requires successful same-project caller/target metadata");
            if (caller.data.projectID !== target.data.projectID) throw new Error("cost-guard: caller and child session project IDs do not match");
            callerMetadata = caller.data;
            targetMetadata = target.data;
          }
          await controller.ready;
          if (requested !== context.sessionID) {
            await controller.ingestSession(callerMetadata);
            await controller.ingestSession(targetMetadata);
            await controller.recoverAncestry(requested);
          }
          const result = await extend(context.sessionID, args?.usd, args?.tokens, args?.scope || "session", requested);
          return `cost-guard: approved ${args?.scope || "session"} budget extension recorded for ${requested} (${result}).\n${describe(requested)}`;
        },
      },
    };
  }

  return hooks;
};

export default CostGuard;
