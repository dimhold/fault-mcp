import { appendFileSync } from "node:fs";
import type { FaultRule } from "./config.js";
import type { ToolResult } from "./types.js";

/**
 * The journal is the ground truth of a run.
 *
 * When an agent hands you an answer, the only way to know whether the answer
 * matches what the tool returned is to have recorded what the tool returned. The
 * journal is that record, written before the result leaves the process, in JSONL
 * so you can diff it against the transcript afterwards.
 *
 * It never goes to stdout: stdout belongs to the MCP stdio transport.
 */

export interface JournalEntry {
  ts: string;
  tool: string;
  callIndex: number;
  seed: number;
  /** null when the call was served clean. */
  fault: FaultRule["kind"] | null;
  rule: FaultRule | null;
  args: Record<string, unknown>;
  returned: {
    isError: boolean;
    blocks: number;
    text: string;
    structuredContent?: unknown;
  };
  durationMs: number;
}

export interface JournalOptions {
  /** Append JSONL here. */
  file?: string;
  /** Mirror a one-line summary to stderr. On by default. */
  stderr?: boolean;
  /** Injected in tests. */
  write?: (line: string) => void;
}

export class Journal {
  readonly entries: JournalEntry[] = [];
  private readonly file?: string;
  private readonly toStderr: boolean;
  private readonly write?: (line: string) => void;
  private fileBroken = false;

  constructor(options: JournalOptions = {}) {
    this.file = options.file;
    this.toStderr = options.stderr ?? true;
    this.write = options.write;
  }

  record(entry: JournalEntry): void {
    this.entries.push(entry);
    const line = JSON.stringify(entry);

    if (this.write) this.write(line);

    if (this.file && !this.fileBroken) {
      try {
        appendFileSync(this.file, `${line}\n`, "utf8");
      } catch (error) {
        this.fileBroken = true;
        process.stderr.write(`faultmcp: journal file unusable (${(error as Error).message}); continuing\n`);
      }
    }

    if (this.toStderr) {
      const verdict = entry.fault ? `fault=${entry.fault}` : "clean";
      process.stderr.write(
        `faultmcp ${entry.tool}#${entry.callIndex} ${verdict} ${entry.durationMs}ms ${preview(entry.returned.text)}\n`,
      );
    }
  }
}

function preview(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "<empty>";
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

export function summarise(result: ToolResult): JournalEntry["returned"] {
  const text = result.content
    .map((block) => (block.type === "text" ? String((block as { text?: unknown }).text ?? "") : `<${block.type}>`))
    .join("\n");
  const out: JournalEntry["returned"] = {
    isError: result.isError === true,
    blocks: result.content.length,
    text,
  };
  if (result.structuredContent !== undefined) out.structuredContent = result.structuredContent;
  return out;
}
