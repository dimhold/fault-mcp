/**
 * Core types shared by the fault engine, the tool registry and the server.
 *
 * These deliberately mirror the MCP `CallToolResult` shape rather than importing
 * it, because half the point of this package is to emit results that a strict
 * schema would reject.
 */

export interface TextBlock {
  type: "text";
  text: string;
}

export type ContentBlock = TextBlock | ({ type: string } & Record<string, unknown>);

export interface ToolResult {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** A random source. Returns a float in [0, 1). */
export type Rng = () => number;

/** Everything a tool handler or a fault needs to know about the current call. */
export interface CallContext {
  /** Tool name as the client sees it. */
  tool: string;
  /** 1-based counter, per tool, for this process. */
  callIndex: number;
  /** Seed the whole run was configured with. */
  seed: number;
  /** Deterministic random source derived from seed + tool + callIndex. */
  rng: Rng;
}

/** A tool faultmcp can serve. Handlers must be deterministic given the same args. */
export interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  /** Raw JSON Schema. Kept raw so proxied upstream tools pass through unchanged. */
  inputSchema: Record<string, unknown>;
  /** Documented output shape. Used by the `schema` fault to know what to break. */
  outputSchema?: Record<string, unknown>;
  /** The honest answer. */
  call(args: Record<string, unknown>, ctx: CallContext): Promise<ToolResult> | ToolResult;
  /**
   * A wrong-but-plausible answer for this specific tool. Optional: when absent,
   * the generic corrupter in `faults.ts` is used instead. A hand-written one is
   * always more convincing, which is exactly what makes silent corruption hard.
   */
  corrupt?(clean: ToolResult, ctx: CallContext): ToolResult;
}
