import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NextResponse } from "next/server";
import { getTestPaymentDetails, PaymentDetails, verifyTestPayment } from "../../../lib/sepolia";

export const dynamic = "force-dynamic";

type ChatMessage = { role: "user" | "assistant"; content: string };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type DeepSeekMessage = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };
type McpResult = { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean };
type Product = { id: string; title: string; description?: string; price: number | string; category: string; status?: string; seller_id?: string; image?: string };
type Order = { id: string; product_id?: string; status: string; product?: Product; created_at?: string; buyer_id?: string; seller_id?: string };
type Message = { id: string; product_id?: string; order_id?: string; sender_id?: string; receiver_id?: string; text: string; created_at?: string };
type AgentOffer = { message: Message; product: Product; order?: Order; offered_price?: number };
type SaleAction = { kind: "requested_order" | "rejected" | "reserved" | "wallet_sent" | "payment_pending" | "payment_invalid" | "sold"; product_id: string; order_id?: string; detail: string };

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
      name: "process_sales_inbox",
      description: "Автономно обработать продажи: применить правило цены 90%, ответить покупателям, принять лучший допустимый заказ, зарезервировать товар, отправить кошелёк Sepolia, проверить присланный хэш и завершить только финализированную оплату.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "start_purchase",
      description: "Автономно создать заказ на ACTIVE-товар и написать продавцу от имени покупателя. offered_price используется только как предложение в сообщении; MCP-заказ создаётся по цене объявления.",
      parameters: { type: "object", properties: { product_id: { type: "string" }, offered_price: { type: "number", exclusiveMinimum: 0 } }, required: ["product_id"] },
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

const systemPrompt = `Ты — автономный агент C2C-маркетплейса «Рядом». Отвечай по-русски, коротко и дружелюбно.
Твоя задача — искать товары и полностью вести разрешённые пользователем покупки и продажи через инструменты с реальными данными.
Если пользователь просит найти товар, сначала собери достаточные параметры: что ищем, категория, бюджет или диапазон цены, желаемый статус и предпочтительная сортировка. Категорию можно уверенно вывести из запроса, но бюджет при отсутствии уточни. Не вызывай поиск, пока запрос слишком общий.
ACTIVE — доступен для покупки, RESERVED — товар на холде, SOLD — продан, REMOVED — снят.
После поиска кратко объясни выбор. Не выдумывай товары, цены, изображения, id и статусы.
Пользователь делегировал тебе проведение сделок. Для покупки по выбранному товару используй start_purchase. Для проверки и ведения продаж используй process_sales_inbox; inspect_sales_inbox оставь для просмотра без действий. Если просит перепродать купленные товары — inspect_completed_purchases.
Цена из сообщения остаётся неформальным предложением, потому что MCP не хранит цену торга в заказе. Для продажи автоматически допустима цена не ниже 90% цены объявления; более высокая цена тоже допустима. Среди допустимых CREATED-заказов выбирай самый высокий. Цена ниже порога отклоняется с объяснением.
После accept_order товар становится RESERVED. Агент сообщает покупателю публичный кошелёк Ethereum Sepolia и просит полный хэш. Сделка завершается только когда транзакция успешна, адрес получателя совпал и блок финализирован. Затем агент подтверждает получение в сообщении и вызывает complete_order, переводя товар в SOLD. До этого не заявляй, что товар продан.
Текущий MCP не содержит цены предложения: все заказы создаются по цене объявления. После подтверждения заказ становится ACCEPTED, товар — RESERVED, остальные CREATED-заявки отменяются. Не обещай аукцион или приём новых заявок на RESERVED-товар. Если цены заказов равны, скажи об этом прямо.
Оплата в блокчейне используется только для демонстрации в тестовой сети Sepolia, тестовый ETH не имеет денежной ценности. Если просят адрес или оплату, вызови get_test_payment_details. Если пользователь прислал хэш, обязательно вызови verify_test_payment. Не говори, что перевод окончательно получен, если статус не confirmed, finalized не true, получатель не совпадает или хэш не найден. Не говори, что агент покупателя отправил перевод, пока кошелёк не вернул настоящий хэш транзакции.`;

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

function extractTransactionHash(text: string) {
  return text.match(/0x[0-9a-fA-F]{64}/)?.[0];
}

function wasSent(messages: Message[], profileId: string, receiverId: string | undefined, fragment: string) {
  return messages.some((message) => message.sender_id === profileId && (!receiverId || message.receiver_id === receiverId) && message.text.includes(fragment));
}

