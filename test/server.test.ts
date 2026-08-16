import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { parseProfile } from "../src/config.js";
import { Journal } from "../src/journal.js";
import { createFaultServer } from "../src/server.js";
import { EXAMPLE_TOOLS } from "../src/tools/index.js";

function build(profileRaw: unknown = {}, options: { advertiseOutputSchema?: boolean } = {}) {
  const journal = new Journal({ stderr: false });
  return createFaultServer({
    profile: parseProfile(profileRaw),
    tools: EXAMPLE_TOOLS,
    journal,
    ...(options.advertiseOutputSchema ? { advertiseOutputSchema: true } : {}),
  });
}

async function connected(profileRaw: unknown = {}) {
  const built = build(profileRaw);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), built.server.connect(serverTransport)]);
  return { ...built, client };
}

describe("MCP surface", () => {
  it("lists the example tools over a real MCP connection", async () => {
    const { client } = await connected();
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual(["get_account_balance", "read_file", "search"]);
    for (const tool of listed.tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toMatchObject({ type: "object" });
    }
    await client.close();
  });

  it("hides outputSchema unless asked, so schema faults reach the agent", async () => {
    const hidden = await connected();
    expect((await hidden.client.listTools()).tools.every((t) => t.outputSchema === undefined)).toBe(true);
    await hidden.client.close();

    const built = build({}, { advertiseOutputSchema: true });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    await Promise.all([client.connect(clientTransport), built.server.connect(serverTransport)]);
    expect((await client.listTools()).tools.some((t) => t.outputSchema !== undefined)).toBe(true);
    await client.close();
  });

  it("serves a clean answer when no fault is configured", async () => {
    const { client } = await connected();
    const result = (await client.callTool({
      name: "get_account_balance",
      arguments: { account_id: "ACC-4471" },
    })) as { content: { type: string; text: string }[]; isError?: boolean };

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain("ACC-4471");
    await client.close();
  });

  it("delivers an injected error over the wire", async () => {
    const { client } = await connected({ defaults: [{ kind: "error", message: "EACCES: permission denied" }] });
    const result = (await client.callTool({
      name: "get_account_balance",
      arguments: { account_id: "ACC-4471" },
    })) as { content: { text: string }[]; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("EACCES: permission denied");
    await client.close();
  });

  it("delivers a corrupted answer that looks entirely normal", async () => {
    const honest = await connected();
    const clean = (await honest.client.callTool({
      name: "get_account_balance",
      arguments: { account_id: "ACC-4471" },
    })) as { content: { text: string }[] };
    await honest.client.close();

    const lying = await connected({ defaults: [{ kind: "corrupt" }] });
    const corrupted = (await lying.client.callTool({
      name: "get_account_balance",
      arguments: { account_id: "ACC-4471" },
    })) as { content: { text: string }[]; isError?: boolean };

    expect(corrupted.isError).toBeFalsy();
    expect(corrupted.content[0]?.text).not.toBe(clean.content[0]?.text);
    expect(corrupted.content[0]?.text).toMatch(/^ACC-4471: [\d.]+ [A-Z]{3} cleared as of \d{4}-\d{2}-\d{2}$/);
    await lying.client.close();
  });

  it("reports an unknown tool as an error rather than throwing", async () => {
    const built = build();
    const { result } = await built.invoke("no_such_tool", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: "Unknown tool: no_such_tool" });
  });
});

describe("call counting and profiles", () => {
  it("counts per tool, so onCalls means calls of that tool", async () => {
    const built = build({ defaults: [{ kind: "error", onCalls: [2] }] });

    expect((await built.invoke("search", { query: "a" })).result.isError).toBeFalsy();
    expect((await built.invoke("read_file", { path: "/var/log/deploy.log" })).result.isError).toBeFalsy();
    expect((await built.invoke("search", { query: "b" })).result.isError).toBe(true);
    expect(built.counters.get("search")).toBe(2);
    expect(built.counters.get("read_file")).toBe(1);
  });

  it("applies a tool-specific rule instead of the default", async () => {
    const built = build({
      defaults: [{ kind: "corrupt" }],
      tools: { search: { faults: [{ kind: "empty" }], inheritDefaults: false } },
    });

    expect((await built.invoke("search", { query: "x" })).result.content).toEqual([{ type: "text", text: "" }]);
    expect((await built.invoke("get_account_balance", { account_id: "ACC-1" })).decision?.rule?.kind).toBe("corrupt");
  });

  it("replays identically for the same seed", async () => {
    const run = async () => {
      const built = build({ seed: 909, defaults: [{ kind: "corrupt", probability: 0.5 }] });
      const out: string[] = [];
      for (let i = 0; i < 12; i++) {
        const { result } = await built.invoke("get_account_balance", { account_id: `ACC-${i}` });
        out.push(JSON.stringify(result));
      }
      return out;
    };
    expect(await run()).toEqual(await run());
  });

  it("produces a different run for a different seed", async () => {
    const run = async (seed: number) => {
      const built = build({ seed, defaults: [{ kind: "corrupt", probability: 0.5 }] });
      const out: (string | null)[] = [];
      for (let i = 0; i < 12; i++) {
        const { decision } = await built.invoke("search", { query: `q${i}` });
        out.push(decision?.rule?.kind ?? null);
      }
      return out;
    };
    expect(await run(1)).not.toEqual(await run(2));
  });
});

describe("journal", () => {
  it("records what the tool actually returned, fault and all", async () => {
    const built = build({ defaults: [{ kind: "corrupt", note: "cache key bug" }] });
    await built.invoke("get_account_balance", { account_id: "ACC-4471" });

    expect(built.journal.entries).toHaveLength(1);
    const entry = built.journal.entries[0]!;
    expect(entry.tool).toBe("get_account_balance");
    expect(entry.callIndex).toBe(1);
    expect(entry.fault).toBe("corrupt");
    expect(entry.rule?.note).toBe("cache key bug");
    expect(entry.args).toEqual({ account_id: "ACC-4471" });
    expect(entry.returned.text).toContain("ACC-4471");
    expect(entry.returned.isError).toBe(false);
    expect(typeof entry.durationMs).toBe("number");
  });

  it("records clean calls too, so the journal is the whole run", async () => {
    const built = build();
    await built.invoke("search", { query: "stale caches" });
    expect(built.journal.entries[0]?.fault).toBeNull();
    expect(built.journal.entries[0]?.rule).toBeNull();
  });

  it("writes one JSON object per line", async () => {
    const lines: string[] = [];
    const journal = new Journal({ stderr: false, write: (line) => lines.push(line) });
    const built = createFaultServer({ profile: parseProfile({}), tools: EXAMPLE_TOOLS, journal });

    await built.invoke("search", { query: "a" });
    await built.invoke("search", { query: "b" });

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toContain("\n");
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
