/**
 * Drive the built server over stdio, the way a client would.
 *
 *   node .github/scripts/smoke.mjs [path/to/bin.js]
 *
 * The unit tests call the fault engine directly, which is what makes the
 * bytes assertable. It also means the server could stop speaking MCP
 * altogether and every test would still pass. This starts the real binary,
 * completes a real handshake and calls a real tool.
 *
 * The assertion that matters is the last one: with `--force corrupt` the tool
 * must come back **successful and wrong**. A fault injector whose quiet
 * faults are visible from the outside is not doing the one job it has.
 *
 * Written in Node rather than in the workflow, because the workflow's shell is
 * pwsh on Windows and bash everywhere else, and an exit code assertion spelled
 * two ways is an exit code assertion nobody trusts.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:process';

const NL = String.fromCharCode(10);
const BIN = process.argv[2] ?? 'dist/bin.js';
const SEED = 1337;

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) {
    console.log(`  ok    ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${name}`);
  const said = typeof detail === 'function' ? detail() : detail;
  if (said) console.log(String(said).split(NL).map((l) => `        ${l}`).join(NL));
};

console.log(`faultmcp smoke test on ${platform}, node ${process.versions.node}, against ${BIN}`);

const journal = join(mkdtempSync(join(tmpdir(), 'faultmcp-smoke-')), 'journal.jsonl');

/** Speak JSON-RPC over stdio and collect the responses to our requests. */
function talk(args, requests) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const seen = new Map();

    child.stdout.on('data', (chunk) => {
      out += chunk;
      // One JSON object per line is what the stdio transport writes. A partial
      // last line is simply not parsed yet.
      const lines = out.split(NL);
      out = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined) seen.set(msg.id, msg);
        } catch {
          // Not ours: anything that is not a complete JSON-RPC line is noise.
        }
      }
      if (seen.size === requests.length) child.kill();
    });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => resolve({ code, err, responses: seen }));

    for (const req of requests) child.stdin.write(`${JSON.stringify(req)}${NL}`);

    // A handshake that never completes must fail the job rather than hang it.
    setTimeout(() => child.kill(), 20_000);
  });
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'faultmcp-smoke', version: '0' },
  },
};
const listTools = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

// --- clean run: the server speaks MCP and its tools work ---------------------

const clean = await talk(['--profile', 'off'], [initialize, listTools]);

check('the server completes an initialize handshake', clean.responses.get(1)?.result !== undefined,
  () => clean.err || JSON.stringify(clean.responses.get(1)));

const tools = clean.responses.get(2)?.result?.tools;
check('tools/list returns at least one tool', Array.isArray(tools) && tools.length > 0,
  () => clean.err || JSON.stringify(clean.responses.get(2)));

const toolName = tools?.[0]?.name;
if (!toolName) {
  console.log(`${NL}${failures} problem(s)`);
  process.exit(1);
}

// outputSchema is hidden unless asked for, so that a strict client does not
// reject a schema fault at the transport boundary and leave you measuring the
// client instead of the agent.
check('outputSchema is hidden by default',
  tools.every((t) => t.outputSchema === undefined),
  () => `advertised on: ${tools.filter((t) => t.outputSchema !== undefined).map((t) => t.name).join(', ')}`);

// --- broken run: a quiet fault must be invisible from the outside ------------

const callTool = {
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name: toolName, arguments: {} },
};

const broken = await talk(
  ['--force', 'corrupt', '--probability', '1', '--seed', String(SEED), '--journal', journal],
  [initialize, listTools, callTool],
);

const call = broken.responses.get(3)?.result;
check('a forced corrupt call still returns a result', call !== undefined,
  () => broken.err || JSON.stringify(broken.responses.get(3)));

// This is the point of the package. A corrupted answer that arrives flagged
// as an error is a loud failure, and loud failures are the easy case.
check('the corrupted answer is NOT flagged as an error', call?.isError !== true,
  () => JSON.stringify(call));

check('the corrupted answer still has content', Array.isArray(call?.content) && call.content.length > 0,
  () => JSON.stringify(call));

// --- the journal is the ground truth ----------------------------------------

check('the journal file was written', existsSync(journal), journal);

if (existsSync(journal)) {
  const lines = readFileSync(journal, 'utf8').trim().split(NL).filter(Boolean);
  check('the journal has a line for the call', lines.length >= 1, `${lines.length} lines`);

  let entry = null;
  try {
    entry = JSON.parse(lines[lines.length - 1]);
  } catch (error) {
    check('the journal line is parseable JSON', false, error.message);
  }

  if (entry) {
    check('the journal names the fault that was injected', entry.fault === 'corrupt',
      () => JSON.stringify(entry));
    check('the journal records the seed, so the run replays', entry.seed === SEED,
      () => `seed in journal: ${entry.seed}`);
    check('the journal records what was handed back', entry.returned !== undefined,
      () => JSON.stringify(entry));
  }
}

console.log(failures === 0 ? `${NL}  ok    the server speaks MCP and lies quietly` : `${NL}${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