async function processSalesInbox() {
  return withMcp(async (client) => {
    const [profile, products, orders] = await Promise.all([
      callChecked<{ id: string }>(client, "get_my_profile"),
      callChecked<Product[]>(client, "get_my_products", { limit: 50 }),
      callChecked<Order[]>(client, "get_my_orders", { role: "seller", limit: 100 }),
    ]);
    const payment = getTestPaymentDetails();
    const productList = Array.isArray(products) ? products.filter((product) => ["ACTIVE", "RESERVED"].includes(product.status || "ACTIVE")) : [];
    const orderList = Array.isArray(orders) ? orders : [];
    const actions: SaleAction[] = [];
    const observedOffers: AgentOffer[] = [];

    for (const product of productList.slice(0, 24)) {
      const listedPrice = Number(product.price);
      if (!Number.isFinite(listedPrice) || listedPrice <= 0) continue;
      const minimumPrice = listedPrice * 0.9;
      const messages = await callChecked<Message[]>(client, "get_messages", { product_id: product.id, limit: 100 }).catch(() => [] as Message[]);
      const productMessages = Array.isArray(messages) ? messages : [];
      const productOrders = orderList.filter((order) => order.product_id === product.id && ["CREATED", "ACCEPTED"].includes(order.status));
      const accepted = productOrders.find((order) => order.status === "ACCEPTED");

      if (accepted?.buyer_id) {
        const conversation = productMessages.filter((message) => message.sender_id === accepted.buyer_id || message.receiver_id === accepted.buyer_id);
        const walletMarker = `Кошелёк Sepolia: ${payment.address}`;
        if (!wasSent(conversation, profile.id, accepted.buyer_id, walletMarker)) {
          await callChecked(client, "send_message", {
            product_id: product.id,
            order_id: accepted.id,
            receiver_id: accepted.buyer_id,
            text: `Товар «${product.title}» зарезервирован за вами. Для тестовой оплаты переведите ${payment.amount_eth} SepoliaETH. ${walletMarker}. Сеть: Ethereum Sepolia, Chain ID ${payment.chain_id}. После отправки пришлите полный хэш транзакции 0x…`,
          });
          actions.push({ kind: "wallet_sent", product_id: product.id, order_id: accepted.id, detail: "Покупателю отправлены реквизиты Sepolia" });
        }

        const transactionHash = conversation
          .filter((message) => message.sender_id === accepted.buyer_id)
          .map((message) => extractTransactionHash(message.text))
          .find(Boolean);
        if (!transactionHash) continue;
        const verification = await verifyTestPayment(transactionHash);
        const transaction = verification.transaction;
        if (transaction?.status === "confirmed" && transaction.finalized && transaction.recipient_matches) {
          const successMarker = `Оплата подтверждена и финализирована: ${transactionHash}`;
          if (!wasSent(conversation, profile.id, accepted.buyer_id, successMarker)) {
            await callChecked(client, "send_message", {
              product_id: product.id,
              order_id: accepted.id,
              receiver_id: accepted.buyer_id,
              text: `${successMarker}. Средства получены, спасибо! Сделка завершена, товар отмечен как проданный.`,
            });
          }
          await callChecked(client, "complete_order", { order_id: accepted.id });
          actions.push({ kind: "sold", product_id: product.id, order_id: accepted.id, detail: "Транзакция финализирована, товар переведён в SOLD" });
        } else if (transaction?.status === "pending" || (transaction?.status === "confirmed" && !transaction.finalized)) {
          actions.push({ kind: "payment_pending", product_id: product.id, order_id: accepted.id, detail: "Транзакция найдена, агент ждёт финализации" });
        } else if (transaction && !wasSent(conversation, profile.id, accepted.buyer_id, `Проверка транзакции ${transactionHash}`)) {
          await callChecked(client, "send_message", {
            product_id: product.id,
            order_id: accepted.id,
            receiver_id: accepted.buyer_id,
            text: `Проверка транзакции ${transactionHash}: платёж не подтверждён или отправлен не на указанный кошелёк. Товар остаётся в резерве; пришлите корректный хэш после успешного перевода.`,
          });
          actions.push({ kind: "payment_invalid", product_id: product.id, order_id: accepted.id, detail: "Покупателю запрошен корректный платёж" });
        }
        continue;
      }

      const created = productOrders.filter((order) => order.status === "CREATED" && order.buyer_id).map((order) => {
        const buyerMessages = productMessages.filter((message) => message.sender_id === order.buyer_id);
        const offeredPrice = buyerMessages.map((message) => extractOfferPrice(message.text)).find((value) => value !== undefined) ?? listedPrice;
        const message = buyerMessages[0];
        if (message) observedOffers.push({ message, product, order, offered_price: offeredPrice });
        return { order, offeredPrice, message };
      }).sort((left, right) => right.offeredPrice - left.offeredPrice);

      const eligible = created.filter((candidate) => candidate.offeredPrice >= minimumPrice);
      for (const candidate of created.filter((item) => item.offeredPrice < minimumPrice)) {
        const buyerId = candidate.order.buyer_id;
        if (!buyerId) continue;
        const rejectionMarker = `минимально допустимая цена — ${minimumPrice.toFixed(2)} ₽`;
        if (!wasSent(productMessages, profile.id, buyerId, rejectionMarker)) {
          await callChecked(client, "send_message", { product_id: product.id, order_id: candidate.order.id, receiver_id: buyerId, text: `Спасибо за предложение ${candidate.offeredPrice.toFixed(2)} ₽. Оно ниже допустимого порога: ${rejectionMarker}. Заказ отклонён.` });
        }
        await callChecked(client, "cancel_order", { order_id: candidate.order.id });
        actions.push({ kind: "rejected", product_id: product.id, order_id: candidate.order.id, detail: "Предложение ниже 90% цены объявления" });
      }

      const best = eligible[0];
      if (best?.order.buyer_id) {
        await callChecked(client, "accept_order", { order_id: best.order.id });
        actions.push({ kind: "reserved", product_id: product.id, order_id: best.order.id, detail: `Принято лучшее предложение ${best.offeredPrice.toFixed(2)} ₽` });
        await callChecked(client, "send_message", {
          product_id: product.id,
          order_id: best.order.id,
          receiver_id: best.order.buyer_id,
          text: `Предложение ${best.offeredPrice.toFixed(2)} ₽ принято. Товар «${product.title}» зарезервирован за вами. Для тестовой оплаты переведите ${payment.amount_eth} SepoliaETH. Кошелёк Sepolia: ${payment.address}. Сеть: Ethereum Sepolia, Chain ID ${payment.chain_id}. После отправки пришлите полный хэш транзакции 0x…`,
        });
        actions.push({ kind: "wallet_sent", product_id: product.id, order_id: best.order.id, detail: "Покупателю отправлены реквизиты Sepolia" });
        continue;
      }

      const buyersWithoutOrder = new Map<string, Message>();
      for (const message of productMessages) {
        if (message.sender_id && message.sender_id !== profile.id && !buyersWithoutOrder.has(message.sender_id)) buyersWithoutOrder.set(message.sender_id, message);
      }
      for (const [buyerId, message] of buyersWithoutOrder) {
        const offeredPrice = extractOfferPrice(message.text);
        if (offeredPrice !== undefined && offeredPrice < minimumPrice) {
          const marker = `минимально допустимая цена — ${minimumPrice.toFixed(2)} ₽`;
          if (!wasSent(productMessages, profile.id, buyerId, marker)) {
            await callChecked(client, "send_message", { product_id: product.id, receiver_id: buyerId, text: `Спасибо за предложение ${offeredPrice.toFixed(2)} ₽. Оно ниже допустимого порога: ${marker}. Если готовы повысить цену, напишите новое предложение.` });
            actions.push({ kind: "rejected", product_id: product.id, detail: "Торг ниже порога отклонён в сообщениях" });
          }
        } else if (!wasSent(productMessages, profile.id, buyerId, "создайте заказ")) {
          const agreed = offeredPrice ?? listedPrice;
          await callChecked(client, "send_message", { product_id: product.id, receiver_id: buyerId, text: `Товар «${product.title}» доступен. Предложение ${agreed.toFixed(2)} ₽ подходит. Пожалуйста, создайте заказ — после этого агент зарезервирует товар и пришлёт реквизиты оплаты.` });
          actions.push({ kind: "requested_order", product_id: product.id, detail: "Покупателю предложено создать заказ" });
        }
      }
    }

    return { actions, offers: observedOffers.slice(0, 30), products: productList, orders: orderList };
  });
}

