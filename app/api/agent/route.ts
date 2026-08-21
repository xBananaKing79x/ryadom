import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NextResponse } from "next/server";
import { formatEther, getAddress, isAddress, isHash } from "viem";

export const dynamic = "force-dynamic";

type ChatMessage = { role: "user" | "assistant"; content: string };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type DeepSeekMessage = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };
type McpResult = { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean };
type Product = { id: string; title: string; description?: string; price: number | string; category: string; status?: string; seller_id?: string; image?: string };
type Order = { id: string; product_id?: string; status: string; product?: Product; created_at?: string; buyer_id?: string; seller_id?: string };
type Message = { id: string; product_id?: string; order_id?: string; sender_id?: string; receiver_id?: string; text: string; created_at?: string };
type AgentOffer = { message: Message; product: Product; order?: Order; offered_price?: number };
type PaymentDetails = { network: "Sepolia"; chain_id: 11155111; address: string; amount_eth: string; value_wei_hex: string; explorer_url: string; faucet_url: string; transaction?: { hash: string; status: "pending" | "confirmed" | "failed" | "not_found"; recipient_matches: boolean; amount_eth?: string; block_number?: number; explorer_url: string } };

const mcpEndpoint = process.env.MCP_SERVER_URL || "https://ai-hackaton.ru/mcp";
const allowedAgentTools = new Set(["search_products", "get_product", "get_my_products", "get_my_orders"]);
const sepoliaChainId = 11155111 as const;
const sepoliaAmountEth = "0.0001";
const sepoliaValueWeiHex = "0x5af3107a4000";

function paymentAddress() {
  const value = process.env.SEPOLIA_PAYMENT_ADDRESS || "";
  if (!isAddress(value)) throw new Error("Тестовый платёжный адрес пока не настроен");
  return getAddress(value);
}

function getTestPaymentDetails(): PaymentDetails {
  const address = paymentAddress();
  return { network: "Sepolia", chain_id: sepoliaChainId, address, amount_eth: sepoliaAmountEth, value_wei_hex: sepoliaValueWeiHex, explorer_url: `https://sepolia.etherscan.io/address/${address}`, faucet_url: "https://ethereum.org/developers/docs/networks/#sepolia" };
}

async function verifyTestPayment(hashValue: unknown): Promise<PaymentDetails> {
  const hash = typeof hashValue === "string" ? hashValue.trim() : "";
  if (!isHash(hash)) throw new Error("Нужен полный Ethereum-хэш вида 0x… длиной 66 символов");
  const details = getTestPaymentDetails();
  const rpcUrl = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
  const rpc = async (method: string) => {
    const response = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [hash] }) });
    if (!response.ok) throw new Error("Не удалось связаться с сетью Sepolia");
    const payload = await response.json() as { result?: Record<string, string> | null; error?: { message?: string } };
    if (payload.error) throw new Error(payload.error.message || "Sepolia RPC отклонил запрос");
    return payload.result || null;
  };
  const [transaction, receipt] = await Promise.all([rpc("eth_getTransactionByHash"), rpc("eth_getTransactionReceipt")]);
  const explorerUrl = `https://sepolia.etherscan.io/tx/${hash}`;
  if (!transaction) return { ...details, transaction: { hash, status: "not_found", recipient_matches: false, explorer_url: explorerUrl } };
  const recipientMatches = typeof transaction.to === "string" && transaction.to.toLowerCase() === details.address.toLowerCase();
  const value = typeof transaction.value === "string" ? transaction.value : undefined;
  const status = !receipt ? "pending" : receipt.status === "0x1" ? "confirmed" : "failed";
  return { ...details, transaction: { hash, status, recipient_matches: recipientMatches, amount_eth: value ? formatEther(BigInt(value)) : undefined, block_number: receipt?.blockNumber ? Number(BigInt(receipt.blockNumber)) : undefined, explorer_url: explorerUrl } };
}

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
  {
    type: "function",
    function: {
      name: "inspect_sales_inbox",
      description: "Проверить входящие сообщения по своим товарам, найти вопросы о доступности и предложения цены, связать их с заказами. Используй для разбора торга и сообщений покупателей.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_completed_purchases",
      description: "Найти завершённые покупки текущего пользователя, которые можно повторно выставить с наценкой 15%.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_test_payment_details",
      description: "Показать реквизиты тестовой оплаты в Ethereum Sepolia. Возвращает адрес, фиксированную тестовую сумму и ссылку на explorer.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "verify_test_payment",
      description: "Проверить состояние тестовой Sepolia-транзакции по полному хэшу, адрес получателя и сумму.",
      parameters: { type: "object", properties: { transaction_hash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" } }, required: ["transaction_hash"] },
    },
  },
];

const systemPrompt = `Ты — агент C2C-маркетплейса «Рядом». Отвечай по-русски, коротко и дружелюбно.
Твоя задача — помогать искать товары и разбирать заказы через инструменты с реальными данными.
Если пользователь просит найти товар, сначала собери достаточные параметры: что ищем, категория, бюджет или диапазон цены, желаемый статус и предпочтительная сортировка. Категорию можно уверенно вывести из запроса, но бюджет при отсутствии уточни. Не вызывай поиск, пока запрос слишком общий.
ACTIVE — доступен для покупки, RESERVED — товар на холде, SOLD — продан, REMOVED — снят.
После поиска кратко объясни выбор. Не выдумывай товары, цены, изображения, id и статусы.
Ты не выполняешь денежные или изменяющие состояние действия самостоятельно. Карточки интерфейса дадут пользователю кнопки создания и подтверждения заказа.
Если пользователь просит проверить сообщения, торг или предложения покупателей, обязательно вызови inspect_sales_inbox. Если просит перепродать купленные товары — inspect_completed_purchases.
Цена, написанная покупателем в сообщении, является неформальным предложением. Никогда не называй её ценой заказа. Если она ниже цены объявления, предложи продавцу резерв и отдельное согласование; не заявляй, что продажа подтверждена.
Текущий MCP не содержит цены предложения: все заказы создаются по цене объявления. После подтверждения заказ становится ACCEPTED, товар — RESERVED, остальные CREATED-заявки отменяются. Не обещай аукцион или приём новых заявок на RESERVED-товар. Если цены заказов равны, скажи об этом прямо.
Оплата в блокчейне используется только для демонстрации в тестовой сети Sepolia, тестовый ETH не имеет денежной ценности. Если просят адрес или оплату, вызови get_test_payment_details. Если пользователь прислал хэш, обязательно вызови verify_test_payment. Не говори, что перевод подтверждён, если статус не confirmed, получатель не совпадает или хэш не найден. Не говори, что агент отправил перевод, пока интерфейс кошелька не вернул настоящий хэш транзакции.`;

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

async function callChecked<T>(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }) as McpResult;
  if (result.isError) throw new Error(result.content?.find((item) => item.type === "text")?.text || "Платформа отклонила запрос");
  return unwrap<T>(result);
}

