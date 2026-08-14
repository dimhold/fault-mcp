import type { FaultRule } from "./config.js";
import { intBetween } from "./rng.js";
import type { CallContext, ContentBlock, TextBlock, ToolDefinition, ToolResult } from "./types.js";

/**
 * The six shapes a tool call goes wrong in.
 *
 * The split that matters is between the faults a tool announces (`error`,
 * `empty`) and the ones it does not (`corrupt`, `truncate`, `schema`). The loud
 * ones are the ones every agent already handles. The quiet ones are why this
 * package exists.
 */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isText(block: ContentBlock): block is TextBlock {
  return block.type === "text" && typeof (block as TextBlock).text === "string";
}

function textBlocks(result: ToolResult): TextBlock[] {
  return result.content.filter(isText);
}

export interface ApplyOptions {
  rule: FaultRule;
  ctx: CallContext;
  /** The tool the call was made against, when known. Enables per-tool corruption. */
  tool?: ToolDefinition;
}

/** Apply one fault to a clean result. Returns a new object; the input is untouched. */
export async function applyFault(clean: ToolResult, opts: ApplyOptions): Promise<ToolResult> {
  const { rule, ctx } = opts;

  if (rule.delayMs && rule.delayMs > 0) await sleep(rule.delayMs);

  switch (rule.kind) {
    case "error":
      return { content: [{ type: "text", text: rule.message }], isError: true };

    case "empty":
      return rule.style === "no-blocks" ? { content: [] } : { content: [{ type: "text", text: "" }] };

    case "latency": {
      const ms =
        rule.minMs !== undefined || rule.maxMs !== undefined
          ? intBetween(ctx.rng, rule.minMs ?? 0, rule.maxMs ?? rule.minMs ?? rule.ms)
          : rule.ms;
      await sleep(ms);
      return clone(clean);
    }

    case "truncate":
      return truncate(clean, rule.keep, rule.suffix, rule.dropStructured);

    case "schema":
      return violateSchema(clean, rule.mode, rule.field, opts.tool);

    case "corrupt": {
      if (rule.strategy === "plausible" && opts.tool?.corrupt) {
        return opts.tool.corrupt(clone(clean), ctx);
      }
      return corruptGenerically(clean, ctx);
    }
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/* -------------------------------------------------------------------------- */
/* truncate                                                                    */
/* -------------------------------------------------------------------------- */

export function truncate(clean: ToolResult, keep: number, suffix: string, dropStructured: boolean): ToolResult {
  const out: ToolResult = {
    content: clean.content.map((block) =>
      isText(block) ? { type: "text", text: block.text.slice(0, keep) + suffix } : clone(block),
    ),
  };
  if (!dropStructured && clean.structuredContent) out.structuredContent = clone(clean.structuredContent);
  if (clean.isError) out.isError = true;
  return out;
}

/* -------------------------------------------------------------------------- */
/* schema violation                                                            */
/* -------------------------------------------------------------------------- */

export function violateSchema(
  clean: ToolResult,
  mode: "type-swap" | "drop-required" | "wrong-container",
  field: string | undefined,
  tool?: ToolDefinition,
): ToolResult {
  const structured = clean.structuredContent ? clone(clean.structuredContent) : undefined;

  if (!structured) {
    // Text-only tools get their JSON payload mangled instead: an unquoted key,
    // which is what a hand-rolled serializer produces when it goes wrong.
    return {
      content: clean.content.map((block) =>
        isText(block) ? { type: "text", text: mangleJsonText(block.text) } : clone(block),
      ),
    };
  }

  let broken: unknown;
  switch (mode) {
    case "type-swap":
      broken = swapTypes(structured);
      break;
    case "drop-required": {
      const target = field ?? firstRequiredField(tool) ?? Object.keys(structured)[0];
      if (target) delete (structured as Record<string, unknown>)[target];
      broken = structured;
      break;
    }
    case "wrong-container":
      broken = Object.entries(structured).map(([key, value]) => [key, value]);
      break;
  }

  return {
    content: [{ type: "text", text: JSON.stringify(broken) }],
    structuredContent: broken as Record<string, unknown>,
  };
}

function firstRequiredField(tool?: ToolDefinition): string | undefined {
  const required = tool?.outputSchema?.["required"];
  if (Array.isArray(required) && typeof required[0] === "string") return required[0];
  return undefined;
}

function swapTypes(value: unknown): unknown {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(swapTypes);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, swapTypes(v)]));
  }
  return value;
}

