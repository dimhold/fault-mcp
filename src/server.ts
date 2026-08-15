import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { EMPTY_PROFILE, rulesFor, type Profile } from "./config.js";
import { applyFault } from "./faults.js";
import { Journal, summarise } from "./journal.js";
import { rngFor } from "./rng.js";
import { selectFault, type FaultDecision } from "./selector.js";
import type { ToolDefinition, ToolResult } from "./types.js";

export const SERVER_NAME = "faultmcp";
export const SERVER_VERSION = "0.1.0";

export interface FaultServerOptions {
  profile?: Profile;
  tools: ToolDefinition[];
  journal?: Journal;
  /**
   * Advertise each tool's `outputSchema` in tools/list.
   *
   * Off by default, and the reason is worth stating: a client that validates
   * structured output rejects a `schema` fault at the transport boundary, so the
   * agent never sees it and you end up testing the client instead of the agent.
   * Turn it on when the client's validation is the thing under test.
   */
  advertiseOutputSchema?: boolean;
  name?: string;
  version?: string;
}

export interface FaultServer {
  server: Server;
  journal: Journal;
  /** Per-tool call counters, exposed for tests and for resetting between runs. */
  counters: Map<string, number>;
  /** Run one tool call through the whole pipeline without a transport. */
  invoke(tool: string, args: Record<string, unknown>): Promise<{ result: ToolResult; decision: FaultDecision | null }>;
}

export function createFaultServer(options: FaultServerOptions): FaultServer {
  const profile = options.profile ?? EMPTY_PROFILE;
  const journal = options.journal ?? new Journal({ stderr: false });
  const byName = new Map(options.tools.map((tool) => [tool.name, tool]));
  const counters = new Map<string, number>();

  const server = new Server(
    { name: options.name ?? SERVER_NAME, version: options.version ?? SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: options.tools.map((tool) => {
      const entry: Record<string, unknown> = {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      };
      if (tool.title) entry["title"] = tool.title;
      if (options.advertiseOutputSchema && tool.outputSchema) entry["outputSchema"] = tool.outputSchema;
      return entry;
    }),
  }));

  async function invoke(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ result: ToolResult; decision: FaultDecision | null }> {
    const started = Date.now();
    const tool = byName.get(name);

    if (!tool) {
      const result: ToolResult = {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
      return { result, decision: null };
    }

    const callIndex = (counters.get(name) ?? 0) + 1;
    counters.set(name, callIndex);

    const ctx = { tool: name, callIndex, seed: profile.seed, rng: rngFor(profile.seed, name, callIndex) };

    let clean: ToolResult;
    try {
      clean = await tool.call(args, ctx);
    } catch (error) {
      clean = {
        content: [{ type: "text", text: `Tool threw: ${(error as Error).message}` }],
        isError: true,
      };
    }

    const decision = selectFault(rulesFor(profile, name), { seed: profile.seed, tool: name, callIndex });
    // The fault draws from the stream the selector left off at, so two profiles
    // that reach the same rule on the same call produce the same fault.
    const faultCtx = { ...ctx, rng: decision.rng };

    const result =
      decision.rule === null
        ? clean
        : await applyFault(clean, { rule: decision.rule, ctx: faultCtx, tool });

    journal.record({
      ts: new Date().toISOString(),
      tool: name,
      callIndex,
      seed: profile.seed,
      fault: decision.rule?.kind ?? null,
      rule: decision.rule,
      args,
      returned: summarise(result),
      durationMs: Date.now() - started,
    });

    return { result, decision };
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { result } = await invoke(request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>);
    // Cast, deliberately: a fault injector has to be able to return payloads a
    // strict CallToolResult type would refuse to describe.
    return result as unknown as Record<string, unknown>;
  });

  return { server, journal, counters, invoke };
}
