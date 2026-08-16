#!/usr/bin/env node
import { main } from "./cli.js";

main().catch((error: unknown) => {
  process.stderr.write(`faultmcp: ${(error as Error).message ?? String(error)}\n`);
  process.exit(1);
});
