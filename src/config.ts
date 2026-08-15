import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * Profile loading and validation.
 *
 * A profile is a JSON or YAML file describing which faults to inject, into which
 * tools, how often, and with which seed. Everything in it is optional: an empty
 * object is a valid profile that injects nothing.
 */

export const FAULT_KINDS = ["error", "corrupt", "latency", "truncate", "schema", "empty"] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];

const commonFields = {
  /** Chance this rule fires on a given call, 0 to 1. */
  probability: z.number().min(0).max(1).default(1),
  /** Restrict the rule to specific 1-based call numbers for this tool. */
  onCalls: z.array(z.number().int().positive()).nonempty().optional(),
  /** Extra delay applied before the result is returned, on top of the rule. */
  delayMs: z.number().int().nonnegative().optional(),
  /** Free text carried into the journal, so a run explains itself. */
  note: z.string().optional(),
};

export const FaultRuleSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("error"),
      /** The message the agent sees. Defaults to a permission error. */
      message: z.string().default("EACCES: permission denied"),
      ...commonFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal("corrupt"),
      /**
       * `plausible` asks the tool for its own wrong-but-plausible answer and
       * falls back to the generic corrupter. `generic` always uses the generic
       * corrupter, which nudges numbers, rewrites digits and shifts dates.
       */
      strategy: z.enum(["plausible", "generic"]).default("plausible"),
      ...commonFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal("latency"),
      /** Fixed delay. Ignored when minMs/maxMs are given. */
      ms: z.number().int().nonnegative().default(2000),
      minMs: z.number().int().nonnegative().optional(),
      maxMs: z.number().int().nonnegative().optional(),
      ...commonFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal("truncate"),
      /** Characters of each text block to keep. */
      keep: z.number().int().nonnegative().default(8),
      /** Appended after the cut. Empty by default, because real truncation is silent. */
      suffix: z.string().default(""),
      /** Drop structuredContent as well, the way a cut-off stream would. */
      dropStructured: z.boolean().default(true),
      ...commonFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal("schema"),
      /**
       * type-swap: numbers and booleans come back as strings.
       * drop-required: a required field goes missing.
       * wrong-container: an array arrives where an object was documented.
       */
      mode: z.enum(["type-swap", "drop-required", "wrong-container"]).default("type-swap"),
      /** Which field drop-required removes. Defaults to the first required one. */
      field: z.string().optional(),
      ...commonFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal("empty"),
      /** `empty-string` returns one blank text block; `no-blocks` returns none. */
      style: z.enum(["empty-string", "no-blocks"]).default("empty-string"),
      ...commonFields,
    })
    .strict(),
]);

export type FaultRule = z.infer<typeof FaultRuleSchema>;

const ToolProfileSchema = z
  .object({
    /** Rules are evaluated in order; the first one that fires wins. */
    faults: z.array(FaultRuleSchema).default([]),
    /** Skip the defaults for this tool. */
    inheritDefaults: z.boolean().default(true),
  })
  .strict();

export const ProfileSchema = z
  .object({
    $schema: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    /** Reproducibility. Same seed plus same call sequence gives the same faults. */
    seed: z.number().int().default(1337),
    /**
     * Evaluated before anything else, for every tool, including tools that opt
     * out of the defaults. This is what `FAULTMCP_FORCE` writes into.
     */
    forced: z.array(FaultRuleSchema).default([]),
    /** Applied to every tool that does not opt out. */
    defaults: z.array(FaultRuleSchema).default([]),
    /** Per-tool overrides, keyed by tool name. */
    tools: z.record(z.string(), ToolProfileSchema).default({}),
  })
  .strict();

export type Profile = z.infer<typeof ProfileSchema>;
export type ToolProfile = z.infer<typeof ToolProfileSchema>;

export const EMPTY_PROFILE: Profile = ProfileSchema.parse({});

export class ProfileError extends Error {
  constructor(message: string, readonly source?: string) {
    super(source ? `${source}: ${message}` : message);
    this.name = "ProfileError";
  }
}

/** Validate an already-parsed object. */
export function parseProfile(raw: unknown, source?: string): Profile {
  const result = ProfileSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  ${path}: ${issue.message}`;
    });
    throw new ProfileError(`invalid profile\n${lines.join("\n")}`, source);
  }
  return result.data;
}

/** Read and validate a profile from a .json, .yaml or .yml file. */
export function loadProfile(path: string): Profile {
  const full = resolve(path);
  let text: string;
  try {
    text = readFileSync(full, "utf8");
  } catch (error) {
    throw new ProfileError(`cannot read profile (${(error as Error).message})`, full);
  }

  const ext = extname(full).toLowerCase();
  let raw: unknown;
  try {
    raw = ext === ".yaml" || ext === ".yml" ? parseYaml(text) : JSON.parse(text);
  } catch (error) {
    throw new ProfileError(`cannot parse profile (${(error as Error).message})`, full);
  }

  return parseProfile(raw, full);
}

/**
 * The rules that apply to one tool: its own first, then the profile defaults,
 * unless the tool opted out. Order matters, so a tool can shadow a default.
 */
export function rulesFor(profile: Profile, tool: string): FaultRule[] {
  const own = profile.tools[tool];
  if (!own) return [...profile.forced, ...profile.defaults];
  const rest = own.inheritDefaults ? [...own.faults, ...profile.defaults] : own.faults;
  return [...profile.forced, ...rest];
}

/**
 * Environment overrides, applied after the file is loaded. These exist because
 * MCP clients configure servers through `env`, not through argv.
 */
export interface EnvOverrides {
  FAULTMCP_SEED?: string;
  FAULTMCP_FORCE?: string;
  FAULTMCP_PROBABILITY?: string;
}

export function applyEnvOverrides(profile: Profile, env: EnvOverrides): Profile {
  let next: Profile = { ...profile, tools: { ...profile.tools } };

  if (env.FAULTMCP_SEED !== undefined) {
    const seed = Number.parseInt(env.FAULTMCP_SEED, 10);
    if (!Number.isFinite(seed)) throw new ProfileError(`FAULTMCP_SEED is not an integer: ${env.FAULTMCP_SEED}`);
    next = { ...next, seed };
  }

  if (env.FAULTMCP_FORCE !== undefined) {
    const kind = env.FAULTMCP_FORCE.trim() as FaultKind;
    if (!FAULT_KINDS.includes(kind)) {
      throw new ProfileError(`FAULTMCP_FORCE must be one of ${FAULT_KINDS.join(", ")}, got "${env.FAULTMCP_FORCE}"`);
    }
    const probability =
      env.FAULTMCP_PROBABILITY === undefined ? 1 : Number.parseFloat(env.FAULTMCP_PROBABILITY);
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new ProfileError(`FAULTMCP_PROBABILITY must be between 0 and 1, got "${env.FAULTMCP_PROBABILITY}"`);
    }
    const forced = FaultRuleSchema.parse({ kind, probability, note: "forced by FAULTMCP_FORCE" });
    next = { ...next, forced: [forced, ...next.forced] };
  }

  return next;
}
