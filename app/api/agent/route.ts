import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type ChatMessage = { role: "user" | "assistant"; content: string };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type DeepSeekMessage = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };
type McpResult = { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean };
type Product = { id: string; title: string; description?: string; price: number | string; category: string; status?: string; seller_id?: string; image?: string };
type Order = { id: string; product_id?: string; status: string; product?: Product; created_at?: string; buyer_id?: string; seller_id?: string };

const mcpEndpoint = process.env.MCP_SERVER_URL || "https://ai-hackaton.ru/mcp";
const allowedAgentTools = new Set(["search_products", "get_product", "get_my_products", "get_my_orders"]);

const tools = [
  {
    type: "function",
    function: {
      name: "search_products",
      description: "Найти реальные объявления. Для поиска товаров на холде используй status RESERVED, обычный поиск — ACTIVE.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", maxLength: 200 },
          category: { type: "string", enum: ["electronics", "computers", "phones", "gaming", "transport", "home", "clothes", "other"] },
          min_price: { type: "number", minimum: 0 },
          max_price: { type: "number", minimum: 0 },
          status: { type: "string", enum: ["ACTIVE", "RESERVED", "SOLD", "REMOVED"] },
          sort: { type: "string", enum: ["created_desc", "created_asc", "price_asc", "price_desc"] },
          limit: { type: "integer", minimum: 1, maximum: 12 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_product",
      description: "Получить подробности выбранного товара по id.",
      parameters: { type: "object", properties: { product_id: { type: "string" } }, required: ["product_id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_my_products",
      description: "Найти объявления текущего продавца, в том числе товары на холде.",
      parameters: { type: "object", properties: { status: { type: "string", enum: ["ACTIVE", "RESERVED", "SOLD", "REMOVED"] }, limit: { type: "integer", minimum: 1, maximum: 100 } } },
    },
  },
  {
    type: "function",
    function: {
      name: "get_my_orders",
      description: "Получить заказы текущего пользователя. role seller — входящие предложения, buyer — покупки.",
      parameters: { type: "object", properties: { role: { type: "string", enum: ["all", "buyer", "seller"] }, status: { type: "string", enum: ["CREATED", "ACCEPTED", "CANCELLED", "COMPLETED"] }, limit: { type: "integer", minimum: 1, maximum: 100 } } },
    },
  },
];

const systemPrompt = `Ты — агент C2C-маркетплейса «Рядом». Отвечай по-русски, коротко и дружелюбно.
Твоя задача — помогать искать товары и разбирать заказы через инструменты с реальными данными.
Если пользователь просит найти товар, сначала собери достаточные параметры: что ищем, категория, бюджет или диапазон цены, желаемый статус и предпочтительная сортировка. Категорию можно уверенно вывести из запроса, но бюджет при отсутствии уточни. Не вызывай поиск, пока запрос слишком общий.
ACTIVE — доступен для покупки, RESERVED — товар на холде, SOLD — продан, REMOVED — снят.
После поиска кратко объясни выбор. Не выдумывай товары, цены, изображения, id и статусы.
Ты не выполняешь денежные или изменяющие состояние действия самостоятельно. Карточки интерфейса дадут пользователю кнопки создания и подтверждения заказа.
Текущий MCP не содержит цены предложения: все заказы создаются по цене объявления. После подтверждения заказ становится ACCEPTED, товар — RESERVED, остальные CREATED-заявки отменяются. Не обещай аукцион или приём новых заявок на RESERVED-товар. Если цены заказов равны, скажи об этом прямо.`;

function unwrap<T>(result: McpResult): T {
  const structured = result.structuredContent as Record<string, unknown> | undefined;
  if (structured) return (structured.result ?? structured.items ?? structured) as T;
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) return [] as T;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown> | T;
    return (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.result ?? parsed.items ?? parsed : parsed) as T;
  } catch { return text as T; }
}

