import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyEnvOverrides,
  EMPTY_PROFILE,
  loadProfile,
  type EnvOverrides,
  type Profile,
} from "./config.js";
import { Journal } from "./journal.js";
import { connectUpstream, parseUpstreamSpec } from "./proxy.js";
import { createFaultServer, SERVER_VERSION } from "./server.js";
import { EXAMPLE_TOOLS } from "./tools/index.js";
import type { ToolDefinition } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLED_PROFILES = resolve(HERE, "..", "profiles");

const USAGE = `faultmcp ${SERVER_VERSION}: an MCP server that injects tool faults on purpose

Usage:
  faultmcp [options]

Options:
  --profile <path>      Fault profile (.json, .yaml, .yml). Bare names resolve
                        against the bundled profiles, e.g. --profile quiet-corruption
  --seed <int>          Override the profile seed
  --force <kind>        Force one fault on every call: error, corrupt, latency,
                        truncate, schema, empty
  --probability <0..1>  Probability for --force (default 1)
  --journal <path>      Append every call to this JSONL file
  --quiet               Do not mirror the journal to stderr
  --upstream "<cmd>"    Proxy a real MCP server and inject faults into its results
  --prefix <string>     Prefix for proxied tool names (default: none)
  --no-examples         Serve only proxied tools
  --advertise-output-schema
                        Publish outputSchema in tools/list. Strict clients will
                        then reject the schema fault before the agent sees it.
  --list-profiles       Print the bundled profiles and exit
  --help                Print this and exit

Environment (for MCP client configs, which pass env rather than argv):
  FAULTMCP_PROFILE, FAULTMCP_SEED, FAULTMCP_FORCE, FAULTMCP_PROBABILITY,
  FAULTMCP_JOURNAL, FAULTMCP_UPSTREAM
`;

interface Args {
  profile?: string;
  seed?: string;
  force?: string;
  probability?: string;
  journal?: string;
  quiet: boolean;
  upstream?: string;
  prefix?: string;
  examples: boolean;
  advertiseOutputSchema: boolean;
  listProfiles: boolean;
  help: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { quiet: false, examples: true, advertiseOutputSchema: false, listProfiles: false, help: false };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      i++;
      return next;
    };

    switch (flag) {
      case "--profile":
        args.profile = value();
        break;
      case "--seed":
        args.seed = value();
        break;
      case "--force":
        args.force = value();
        break;
      case "--probability":
        args.probability = value();
        break;
      case "--journal":
        args.journal = value();
        break;
      case "--quiet":
        args.quiet = true;
        break;
      case "--upstream":
        args.upstream = value();
        break;
      case "--prefix":
        args.prefix = value();
        break;
      case "--no-examples":
        args.examples = false;
        break;
      case "--advertise-output-schema":
        args.advertiseOutputSchema = true;
        break;
      case "--list-profiles":
        args.listProfiles = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`unknown option: ${flag}`);
    }
  }

  return args;
}

const PROFILE_EXTENSIONS = [".json", ".yaml", ".yml"] as const;

/** Bare names resolve against the bundled profiles; anything else is a path. */
export function resolveProfilePath(name: string, bundledDir = BUNDLED_PROFILES): string {
  if (name.includes("/") || name.includes("\\") || /\.(json|ya?ml)$/i.test(name)) {
    return resolve(name);
  }
  for (const ext of PROFILE_EXTENSIONS) {
    const candidate = join(bundledDir, `${name}${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  return join(bundledDir, `${name}.json`);
}

function listProfiles(): string[] {
  try {
    return readdirSync(BUNDLED_PROFILES)
      .filter((file) => /\.(json|ya?ml)$/i.test(file))
      .map((file) => file.replace(/\.(json|ya?ml)$/i, ""))
      .sort();
  } catch {
    return [];
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  if (args.listProfiles) {
    const names = listProfiles();
    process.stdout.write(names.length ? `${names.join("\n")}\n` : "no bundled profiles found\n");
    return;
  }

  const profilePath = args.profile ?? process.env["FAULTMCP_PROFILE"];
  let profile: Profile = profilePath ? loadProfile(resolveProfilePath(profilePath)) : EMPTY_PROFILE;

  // Flags win over env, because env is how a client config pins a default and a
  // flag is how you override it for one run.
  const overrides: EnvOverrides = {};
  const seed = args.seed ?? process.env["FAULTMCP_SEED"];
  const force = args.force ?? process.env["FAULTMCP_FORCE"];
  const probability = args.probability ?? process.env["FAULTMCP_PROBABILITY"];
  if (seed !== undefined) overrides.FAULTMCP_SEED = seed;
  if (force !== undefined) overrides.FAULTMCP_FORCE = force;
  if (probability !== undefined) overrides.FAULTMCP_PROBABILITY = probability;

  profile = applyEnvOverrides(profile, overrides);

  const tools: ToolDefinition[] = args.examples ? [...EXAMPLE_TOOLS] : [];
  let closeUpstream: (() => Promise<void>) | undefined;

  const upstreamSpec = args.upstream ?? process.env["FAULTMCP_UPSTREAM"];
  if (upstreamSpec) {
    const { command, args: commandArgs } = parseUpstreamSpec(upstreamSpec);
    const upstream = await connectUpstream({
      command,
      args: commandArgs,
      ...(args.prefix ? { prefix: args.prefix } : {}),
    });
    tools.push(...upstream.tools);
    closeUpstream = upstream.close;
    process.stderr.write(`faultmcp: proxying ${upstream.tools.length} tool(s) from "${upstreamSpec}"\n`);
  }

  if (tools.length === 0) {
    throw new Error("no tools to serve: drop --no-examples or supply --upstream");
  }

  const journalFile = args.journal ?? process.env["FAULTMCP_JOURNAL"];
  const journal = new Journal({
    ...(journalFile ? { file: journalFile } : {}),
    stderr: !args.quiet,
  });

  const { server } = createFaultServer({
    profile,
    tools,
    journal,
    advertiseOutputSchema: args.advertiseOutputSchema,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `faultmcp: serving ${tools.length} tool(s), seed=${profile.seed}, profile=${profilePath ?? "none"}\n`,
  );

  const shutdown = async () => {
    await server.close().catch(() => undefined);
    await closeUpstream?.().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
