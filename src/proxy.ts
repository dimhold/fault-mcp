import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ContentBlock, ToolDefinition, ToolResult } from "./types.js";

/**
 * Proxy mode: put faultmcp in front of a real MCP server.
 *
 * faultmcp connects to the upstream server as a client, re-exposes every tool it
 * finds, forwards calls through, and injects faults into the results on the way
 * back. Your agent points at faultmcp instead of the real server and nothing
 * else in the setup changes.
 */

export interface UpstreamOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Prefix added to every proxied tool name, to avoid clashing with the examples. */
  prefix?: string;
  clientName?: string;
  clientVersion?: string;
}

export interface Upstream {
  tools: ToolDefinition[];
  close(): Promise<void>;
}

export async function connectUpstream(options: UpstreamOptions): Promise<Upstream> {
  const transport = new StdioClientTransport({
    command: options.command,
    args: options.args ?? [],
    env: { ...getDefaultEnvironment(), ...(options.env ?? {}) },
    ...(options.cwd ? { cwd: options.cwd } : {}),
    stderr: "inherit",
  });

  const client = new Client(
    { name: options.clientName ?? "faultmcp-proxy", version: options.clientVersion ?? "0.1.0" },
    { capabilities: {} },
  );

  await client.connect(transport);
  const listed = await client.listTools();
  const prefix = options.prefix ?? "";

  const tools: ToolDefinition[] = listed.tools.map((upstreamTool) => {
    const exposedName = `${prefix}${upstreamTool.name}`;
    const definition: ToolDefinition = {
      name: exposedName,
      description: upstreamTool.description ?? `Proxied tool ${upstreamTool.name}`,
      inputSchema: (upstreamTool.inputSchema ?? { type: "object" }) as Record<string, unknown>,
      async call(args) {
        const response = await client.callTool({ name: upstreamTool.name, arguments: args });
        return normalise(response);
      },
    };
    if (upstreamTool.title) definition.title = upstreamTool.title;
    if (upstreamTool.outputSchema) definition.outputSchema = upstreamTool.outputSchema as Record<string, unknown>;
    return definition;
  });

  return {
    tools,
    async close() {
      await client.close();
    },
  };
}

/** Upstream results are already MCP shaped; narrow them to our internal type. */
function normalise(response: unknown): ToolResult {
  const raw = (response ?? {}) as {
    content?: unknown;
    structuredContent?: unknown;
    isError?: unknown;
  };
  const content: ContentBlock[] = Array.isArray(raw.content) ? (raw.content as ContentBlock[]) : [];
  const result: ToolResult = { content };
  if (raw.structuredContent && typeof raw.structuredContent === "object") {
    result.structuredContent = raw.structuredContent as Record<string, unknown>;
  }
  if (raw.isError === true) result.isError = true;
  return result;
}

/**
 * Split an upstream spec written as a single string, the way MCP client configs
 * express commands. Quoted segments stay together.
 */
export function parseUpstreamSpec(spec: string): { command: string; args: string[] } {
  const parts = spec.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const cleaned = parts.map((part) =>
    (part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))
      ? part.slice(1, -1)
      : part,
  );
  const [command, ...args] = cleaned;
  if (!command) throw new Error(`--upstream needs a command, got "${spec}"`);
  return { command, args };
}
