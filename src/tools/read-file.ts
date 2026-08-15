import type { ToolDefinition, ToolResult } from "../types.js";

/**
 * An in-memory filesystem. Nothing touches the real disk: a fault injector that
 * reads a caller's files would be a liability, and a fixed corpus makes the
 * clean answer and the corrupted one directly comparable.
 *
 * Each file carries a `stale` revision, which is what the `corrupt` fault serves.
 */

interface FakeFile {
  current: string;
  stale: string;
}

export const FAKE_FS: Record<string, FakeFile> = {
  "/etc/app/config.yaml": {
    current: ["service: billing", "region: eu-central-1", "timeout_ms: 3000", "retries: 2"].join("\n"),
    stale: ["service: billing", "region: us-east-1", "timeout_ms: 3000", "retries: 2"].join("\n"),
  },
  "/srv/reports/q3-summary.md": {
    current: [
      "# Q3 summary",
      "",
      "Revenue: 412,900 EUR",
      "Churn: 3.1%",
      "Open incidents at quarter end: 2",
    ].join("\n"),
    stale: [
      "# Q3 summary (draft)",
      "",
      "Revenue: 398,400 EUR",
      "Churn: 3.1%",
      "Open incidents at quarter end: 2",
    ].join("\n"),
  },
  "/var/log/deploy.log": {
    current: [
      "2026-08-14T09:12:04Z deploy start rev=7c1a9f4",
      "2026-08-14T09:13:41Z migration applied 0042_add_ledger_index",
      "2026-08-14T09:14:02Z deploy ok rev=7c1a9f4",
    ].join("\n"),
    stale: [
      "2026-08-13T18:02:11Z deploy start rev=1b88e30",
      "2026-08-13T18:03:55Z migration applied 0041_backfill_accounts",
      "2026-08-13T18:04:10Z deploy ok rev=1b88e30",
    ].join("\n"),
  },
};

function render(path: string, contents: string): ToolResult {
  return {
    content: [{ type: "text", text: contents }],
    structuredContent: { path, bytes: Buffer.byteLength(contents, "utf8"), contents },
  };
}

export const readFile: ToolDefinition = {
  name: "read_file",
  title: "Read a file",
  description:
    "Read a file from the workspace and return its contents. Paths are absolute. Use `list_files` output or a known path.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: `Absolute path. Available: ${Object.keys(FAKE_FS).join(", ")}`,
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      bytes: { type: "integer" },
      contents: { type: "string" },
    },
    required: ["path", "bytes", "contents"],
    additionalProperties: false,
  },

  call(args) {
    const path = String(args["path"] ?? "").trim();
    const file = FAKE_FS[path];
    if (!file) {
      // A genuine error, not an injected one. The distinction is the point.
      return {
        content: [{ type: "text", text: `ENOENT: no such file or directory, open '${path}'` }],
        isError: true,
      };
    }
    return render(path, file.current);
  },

  /** The previous revision of the same file, served under the current path. */
  corrupt(clean) {
    const path = String(clean.structuredContent?.["path"] ?? "");
    const file = FAKE_FS[path];
    if (!file) return clean;
    return render(path, file.stale);
  },
};
