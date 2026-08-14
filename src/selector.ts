import type { FaultRule } from "./config.js";
import { rngFor } from "./rng.js";
import type { Rng } from "./types.js";

/**
 * Deciding which fault, if any, fires on a given call.
 *
 * Two properties matter more than anything clever here:
 *
 * 1. The decision depends only on (seed, tool, callIndex). Call 7 rolls the same
 *    numbers whether or not calls 1 to 6 happened, so you can reproduce a bad
 *    run from the seed without replaying the whole session.
 * 2. Rules are evaluated in order and the first one that fires wins, so a
 *    tool-specific rule can shadow a profile default.
 */

export interface Roll {
  ruleIndex: number;
  kind: FaultRule["kind"];
  /** The number drawn, or null when the rule was skipped without a draw. */
  roll: number | null;
  fired: boolean;
  skippedReason?: "onCalls";
}

export interface FaultDecision {
  tool: string;
  callIndex: number;
  seed: number;
  /** The rule that fired, or null for a clean call. */
  rule: FaultRule | null;
  ruleIndex: number | null;
  /** Every rule considered, in order. Useful when a profile does not do what you expected. */
  rolls: Roll[];
  /** The stream the fault itself should draw from, positioned after the rolls. */
  rng: Rng;
}

export interface SelectOptions {
  seed: number;
  tool: string;
  callIndex: number;
}

export function selectFault(rules: readonly FaultRule[], opts: SelectOptions): FaultDecision {
  const rng = rngFor(opts.seed, opts.tool, opts.callIndex);
  const rolls: Roll[] = [];

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i] as FaultRule;

    if (rule.onCalls && !rule.onCalls.includes(opts.callIndex)) {
      rolls.push({ ruleIndex: i, kind: rule.kind, roll: null, fired: false, skippedReason: "onCalls" });
      continue;
    }

    // Probability 1 still draws, so that adding a certain rule in front of an
    // uncertain one does not silently reshuffle the ones behind it.
    const roll = rng();
    const fired = roll < rule.probability;
    rolls.push({ ruleIndex: i, kind: rule.kind, roll, fired });

    if (fired) {
      return { tool: opts.tool, callIndex: opts.callIndex, seed: opts.seed, rule, ruleIndex: i, rolls, rng };
    }
  }

  return { tool: opts.tool, callIndex: opts.callIndex, seed: opts.seed, rule: null, ruleIndex: null, rolls, rng };
}
