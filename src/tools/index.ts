import type { ToolDefinition } from "../types.js";
import { getAccountBalance } from "./account.js";
import { readFile } from "./read-file.js";
import { search } from "./search.js";

/**
 * The tools faultmcp ships with, so the harness is usable before you wire up
 * anything of your own. All three are pure functions of their arguments: no
 * network, no disk, no clock.
 */
export const EXAMPLE_TOOLS: ToolDefinition[] = [getAccountBalance, search, readFile];

export { getAccountBalance, search, readFile };
export { FAKE_FS } from "./read-file.js";
