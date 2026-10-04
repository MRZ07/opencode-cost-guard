import type { Hooks, Plugin, PluginOptions } from "@opencode-ai/plugin";

/** USD amount, or a per-agent map of glob → USD ("*" / "default" is the fallback). */
export type LimitSpec = number | Record<string, number>;

export interface CostGuardOptions extends PluginOptions {
  /** USD per session, or per-agent `{ "agentGlob": usd, "*": usd }`. Default: 5 */
  limit?: LimitSpec;
  /** Alias for `limit` (takes precedence). */
  limits?: LimitSpec;
  /** "warn" logs only; "block" caps output and stops tool calls. Default: "warn" */
  action?: "warn" | "block";
  /** Fraction of a session's limit at which a warning is logged (0..1). Default: 0.8 */
  warnRatio?: number;
  /** Agent globs to enforce. Default: ["*"] */
  agents?: string[];
  /** Agent globs to skip. Default: [] */
  exclude?: string[];
  /** Output token cap applied once blocked. Default: 1 */
  maxOutputTokensOnBlock?: number;
  /** On limit: "stop" aborts immediately; "ask" instructs the agent to ask you, then extend. Default: "stop" */
  onBlock?: "stop" | "ask";
  /** Emit logs (errors always log). Default: true */
  notify?: boolean;
}

export interface ResolvedOptions {
  limit: number;
  limits: Array<[string, number]>;
  action: "warn" | "block";
  warnRatio: number;
  agents: string[];
  exclude: string[];
  maxOutputTokensOnBlock: number;
  onBlock: "stop" | "ask";
  notify: boolean;
}

export declare function globMatch(pattern: string, value: string): boolean;
export declare function fmtNum(n: number): string;
export declare function explainCost(s: {
  cost: number;
  limit?: number;
  tokens?: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  turnCount?: number;
  models?: Set<string> | string[];
  first?: number;
  last?: number;
  agent?: string;
}): string;
export declare function parseLimits(raw: unknown, fallback?: number): { default: number; perAgent: Array<[string, number]> };
export declare function resolveLimit(cfg: Pick<ResolvedOptions, "limit" | "limits">, agent?: string): number;
export declare function normalizeOptions(options?: PluginOptions): ResolvedOptions;
export declare function createCostGuard(
  cfg: ResolvedOptions,
  client: { app: { log: (input: { body: Record<string, unknown> }) => Promise<unknown> } },
): Hooks;
export declare function createCostGuardController(
  cfg: ResolvedOptions,
  client: { app: { log: (input: { body: Record<string, unknown> }) => Promise<unknown> } },
): { hooks: Hooks; extend: (sessionID: string, usd?: number) => number; describe: (sessionID: string) => string };

export declare const CostGuard: Plugin;
export default CostGuard;
