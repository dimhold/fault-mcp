import { describe, expect, it } from "vitest";
import { FaultRuleSchema, type FaultRule } from "../src/config.js";
import { selectFault } from "../src/selector.js";

const rule = (raw: unknown): FaultRule => FaultRuleSchema.parse(raw);

describe("selectFault", () => {
  it("returns no rule when there is nothing configured", () => {
    const decision = selectFault([], { seed: 1, tool: "search", callIndex: 1 });
    expect(decision.rule).toBeNull();
    expect(decision.rolls).toEqual([]);
  });

  it("always fires a probability 1 rule", () => {
    const rules = [rule({ kind: "error", probability: 1 })];
    for (let call = 1; call <= 25; call++) {
      const decision = selectFault(rules, { seed: 99, tool: "search", callIndex: call });
      expect(decision.rule?.kind).toBe("error");
    }
  });

  it("never fires a probability 0 rule", () => {
    const rules = [rule({ kind: "error", probability: 0 })];
    for (let call = 1; call <= 25; call++) {
      expect(selectFault(rules, { seed: 99, tool: "search", callIndex: call }).rule).toBeNull();
    }
  });

  it("is reproducible: the same seed and call index give the same decision", () => {
    const rules = [rule({ kind: "corrupt", probability: 0.5 })];
    for (let call = 1; call <= 50; call++) {
      const a = selectFault(rules, { seed: 4242, tool: "search", callIndex: call });
      const b = selectFault(rules, { seed: 4242, tool: "search", callIndex: call });
      expect(a.rule).toEqual(b.rule);
      expect(a.rolls).toEqual(b.rolls);
    }
  });

  it("does not depend on calls that came before it", () => {
    const rules = [rule({ kind: "corrupt", probability: 0.4 })];
    const direct = selectFault(rules, { seed: 7, tool: "search", callIndex: 9 });

    for (let call = 1; call < 9; call++) selectFault(rules, { seed: 7, tool: "search", callIndex: call });
    const afterReplay = selectFault(rules, { seed: 7, tool: "search", callIndex: 9 });

    expect(afterReplay.rolls).toEqual(direct.rolls);
    expect(afterReplay.rule).toEqual(direct.rule);
  });

  it("gives a different sequence for a different seed", () => {
    const rules = [rule({ kind: "corrupt", probability: 0.5 })];
    const fired = (seed: number) =>
      Array.from({ length: 40 }, (_, i) => selectFault(rules, { seed, tool: "t", callIndex: i + 1 }).rule !== null);

    expect(fired(1)).not.toEqual(fired(2));
  });

  it("separates the streams of different tools", () => {
    const rules = [rule({ kind: "corrupt", probability: 0.5 })];
    const fired = (tool: string) =>
      Array.from({ length: 40 }, (_, i) => selectFault(rules, { seed: 5, tool, callIndex: i + 1 }).rule !== null);

    expect(fired("search")).not.toEqual(fired("read_file"));
  });

  it("respects the configured probability across a long run", () => {
    const rules = [rule({ kind: "corrupt", probability: 0.25 })];
    const n = 4000;
    let hits = 0;
    for (let call = 1; call <= n; call++) {
      if (selectFault(rules, { seed: 31337, tool: "search", callIndex: call }).rule) hits++;
    }
    // Binomial with p=0.25 and n=4000 has sd ~27 calls, so 3 percentage points
    // of slack is roughly four standard deviations.
    expect(hits / n).toBeGreaterThan(0.22);
    expect(hits / n).toBeLessThan(0.28);
  });

  it("takes the first rule that fires, so a tool rule can shadow a default", () => {
    const rules = [rule({ kind: "truncate", probability: 1 }), rule({ kind: "error", probability: 1 })];
    const decision = selectFault(rules, { seed: 1, tool: "search", callIndex: 1 });
    expect(decision.rule?.kind).toBe("truncate");
    expect(decision.ruleIndex).toBe(0);
    expect(decision.rolls).toHaveLength(1);
  });

  it("falls through to the next rule when the first does not fire", () => {
    const rules = [rule({ kind: "truncate", probability: 0 }), rule({ kind: "error", probability: 1 })];
    const decision = selectFault(rules, { seed: 1, tool: "search", callIndex: 1 });
    expect(decision.rule?.kind).toBe("error");
    expect(decision.ruleIndex).toBe(1);
  });

  it("honours onCalls and does not draw for skipped rules", () => {
    const rules = [rule({ kind: "error", probability: 1, onCalls: [2, 4] })];

    const skipped = selectFault(rules, { seed: 1, tool: "search", callIndex: 1 });
    expect(skipped.rule).toBeNull();
    expect(skipped.rolls[0]?.skippedReason).toBe("onCalls");
    expect(skipped.rolls[0]?.roll).toBeNull();

    expect(selectFault(rules, { seed: 1, tool: "search", callIndex: 2 }).rule?.kind).toBe("error");
    expect(selectFault(rules, { seed: 1, tool: "search", callIndex: 3 }).rule).toBeNull();
    expect(selectFault(rules, { seed: 1, tool: "search", callIndex: 4 }).rule?.kind).toBe("error");
  });

  it("records every rule it considered", () => {
    const rules = [
      rule({ kind: "error", probability: 0 }),
      rule({ kind: "empty", probability: 0 }),
      rule({ kind: "corrupt", probability: 1 }),
    ];
    const decision = selectFault(rules, { seed: 8, tool: "search", callIndex: 1 });
    expect(decision.rolls.map((r) => r.kind)).toEqual(["error", "empty", "corrupt"]);
    expect(decision.rolls.map((r) => r.fired)).toEqual([false, false, true]);
  });
});
