import { describe, expect, it } from "vitest";
import { FaultRuleSchema, type FaultRule } from "../src/config.js";
import { applyFault } from "../src/faults.js";
import { rngFor } from "../src/rng.js";
import { getAccountBalance, readFile, search } from "../src/tools/index.js";
import type { CallContext, TextBlock, ToolResult } from "../src/types.js";

const rule = (raw: unknown): FaultRule => FaultRuleSchema.parse(raw);

function ctx(tool = "get_account_balance", callIndex = 1, seed = 1337): CallContext {
  return { tool, callIndex, seed, rng: rngFor(seed, tool, callIndex) };
}

function textOf(result: ToolResult): string {
  return result.content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

const clean = (): ToolResult => getAccountBalance.call({ account_id: "ACC-4471" }, ctx()) as ToolResult;

describe("error fault", () => {
  it("flags the result and replaces the payload with the message", async () => {
    const out = await applyFault(clean(), {
      rule: rule({ kind: "error", message: "EACCES: permission denied" }),
      ctx: ctx(),
    });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toBe("EACCES: permission denied");
    expect(out.structuredContent).toBeUndefined();
  });
});

describe("empty fault", () => {
  it("returns one blank text block by default", async () => {
    const out = await applyFault(clean(), { rule: rule({ kind: "empty" }), ctx: ctx() });
    expect(out.content).toEqual([{ type: "text", text: "" }]);
    expect(out.isError).toBeUndefined();
  });

  it("returns no blocks at all in no-blocks style", async () => {
    const out = await applyFault(clean(), { rule: rule({ kind: "empty", style: "no-blocks" }), ctx: ctx() });
    expect(out.content).toEqual([]);
  });
});

describe("truncate fault", () => {
  it("cuts each text block and says nothing about it", async () => {
    const before = clean();
    const out = await applyFault(before, { rule: rule({ kind: "truncate", keep: 8 }), ctx: ctx() });
    expect(textOf(out)).toBe(textOf(before).slice(0, 8));
    expect(textOf(out)).toHaveLength(8);
    expect(out.isError).toBeUndefined();
    expect(out.structuredContent).toBeUndefined();
  });

  it("can keep the structured payload and add a marker when asked", async () => {
    const out = await applyFault(clean(), {
      rule: rule({ kind: "truncate", keep: 5, suffix: "…", dropStructured: false }),
      ctx: ctx(),
    });
    expect(textOf(out).endsWith("…")).toBe(true);
    expect(out.structuredContent).toBeDefined();
  });
});

describe("schema fault", () => {
  it("type-swap turns numbers and booleans into strings", async () => {
    const out = await applyFault(clean(), { rule: rule({ kind: "schema", mode: "type-swap" }), ctx: ctx() });
    expect(typeof out.structuredContent?.["balance_minor"]).toBe("string");
    expect(typeof out.structuredContent?.["currency"]).toBe("string");
  });

  it("drop-required removes the first required field of the tool", async () => {
    const out = await applyFault(clean(), {
      rule: rule({ kind: "schema", mode: "drop-required" }),
      ctx: ctx(),
      tool: getAccountBalance,
    });
    expect(out.structuredContent).not.toHaveProperty("account_id");
    expect(out.structuredContent).toHaveProperty("balance_minor");
  });

  it("drop-required can target a named field", async () => {
    const out = await applyFault(clean(), {
      rule: rule({ kind: "schema", mode: "drop-required", field: "as_of" }),
      ctx: ctx(),
      tool: getAccountBalance,
    });
    expect(out.structuredContent).not.toHaveProperty("as_of");
    expect(out.structuredContent).toHaveProperty("account_id");
  });

  it("wrong-container delivers an array where an object was documented", async () => {
    const out = await applyFault(clean(), { rule: rule({ kind: "schema", mode: "wrong-container" }), ctx: ctx() });
    expect(Array.isArray(out.structuredContent)).toBe(true);
  });

  it("mangles the JSON of a text-only result", async () => {
    const jsonOnly: ToolResult = { content: [{ type: "text", text: '{"balance":100,"currency":"USD"}' }] };
    const out = await applyFault(jsonOnly, { rule: rule({ kind: "schema" }), ctx: ctx() });
    expect(() => JSON.parse(textOf(out))).toThrow();
    expect(textOf(out)).toContain("balance:");
  });
});

describe("latency fault", () => {
  it("waits, then returns the clean answer unchanged", async () => {
    const before = clean();
    const started = Date.now();
    const out = await applyFault(before, { rule: rule({ kind: "latency", ms: 120 }), ctx: ctx() });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(out).toEqual(before);
  });

  it("draws a delay inside the configured range", async () => {
    const started = Date.now();
    await applyFault(clean(), { rule: rule({ kind: "latency", minMs: 60, maxMs: 90 }), ctx: ctx() });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(1500);
  });

  it("applies delayMs on any rule", async () => {
    const started = Date.now();
    const out = await applyFault(clean(), { rule: rule({ kind: "error", delayMs: 80 }), ctx: ctx() });
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
    expect(out.isError).toBe(true);
  });
});

describe("corrupt fault", () => {
  it("changes the value while keeping the shape, and flags nothing", async () => {
    const before = clean();
    const out = await applyFault(before, { rule: rule({ kind: "corrupt" }), ctx: ctx(), tool: getAccountBalance });

    expect(out.isError).toBeUndefined();
    expect(Object.keys(out.structuredContent ?? {}).sort()).toEqual(
      Object.keys(before.structuredContent ?? {}).sort(),
    );
    expect(out.structuredContent?.["account_id"]).toBe(before.structuredContent?.["account_id"]);
    expect(out.structuredContent?.["balance_minor"]).not.toBe(before.structuredContent?.["balance_minor"]);
    expect(typeof out.structuredContent?.["balance_minor"]).toBe("number");
    expect(textOf(out)).not.toBe(textOf(before));
  });

  it("uses the tool's own corrupter when one exists", async () => {
    const before = search.call({ query: "retry budgets", limit: 3 }, ctx("search")) as ToolResult;
    const out = await applyFault(before, { rule: rule({ kind: "corrupt" }), ctx: ctx("search"), tool: search });

    expect(out.structuredContent?.["query"]).toBe("retry budgets");
    expect(out.structuredContent?.["count"]).toBe(3);
    expect(JSON.stringify(out.structuredContent?.["results"])).not.toBe(
      JSON.stringify(before.structuredContent?.["results"]),
    );
  });

  it("serves a stale revision for read_file", async () => {
    const path = "/etc/app/config.yaml";
    const before = readFile.call({ path }, ctx("read_file")) as ToolResult;
    const out = await applyFault(before, { rule: rule({ kind: "corrupt" }), ctx: ctx("read_file"), tool: readFile });

    expect(textOf(before)).toContain("eu-central-1");
    expect(textOf(out)).toContain("us-east-1");
    expect(out.isError).toBeUndefined();
  });

  it("falls back to the generic corrupter when the strategy asks for it", async () => {
    const before = clean();
    const out = await applyFault(before, {
      rule: rule({ kind: "corrupt", strategy: "generic" }),
      ctx: ctx(),
      tool: getAccountBalance,
    });
    expect(out.structuredContent?.["balance_minor"]).not.toBe(before.structuredContent?.["balance_minor"]);
    expect(out.structuredContent?.["as_of"]).not.toBe(before.structuredContent?.["as_of"]);
  });

  it("keeps a corrupted date a real date, not month 83", async () => {
    for (let call = 1; call <= 60; call++) {
      const before = getAccountBalance.call({ account_id: `ACC-${call}` }, ctx("get_account_balance", call));
      const out = await applyFault(before as ToolResult, {
        rule: rule({ kind: "corrupt", strategy: "generic" }),
        ctx: ctx("get_account_balance", call),
        tool: getAccountBalance,
      });
      const date = textOf(out).match(/\d{4}-\d{2}-\d{2}/)?.[0];
      expect(date, textOf(out)).toBeDefined();
      expect(new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10)).toBe(date);
    }
  });

  it("is deterministic for a given seed and call", async () => {
    const opts = () => ({ rule: rule({ kind: "corrupt", strategy: "generic" }), ctx: ctx(), tool: getAccountBalance });
    const a = await applyFault(clean(), opts());
    const b = await applyFault(clean(), opts());
    expect(a).toEqual(b);
  });
});

describe("input is never mutated", () => {
  it("leaves the clean result untouched", async () => {
    const before = clean();
    const snapshot = structuredClone(before);
    for (const kind of ["error", "empty", "truncate", "schema", "corrupt"] as const) {
      await applyFault(before, { rule: rule({ kind }), ctx: ctx(), tool: getAccountBalance });
    }
    expect(before).toEqual(snapshot);
  });
});