function mangleJsonText(text: string): string {
  try {
    JSON.parse(text);
  } catch {
    return text; // not JSON to begin with, nothing to break
  }
  return text.replace(/"([A-Za-z_][A-Za-z0-9_]*)":/g, "$1:");
}

/* -------------------------------------------------------------------------- */
/* generic corruption                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A wrong answer that still looks like an answer. Numbers move by a plausible
 * amount, digits inside strings get rewritten, dates shift by a few days, and
 * lists lose an element. Nothing announces itself.
 */
export function corruptGenerically(clean: ToolResult, ctx: CallContext): ToolResult {
  const structured = clean.structuredContent ? (corruptValue(clean.structuredContent, ctx) as Record<string, unknown>) : undefined;

  const content: ContentBlock[] = clean.content.map((block) =>
    isText(block) ? { type: "text", text: corruptText(block.text, ctx) } : clone(block),
  );

  const out: ToolResult = { content };
  if (structured) out.structuredContent = structured;
  return out;
}

function corruptValue(value: unknown, ctx: CallContext): unknown {
  if (typeof value === "number") return nudgeNumber(value, ctx);
  if (typeof value === "boolean") return ctx.rng() < 0.5 ? !value : value;
  if (typeof value === "string") return corruptText(value, ctx);
  if (Array.isArray(value)) {
    const items = value.map((item) => corruptValue(item, ctx));
    // Losing the tail of a list is the single most common quiet failure in a
    // paginated API, so it gets its own branch.
    if (items.length > 1 && ctx.rng() < 0.4) items.pop();
    return items;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, corruptValue(v, ctx)]),
    );
  }
  return value;
}

function nudgeNumber(value: number, ctx: CallContext): number {
  if (!Number.isFinite(value)) return value;
  if (Number.isInteger(value) && Math.abs(value) <= 12) {
    // Small integers are counts. Off by one is the realistic error.
    return value + (ctx.rng() < 0.5 ? -1 : 1);
  }
  const factor = 0.6 + ctx.rng() * 0.9; // 0.6x to 1.5x
  const scaled = value * factor;
  return Number.isInteger(value) ? Math.round(scaled) : Number(scaled.toFixed(2));
}

const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
const DIGIT_RUN = /\d[\d,._]*\d|\d/g;

interface Segment {
  text: string;
  isDate: boolean;
}

/**
 * Dates are shifted as whole dates and then left alone; every other digit run is
 * fair game. Rewriting a digit inside a date produces month 83, which is not a
 * wrong answer so much as an obviously broken one, and an obviously broken
 * answer is not what this fault is for.
 */
function corruptText(text: string, ctx: CallContext): string {
  if (text.length === 0) return text;

  const segments: Segment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(ISO_DATE)) {
    const start = match.index ?? 0;
    if (start > cursor) segments.push({ text: text.slice(cursor, start), isDate: false });
    segments.push({ text: shiftDate(match[0], intBetween(ctx.rng, -9, 9)), isDate: true });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), isDate: false });

  // One digit run per string. One is enough to be wrong and few enough that the
  // answer still reads as the same answer.
  const candidates: { segment: number; index: number; run: string }[] = [];
  segments.forEach((segment, i) => {
    if (segment.isDate) return;
    for (const match of segment.text.matchAll(DIGIT_RUN)) {
      candidates.push({ segment: i, index: match.index ?? 0, run: match[0] });
    }
  });

  if (candidates.length > 0) {
    const target = candidates[Math.floor(ctx.rng() * candidates.length) % candidates.length] as (typeof candidates)[0];
    const segment = segments[target.segment] as Segment;
    segments[target.segment] = {
      ...segment,
      text:
        segment.text.slice(0, target.index) +
        rewriteDigits(target.run, ctx) +
        segment.text.slice(target.index + target.run.length),
    };
  }

  return segments.map((segment) => segment.text).join("");
}

function rewriteDigits(run: string, ctx: CallContext): string {
  const chars = [...run];
  const digitPositions = chars.map((c, i) => (/\d/.test(c) ? i : -1)).filter((i) => i >= 0);
  if (digitPositions.length === 0) return run;
  const at = digitPositions[Math.floor(ctx.rng() * digitPositions.length) % digitPositions.length] as number;
  const current = Number(chars[at]);
  const replacement = (current + 1 + Math.floor(ctx.rng() * 8)) % 10;
  chars[at] = String(replacement);
  return chars.join("");
}

function shiftDate(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  date.setUTCDate(date.getUTCDate() + (days === 0 ? 1 : days));
  return date.toISOString().slice(0, 10);
}
