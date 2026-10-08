import { z } from "zod";

const positive = z.number().finite().positive();
const integer = positive.int().max(Number.MAX_SAFE_INTEGER);
const limits = z.union([positive, z.record(z.string().min(1), positive)]);
export const optionsSchema = z.object({
  limit: limits.optional(), limits: limits.optional(),
  action: z.enum(["warn", "block"]).default("warn"),
  onBlock: z.enum(["stop", "ask"]).default("stop"),
  warnRatio: positive.max(1).default(0.8),
  agents: z.array(z.string().min(1)).min(1).default(["*"]),
  exclude: z.array(z.string().min(1)).default([]),
  maxOutputTokensOnBlock: integer.default(1),
  notify: z.boolean().default(true), usdEnabled: z.boolean().default(true),
  persist: z.boolean().default(true), stateDirectory: z.string().min(1).nullish(),
  tokenLimit: integer.nullish(), subagentTokenLimit: integer.nullish(),
  runLimit: positive.nullish(), runTokenLimit: integer.nullish(),
  historyPageSize: integer.max(500).default(500),
  historyMaxPages: integer.max(1000).default(100),
  historyTimeoutMs: integer.max(60000).default(10000),
  incompleteHistory: z.enum(["block", "warn"]).default("block"),
  configRefreshMs: integer.max(240000).default(60000),
}).strict();

export function validateOptions(options) {
  const parsed = optionsSchema.safeParse(options);
  if (!parsed.success) throw new Error("cost-guard: invalid configuration: " +
    parsed.error.issues.map((issue) => `${issue.path.join(".") || "options"}: ${issue.message}`).join("; "));
  return parsed.data;
}
