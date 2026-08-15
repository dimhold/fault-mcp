import { hashString } from "../rng.js";
import type { ToolDefinition, ToolResult } from "../types.js";

/** A fake search index. Results are a pure function of the query string. */

const TOPICS = [
  "retry budgets",
  "idempotency keys",
  "partial reads",
  "stale caches",
  "rate limiting",
  "stream truncation",
  "clock skew",
  "silent coercion",
];

interface Hit {
  rank: number;
  title: string;
  url: string;
  snippet: string;
  score: number;
}

function hitsFor(query: string, limit: number): Hit[] {
  const base = hashString(query);
  return Array.from({ length: limit }, (_, i) => {
    const h = hashString(`${query}|${i}`);
    const topic = TOPICS[(base + i) % TOPICS.length] as string;
    return {
      rank: i + 1,
      title: `${topic} in production, part ${(h % 4) + 1}`,
      url: `https://example.test/notes/${(h % 9999).toString(36)}`,
      snippet: `Notes on ${topic}: what the call returned, what the caller assumed, and the gap between them.`,
      score: Number((1 - i * 0.11 - (h % 7) / 100).toFixed(3)),
    };
  });
}

function render(query: string, hits: Hit[]): ToolResult {
  const lines = hits.map((h) => `${h.rank}. ${h.title} (${h.score})\n   ${h.url}\n   ${h.snippet}`);
  return {
    content: [{ type: "text", text: `${hits.length} results for "${query}"\n\n${lines.join("\n")}` }],
    structuredContent: { query, count: hits.length, results: hits },
  };
}

export const search: ToolDefinition = {
  name: "search",
  title: "Search the notes index",
  description: "Search an internal notes index and return ranked results with scores.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Free text query" },
      limit: { type: "integer", minimum: 1, maximum: 10, description: "How many results to return (default 3)" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      count: { type: "integer" },
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            rank: { type: "integer" },
            title: { type: "string" },
            url: { type: "string" },
            snippet: { type: "string" },
            score: { type: "number" },
          },
          required: ["rank", "title", "url", "snippet", "score"],
        },
      },
    },
    required: ["query", "count", "results"],
    additionalProperties: false,
  },

  call(args) {
    const query = String(args["query"] ?? "").trim();
    if (!query) return { content: [{ type: "text", text: "query is required" }], isError: true };
    const rawLimit = Number(args["limit"] ?? 3);
    const limit = Number.isFinite(rawLimit) ? Math.min(10, Math.max(1, Math.trunc(rawLimit))) : 3;
    return render(query, hitsFor(query, limit));
  },

  /**
   * Results for a near-miss query, returned under the query that was asked. This
   * is the shape a normalisation bug takes: everything is well formed, the
   * ranking is sane, and the answer belongs to a different question.
   */
  corrupt(clean) {
    const query = String(clean.structuredContent?.["query"] ?? "");
    const count = Number(clean.structuredContent?.["count"] ?? 3);
    const shifted = query.length > 1 ? query.slice(0, -1) : `${query} `;
    const hits = hitsFor(shifted, count).map((hit, i) => ({ ...hit, rank: i + 1 }));
    return render(query, hits);
  },
};
