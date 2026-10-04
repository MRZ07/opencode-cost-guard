import type { Hooks, Plugin, PluginOptions } from "@opencode-ai/plugin";

export interface CostGuardOptions extends PluginOptions {
  /** USD per session before acting. Default: 5 */
  limit?: number;
  /** "warn" logs only; "block" caps output and stops tool calls. Default: "warn" */
  action?: "warn" | "block";
  /** Fraction of `limit` at which a warning is logged (0..1). Default: 0.8 */
  warnRatio?: number;
  /** Agent globs to enforce. Default: ["*"] */
  agents?: string[];
  /** Agent globs to skip. Default: [] */
  exclude?: string[];
  /** Output token cap applied once blocked. Default: 1 */
  maxOutputTokensOnBlock?: number;
  /** Emit logs (errors always log). Default: true */
  notify?: boolean;
}

export declare function globMatch(pattern: string, value: string): boolean;
export declare function normalizeOptions(options?: PluginOptions): Required<CostGuardOptions>;
export declare function createCostGuard(
  cfg: ReturnType<typeof normalizeOptions>,
  client: { app: { log: (input: { body: Record<string, unknown> }) => Promise<unknown> } },
): Hooks;

export declare const CostGuard: Plugin;
export default CostGuard;
