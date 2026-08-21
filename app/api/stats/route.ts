import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type Product = { id?: string; seller_id?: string };
type SearchPage = { items?: Product[]; next_cursor?: string | null };
type McpResult = { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean };
type PlatformStats = { listings: number; sellers: number; updated_at: string };

const mcpEndpoint = process.env.MCP_SERVER_URL || "https://ai-hackaton.ru/mcp";
const cacheTtl = 5 * 60 * 1000;
let cachedStats: PlatformStats | undefined;
let cachedUntil = 0;
let statsInFlight: Promise<PlatformStats> | undefined;

function isRateLimited(reason: unknown) {
  return /RATE_LIMITED|Too many MCP requests|\b429\b/i.test(reason instanceof Error ? reason.message : String(reason));
}

function waitForMcp(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parsePage(result: McpResult): SearchPage {
  const structured = result.structuredContent;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    const value = structured as Record<string, unknown>;
    const page = (value.result && typeof value.result === "object" ? value.result : value) as SearchPage;
    return { items: Array.isArray(page.items) ? page.items : [], next_cursor: typeof page.next_cursor === "string" ? page.next_cursor : null };
  }
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) return { items: [], next_cursor: null };
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const page = (parsed.result && typeof parsed.result === "object" ? parsed.result : parsed) as SearchPage;
  return { items: Array.isArray(page.items) ? page.items : [], next_cursor: typeof page.next_cursor === "string" ? page.next_cursor : null };
}

async function callSearch(client: Client, args: Record<string, unknown>) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await client.callTool({ name: "search_products", arguments: args }) as McpResult;
      if (result.isError) throw new Error(result.content?.find((item) => item.type === "text")?.text || "Платформа отклонила запрос статистики");
      return parsePage(result);
    } catch (reason) {
      if (!isRateLimited(reason) || attempt === 2) throw reason;
      await waitForMcp(1_100 * (attempt + 1));
    }
  }
  throw new Error("Статистика временно недоступна");
}

async function loadStats() {
  const token = process.env.MCP_API_TOKEN;
  if (!token) throw new Error("Не настроен доступ к маркетплейсу");

  const client = new Client({ name: "ryadom-platform-stats", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpEndpoint), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const listingIds = new Set<string>();
  const sellerIds = new Set<string>();

  try {
    await client.connect(transport);
    for (const status of ["ACTIVE", "RESERVED", "SOLD"]) {
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
        const page = await callSearch(client, { status, sort: "created_desc", limit: 100, ...(cursor ? { cursor } : {}) });
        for (const product of page.items || []) {
          if (product.id) listingIds.add(product.id);
          if (product.seller_id) sellerIds.add(product.seller_id);
        }
        const nextCursor = page.next_cursor || undefined;
        if (!nextCursor || seenCursors.has(nextCursor)) break;
        seenCursors.add(nextCursor);
        cursor = nextCursor;
        await waitForMcp(1_100);
      }
      await waitForMcp(1_100);
    }
    return { listings: listingIds.size, sellers: sellerIds.size, updated_at: new Date().toISOString() };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function getStats() {
  if (cachedStats && Date.now() < cachedUntil) return cachedStats;
  if (!statsInFlight) {
    statsInFlight = loadStats().then((stats) => {
      cachedStats = stats;
      cachedUntil = Date.now() + cacheTtl;
      return stats;
    }).finally(() => { statsInFlight = undefined; });
  }
  return statsInFlight;
}

export async function GET() {
  try {
    const stats = await getStats();
    return NextResponse.json(stats, { headers: { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=60" } });
  } catch {
    return NextResponse.json({ error: "Не удалось обновить статистику платформы" }, { status: 502 });
  }
}
