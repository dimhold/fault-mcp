/**
 * faultmcp: an MCP server that injects tool faults on purpose.
 *
 * The library surface, for embedding the harness in your own test suite rather
 * than running it as a standalone server.
 */

export {
  applyEnvOverrides,
  EMPTY_PROFILE,
  FAULT_KINDS,
  FaultRuleSchema,
  loadProfile,
  parseProfile,
  ProfileError,
  ProfileSchema,
  rulesFor,
  type FaultKind,
  type FaultRule,
  type Profile,
  type ToolProfile,
} from "./config.js";

export { applyFault, corruptGenerically, truncate, violateSchema, type ApplyOptions } from "./faults.js";
export { Journal, summarise, type JournalEntry, type JournalOptions } from "./journal.js";
export { connectUpstream, parseUpstreamSpec, type Upstream, type UpstreamOptions } from "./proxy.js";
export { hashString, intBetween, mulberry32, pick, rngFor } from "./rng.js";
export { selectFault, type FaultDecision, type Roll, type SelectOptions } from "./selector.js";
export {
  createFaultServer,
  SERVER_NAME,
  SERVER_VERSION,
  type FaultServer,
  type FaultServerOptions,
} from "./server.js";
export { EXAMPLE_TOOLS, FAKE_FS, getAccountBalance, readFile, search } from "./tools/index.js";
export type { CallContext, ContentBlock, Rng, TextBlock, ToolDefinition, ToolResult } from "./types.js";
