import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs, resolveProfilePath } from "../src/cli.js";
import { parseUpstreamSpec } from "../src/proxy.js";

const PROFILES_DIR = resolve(import.meta.dirname, "..", "profiles");

describe("parseArgs", () => {
  it("defaults to serving the examples with no faults", () => {
    const args = parseArgs([]);
    expect(args).toMatchObject({ examples: true, quiet: false, advertiseOutputSchema: false, help: false });
    expect(args.profile).toBeUndefined();
  });

  it("reads values for the flags that take one", () => {
    const args = parseArgs(["--profile", "chaos", "--seed", "42", "--journal", "run.jsonl", "--force", "corrupt"]);
    expect(args).toMatchObject({ profile: "chaos", seed: "42", journal: "run.jsonl", force: "corrupt" });
  });

  it("handles the boolean flags", () => {
    const args = parseArgs(["--quiet", "--no-examples", "--advertise-output-schema"]);
    expect(args).toMatchObject({ quiet: true, examples: false, advertiseOutputSchema: true });
  });

  it("rejects an unknown option instead of ignoring it", () => {
    expect(() => parseArgs(["--chaos-monkey"])).toThrow(/unknown option/);
  });

  it("rejects a value flag with nothing after it", () => {
    expect(() => parseArgs(["--profile"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--profile", "--quiet"])).toThrow(/needs a value/);
  });
});

describe("resolveProfilePath", () => {
  it("resolves a bare name against the bundled profiles", () => {
    expect(resolveProfilePath("chaos", PROFILES_DIR)).toBe(resolve(PROFILES_DIR, "chaos.json"));
  });

  it("finds a bundled YAML profile by bare name", () => {
    expect(resolveProfilePath("per-tool", PROFILES_DIR)).toBe(resolve(PROFILES_DIR, "per-tool.yaml"));
  });

  it("treats anything with a path or an extension as a path", () => {
    expect(resolveProfilePath("./my-profile.yaml", PROFILES_DIR)).toBe(resolve("./my-profile.yaml"));
    expect(resolveProfilePath("profiles/custom.json", PROFILES_DIR)).toBe(resolve("profiles/custom.json"));
  });
});

describe("parseUpstreamSpec", () => {
  it("splits a plain command", () => {
    expect(parseUpstreamSpec("npx -y @modelcontextprotocol/server-filesystem /tmp")).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    });
  });

  it("keeps quoted segments together", () => {
    expect(parseUpstreamSpec('node "./my server.js" --port 1')).toEqual({
      command: "node",
      args: ["./my server.js", "--port", "1"],
    });
  });

  it("rejects an empty spec", () => {
    expect(() => parseUpstreamSpec("   ")).toThrow(/needs a command/);
  });
});