async function withMcp<T>(operation: (client: Client) => Promise<T>) {
  const token = process.env.MCP_API_TOKEN;
  if (!token) throw new Error("Не настроен доступ к маркетплейсу");
  const client = new Client({ name: "ryadom-search-agent", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpEndpoint), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  try { await client.connect(transport); return await operation(client); }
  finally { await client.close().catch(() => undefined); }
}

async function callMarketplaceTool(name: string, args: Record<string, unknown>) {
  if (!allowedAgentTools.has(name)) throw new Error("Инструмент агенту недоступен");
  return withMcp(async (client) => {
    const result = await client.callTool({ name, arguments: args }) as McpResult;
    if (result.isError) throw new Error(result.content?.find((item) => item.type === "text")?.text || "Платформа отклонила запрос");
    return result;
  });
}

async function hydrateProducts(products: Product[]) {
  return Promise.all(products.slice(0, 8).map(async (product) => {
    try {
      const result = await withMcp((client) => client.callTool({ name: "get_product_images", arguments: { product_id: product.id } })) as McpResult;
      const images = unwrap<Array<{ url?: string }>>(result);
      return { ...product, image: images?.[0]?.url };
    } catch { return product; }
  }));
}

function safeError(reason: unknown) {
  const raw = reason instanceof Error ? reason.message : "Не удалось выполнить запрос агента";
  if (/401|unauthorized|authentication|api key/i.test(raw)) return "DeepSeek отклонил ключ доступа. Проверьте настройку ключа.";
  if (/balance|insufficient/i.test(raw)) return "На балансе DeepSeek недостаточно средств.";
  return raw.length > 500 ? "Агент временно недоступен. Попробуйте ещё раз." : raw;
}

export async function POST(request: Request) {
  try {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "Агент пока не настроен" }, { status: 503 });
    const body = await request.json() as { messages?: unknown };
    if (!Array.isArray(body.messages)) return NextResponse.json({ error: "Нужна история диалога" }, { status: 400 });
    const history = body.messages.slice(-18).filter((item): item is ChatMessage => Boolean(item && typeof item === "object" && ["user", "assistant"].includes((item as ChatMessage).role) && typeof (item as ChatMessage).content === "string")).map((item) => ({ role: item.role, content: item.content.slice(0, 4000) }));
    if (!history.length || history.at(-1)?.role !== "user") return NextResponse.json({ error: "Последнее сообщение должно быть от пользователя" }, { status: 400 });

    const messages: DeepSeekMessage[] = [{ role: "system", content: systemPrompt }, ...history];
    let foundProducts: Product[] = [];
    let foundOrders: Order[] = [];
    let finalText = "Не получилось сформировать ответ. Попробуйте уточнить запрос.";

    for (let step = 0; step < 5; step += 1) {
      const response = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: "deepseek-v4-flash", messages, tools, tool_choice: "auto", thinking: { type: "disabled" }, temperature: 0.2, max_tokens: 900, stream: false }),
      });
      const responseText = await response.text();
      if (!response.ok) throw new Error(responseText || `DeepSeek: ${response.status}`);
      const completion = JSON.parse(responseText) as { choices?: Array<{ message?: { role?: "assistant"; content?: string | null; tool_calls?: ToolCall[] } }> };
      const answer = completion.choices?.[0]?.message;
      if (!answer) throw new Error("DeepSeek вернул пустой ответ");
      const calls = answer.tool_calls || [];
      messages.push({ role: "assistant", content: answer.content ?? null, tool_calls: calls.length ? calls : undefined });
      if (!calls.length) { finalText = answer.content?.trim() || finalText; break; }

      for (const call of calls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>; }
        catch { /* DeepSeek will receive the tool error and can recover. */ }
        try {
          const result = await callMarketplaceTool(call.function.name, args);
          const value = unwrap<unknown>(result);
          if (call.function.name === "search_products" || call.function.name === "get_my_products") {
            const list = Array.isArray(value) ? value as Product[] : [];
            foundProducts = await hydrateProducts(list);
          }
          if (call.function.name === "get_product" && value && !Array.isArray(value) && typeof value === "object") foundProducts = await hydrateProducts([value as Product]);
          if (call.function.name === "get_my_orders") foundOrders = Array.isArray(value) ? value as Order[] : [];
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(value).slice(0, 24000) });
        } catch (reason) {
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: safeError(reason) }) });
        }
      }
    }

    return NextResponse.json({ message: finalText, products: foundProducts, orders: foundOrders });
  } catch (reason) {
    return NextResponse.json({ error: safeError(reason) }, { status: 502 });
  }
}
