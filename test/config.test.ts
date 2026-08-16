import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { applyEnvOverrides, loadProfile, parseProfile, ProfileError, rulesFor } from "../src/config.js";

const PROFILES_DIR = resolve(import.meta.dirname, "..", "profiles");

describe("parseProfile", () => {
  it("accepts an empty profile and fills in the defaults", () => {
    const profile = parseProfile({});
    expect(profile.seed).toBe(1337);
    expect(profile.defaults).toEqual([]);
    expect(profile.tools).toEqual({});
  });

  it("fills in per-kind defaults", () => {
    const profile = parseProfile({ defaults: [{ kind: "truncate" }, { kind: "empty" }] });
    expect(profile.defaults[0]).toMatchObject({ kind: "truncate", keep: 8, suffix: "", probability: 1 });
    expect(profile.defaults[1]).toMatchObject({ kind: "empty", style: "empty-string" });
  });

  it("rejects an unknown fault kind", () => {
    expect(() => parseProfile({ defaults: [{ kind: "explode" }] })).toThrow(ProfileError);
  });

  it("rejects a probability outside 0..1", () => {
    expect(() => parseProfile({ defaults: [{ kind: "error", probability: 1.5 }] })).toThrow(ProfileError);
    expect(() => parseProfile({ defaults: [{ kind: "error", probability: -0.1 }] })).toThrow(ProfileError);
  });

  it("rejects an unknown field, so typos are not silently ignored", () => {
    expect(() => parseProfile({ defaults: [{ kind: "truncate", kepp: 4 }] })).toThrow(ProfileError);
    expect(() => parseProfile({ tols: {} })).toThrow(ProfileError);
  });

  it("rejects a non-integer seed", () => {
    expect(() => parseProfile({ seed: 1.5 })).toThrow(ProfileError);
  });

  it("names the offending path in the message", () => {
    expect(() => parseProfile({ defaults: [{ kind: "error", probability: 9 }] })).toThrow(/defaults\.0\.probability/);
  });
});

describe("rulesFor", () => {
  const profile = parseProfile({
    defaults: [{ kind: "corrupt", probability: 0.1 }],
    tools: {
      search: { faults: [{ kind: "error" }] },
      read_file: { faults: [{ kind: "latency" }], inheritDefaults: false },
    },
  });

  it("gives a tool with no entry the defaults", () => {
    expect(rulesFor(profile, "get_account_balance").map((r) => r.kind)).toEqual(["corrupt"]);
  });

  it("puts the tool's own rules ahead of the defaults", () => {
    expect(rulesFor(profile, "search").map((r) => r.kind)).toEqual(["error", "corrupt"]);
  });

  it("drops the defaults when the tool opts out", () => {
    expect(rulesFor(profile, "read_file").map((r) => r.kind)).toEqual(["latency"]);
  });

  it("puts forced rules first, even for a tool that opted out", () => {
    const forced = applyEnvOverrides(profile, { FAULTMCP_FORCE: "empty" });
    expect(rulesFor(forced, "read_file").map((r) => r.kind)).toEqual(["empty", "latency"]);
    expect(rulesFor(forced, "search").map((r) => r.kind)).toEqual(["empty", "error", "corrupt"]);
  });
});

describe("applyEnvOverrides", () => {
  const base = parseProfile({ seed: 1 });

  it("overrides the seed", () => {
    expect(applyEnvOverrides(base, { FAULTMCP_SEED: "77" }).seed).toBe(77);
  });

  it("rejects a non-numeric seed", () => {
    expect(() => applyEnvOverrides(base, { FAULTMCP_SEED: "soon" })).toThrow(ProfileError);
  });

  it("forces a fault at full probability by default", () => {
    const forced = applyEnvOverrides(base, { FAULTMCP_FORCE: "corrupt" });
    expect(forced.forced[0]).toMatchObject({ kind: "corrupt", probability: 1 });
  });

  it("accepts a probability for the forced fault", () => {
    const forced = applyEnvOverrides(base, { FAULTMCP_FORCE: "corrupt", FAULTMCP_PROBABILITY: "0.3" });
    expect(forced.forced[0]).toMatchObject({ probability: 0.3 });
  });

  it("rejects an unknown forced kind", () => {
    expect(() => applyEnvOverrides(base, { FAULTMCP_FORCE: "melt" })).toThrow(/must be one of/);
  });

  it("rejects a probability outside 0..1", () => {
    expect(() => applyEnvOverrides(base, { FAULTMCP_FORCE: "empty", FAULTMCP_PROBABILITY: "4" })).toThrow(ProfileError);
  });

  it("leaves the input profile alone", () => {
    const snapshot = structuredClone(base);
    applyEnvOverrides(base, { FAULTMCP_SEED: "9", FAULTMCP_FORCE: "error" });
    expect(base).toEqual(snapshot);
  });
});

describe("bundled profiles", () => {
  const files = readdirSync(PROFILES_DIR).filter((f) => /\.(json|ya?ml)$/i.test(f));

  it("ships at least one profile of each format", () => {
    expect(files.some((f) => f.endsWith(".json"))).toBe(true);
    expect(files.some((f) => /\.ya?ml$/i.test(f))).toBe(true);
  });

  it.each(files)("%s parses and validates", (file) => {
    const profile = loadProfile(join(PROFILES_DIR, file));
    expect(Number.isInteger(profile.seed)).toBe(true);
  });

  it("reports a readable error for a missing file", () => {
    expect(() => loadProfile(join(PROFILES_DIR, "not-a-profile.json"))).toThrow(/cannot read profile/);
  });
});