async function startPurchase(args: Record<string, unknown>) {
  const productId = typeof args.product_id === "string" ? args.product_id : "";
  if (!productId) throw new Error("Нужен id товара из результатов поиска");
  return withMcp(async (client) => {
    const product = await callChecked<Product>(client, "get_product", { product_id: productId });
    if ((product.status || "ACTIVE") !== "ACTIVE") throw new Error("Товар уже недоступен для нового заказа");
    const listedPrice = Number(product.price);
    const requestedPrice = Number(args.offered_price);
    const offeredPrice = Number.isFinite(requestedPrice) && requestedPrice > 0 ? requestedPrice : listedPrice;
    const order = await callChecked<Order>(client, "create_order", { product_id: product.id });
    await callChecked(client, "send_message", {
      product_id: product.id,
      order_id: order.id,
      text: `Здравствуйте! Мой агент создал заказ на «${product.title}» и предлагает ${offeredPrice.toFixed(2)} ₽. Если предложение подходит, подтвердите заказ и пришлите реквизиты Ethereum Sepolia. После тестового перевода агент отправит хэш транзакции.`,
    });
    return { order, product, offered_price: offeredPrice };
  });
}

async function callAgentTool(name: string, args: Record<string, unknown>) {
  if (name === "inspect_sales_inbox") return inspectSalesInbox();
  if (name === "process_sales_inbox") return processSalesInbox();
  if (name === "start_purchase") return startPurchase(args);
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
    const body = await request.json() as { messages?: unknown; automation?: unknown };
    if (body.automation === "sales") return NextResponse.json(await processSalesInbox());
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "Агент пока не настроен" }, { status: 503 });
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
          if (call.function.name === "process_sales_inbox" && value && typeof value === "object") {
            const processed = value as { offers?: AgentOffer[]; orders?: Order[] };
            foundOffers = Array.isArray(processed.offers) ? processed.offers : [];
            foundOrders = Array.isArray(processed.orders) ? processed.orders : [];
          }
          if (call.function.name === "start_purchase" && value && typeof value === "object") {
            const purchase = value as { order?: Order; product?: Product };
            foundOrders = purchase.order ? [purchase.order] : [];
            foundProducts = purchase.product ? await hydrateProducts([purchase.product]) : [];
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