function extractOfferPrice(text: string) {
  const match = text.match(/(?:за|предлагаю|готов(?:а)?|куплю|дам|цена)[^\d]{0,24}(\d[\d\s,.]{1,14})\s*(?:₽|руб(?:л(?:ей|я)?)?)/i)
    ?? text.match(/(\d[\d\s,.]{1,14})\s*(?:₽|руб(?:л(?:ей|я)?)?)/i);
  if (!match) return undefined;
  const value = Number(match[1].replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function inspectSalesInbox() {
  return withMcp(async (client) => {
    const [profile, products, orders] = await Promise.all([
      callChecked<{ id: string }>(client, "get_my_profile"),
      callChecked<Product[]>(client, "get_my_products", { limit: 50 }),
      callChecked<Order[]>(client, "get_my_orders", { role: "seller", limit: 100 }),
    ]);
    const productList = Array.isArray(products) ? products.filter((product) => ["ACTIVE", "RESERVED"].includes(product.status || "ACTIVE")) : [];
    const orderList = Array.isArray(orders) ? orders : [];
    const batches = await Promise.all(productList.slice(0, 24).map(async (product) => {
      const messages = await callChecked<Message[]>(client, "get_messages", { product_id: product.id, limit: 50 }).catch(() => [] as Message[]);
      return (Array.isArray(messages) ? messages : []).filter((message) => message.sender_id && message.sender_id !== profile.id).map((message): AgentOffer => {
        const order = orderList.find((item) => item.product_id === product.id && item.buyer_id === message.sender_id && ["CREATED", "ACCEPTED"].includes(item.status));
        return { message, product, order, offered_price: extractOfferPrice(message.text) };
      });
    }));
    const offers = batches.flat().sort((left, right) => String(right.message.created_at || "").localeCompare(String(left.message.created_at || "")));
    return { offers: offers.slice(0, 30), products: productList, orders: orderList };
  });
}

async function inspectCompletedPurchases() {
  return withMcp(async (client) => {
    const orders = await callChecked<Order[]>(client, "get_my_orders", { role: "buyer", status: "COMPLETED", limit: 100 });
    const products = (Array.isArray(orders) ? orders : []).map((order) => order.product).filter((product): product is Product => Boolean(product?.id));
    return { orders, products };
  });
}

async function callAgentTool(name: string, args: Record<string, unknown>) {
  if (name === "inspect_sales_inbox") return inspectSalesInbox();
  if (name === "inspect_completed_purchases") return inspectCompletedPurchases();
  if (name === "get_test_payment_details") return getTestPaymentDetails();
  if (name === "verify_test_payment") return verifyTestPayment(args.transaction_hash);
  if (!allowedAgentTools.has(name)) throw new Error("Инструмент агенту недоступен");
  return withMcp((client) => callChecked<unknown>(client, name, args));
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
    let foundOffers: AgentOffer[] = [];
    let relistCandidates: Product[] = [];
    let payment: PaymentDetails | undefined;
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
          const value = await callAgentTool(call.function.name, args);
          if (call.function.name === "search_products" || call.function.name === "get_my_products") {
            const list = Array.isArray(value) ? value as Product[] : [];
            foundProducts = await hydrateProducts(list);
          }
          if (call.function.name === "get_product" && value && !Array.isArray(value) && typeof value === "object") foundProducts = await hydrateProducts([value as Product]);
          if (call.function.name === "get_my_orders") foundOrders = Array.isArray(value) ? value as Order[] : [];
          if (call.function.name === "inspect_sales_inbox" && value && typeof value === "object") {
            const inspected = value as { offers?: AgentOffer[]; orders?: Order[] };
            foundOffers = Array.isArray(inspected.offers) ? inspected.offers : [];
            foundOrders = Array.isArray(inspected.orders) ? inspected.orders : [];
          }
          if (call.function.name === "inspect_completed_purchases" && value && typeof value === "object") {
            const inspected = value as { products?: Product[] };
            relistCandidates = await hydrateProducts(Array.isArray(inspected.products) ? inspected.products : []);
          }
          if ((call.function.name === "get_test_payment_details" || call.function.name === "verify_test_payment") && value && typeof value === "object") payment = value as PaymentDetails;
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(value).slice(0, 24000) });
        } catch (reason) {
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: safeError(reason) }) });
        }
      }
    }

    return NextResponse.json({ message: finalText, products: foundProducts, orders: foundOrders, offers: foundOffers, relist_candidates: relistCandidates, payment });
  } catch (reason) {
    return NextResponse.json({ error: safeError(reason) }, { status: 502 });
  }
}
