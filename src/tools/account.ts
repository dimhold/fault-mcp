import { hashString } from "../rng.js";
import type { ToolDefinition, ToolResult } from "../types.js";

/**
 * A fake ledger. Balances are derived from the account id, so the same account
 * always returns the same number and a corrupted answer is provably different.
 */

const CURRENCIES = ["USD", "EUR", "PLN"] as const;
const EPOCH = Date.UTC(2026, 0, 1);

function ledgerFor(accountId: string) {
  const h = hashString(accountId);
  const balanceMinor = (h % 90_000_00) + 1_000_00;
  const currency = CURRENCIES[h % CURRENCIES.length] as string;
  const asOf = new Date(EPOCH + (h % 200) * 86_400_000).toISOString().slice(0, 10);
  return { account_id: accountId, currency, balance_minor: balanceMinor, as_of: asOf };
}

function render(row: ReturnType<typeof ledgerFor>): ToolResult {
  const major = (row.balance_minor / 100).toFixed(2);
  return {
    content: [{ type: "text", text: `${row.account_id}: ${major} ${row.currency} cleared as of ${row.as_of}` }],
    structuredContent: { ...row },
  };
}

export const getAccountBalance: ToolDefinition = {
  name: "get_account_balance",
  title: "Get account balance",
  description:
    "Return the cleared balance of a ledger account. This is the only source for the balance; do not estimate it.",
  inputSchema: {
    type: "object",
    properties: {
      account_id: { type: "string", description: "Account identifier, for example ACC-4471" },
    },
    required: ["account_id"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      account_id: { type: "string" },
      currency: { type: "string" },
      balance_minor: { type: "integer", description: "Balance in minor units (cents)" },
      as_of: { type: "string", description: "ISO date the balance was cleared" },
    },
    required: ["account_id", "currency", "balance_minor", "as_of"],
    additionalProperties: false,
  },

  call(args) {
    const accountId = String(args["account_id"] ?? "").trim();
    if (!accountId) {
      return { content: [{ type: "text", text: "account_id is required" }], isError: true };
    }
    return render(ledgerFor(accountId));
  },

  /**
   * The cache-key bug: the row for a neighbouring account, returned under the
   * requested account's id. Right shape, right currency, right date format,
   * wrong money. Nothing in the response says so.
   */
  corrupt(clean) {
    const requested = String(clean.structuredContent?.["account_id"] ?? "unknown");
    const neighbour = ledgerFor(`${requested}#prev`);
    return render({ ...neighbour, account_id: requested });
  },
};
