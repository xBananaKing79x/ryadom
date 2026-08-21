import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NextResponse } from "next/server";
import { getTestPaymentDetails, PaymentDetails, quoteRubPriceInEth, sendTestPayment, verifyPaymentTotal, verifyTestPayment } from "../../../lib/sepolia";

export const dynamic = "force-dynamic";

type ChatMessage = { role: "user" | "assistant"; content: string };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type DeepSeekMessage = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };
type McpResult = { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean };
type Product = { id: string; title: string; description?: string; price: number | string; category: string; status?: string; seller_id?: string; image?: string };
type Profile = { id: string; first_name?: string; last_name?: string };
type Order = { id: string; product_id?: string; status: string; product?: Product; created_at?: string; buyer_id?: string; seller_id?: string };
type Message = { id: string; product_id?: string; order_id?: string; sender_id?: string; receiver_id?: string; text: string; created_at?: string };
type AgentOffer = { message: Message; product: Product; order?: Order; offered_price?: number };
type ListingInput = { title: string; description: string; price: number; category: Product["category"] };
type WebListingRequest = { product_name: string; condition?: string; notes?: string; category?: Product["category"] };
type SaleAction = { kind: "requested_order" | "rejected" | "reserved" | "wallet_sent" | "payment_pending" | "payment_invalid" | "sold" | "buyer_offer" | "reserve_requested" | "wallet_requested" | "payment_sent"; product_id: string; order_id?: string; detail: string };

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
      name: "search_products_by_seller_name",
      description: "Найти объявления по имени, фамилии или полному имени продавца. Сопоставляет реальные профили продавцов с их объявлениями.",
      parameters: {
        type: "object",
        properties: {
          seller_name: { type: "string", minLength: 2, maxLength: 160, description: "Имя, фамилия или полное имя продавца" },
          query: { type: "string", maxLength: 200, description: "Необязательный поиск по названию товара" },
          category: { type: "string", enum: ["electronics", "computers", "phones", "gaming", "transport", "home", "clothes", "other"] },
          min_price: { type: "number", minimum: 0 },
          max_price: { type: "number", minimum: 0 },
          status: { type: "string", enum: ["ACTIVE", "RESERVED", "SOLD", "REMOVED"] },
          sort: { type: "string", enum: ["created_desc", "created_asc", "price_asc", "price_desc"] },
          limit: { type: "integer", minimum: 1, maximum: 12 },
        },
        required: ["seller_name"],
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
      name: "create_products_batch",
      description: "Последовательно опубликовать от 1 до 25 полностью описанных товаров. Продолжает цикл, даже если отдельная позиция завершилась ошибкой.",
      parameters: {
        type: "object",
        properties: {
          products: { type: "array", minItems: 1, maxItems: 25, items: { type: "object", properties: { title: { type: "string", maxLength: 200 }, description: { type: "string", maxLength: 4000 }, price: { type: "number", exclusiveMinimum: 0 }, category: { type: "string", enum: ["electronics", "computers", "phones", "gaming", "transport", "home", "clothes", "other"] } }, required: ["title", "description", "price", "category"] } },
        },
        required: ["products"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "research_and_create_products",
      description: "Найти в интернете актуальное описание и ориентир цены, подобрать изображение из Wikimedia Commons, затем последовательно создать до 5 объявлений и загрузить изображения.",
      parameters: {
        type: "object",
        properties: {
          products: { type: "array", minItems: 1, maxItems: 5, items: { type: "object", properties: { product_name: { type: "string", minLength: 2, maxLength: 200 }, condition: { type: "string", maxLength: 500 }, notes: { type: "string", maxLength: 1000 }, category: { type: "string", enum: ["electronics", "computers", "phones", "gaming", "transport", "home", "clothes", "other"] } }, required: ["product_name"] } },
        },
        required: ["products"],
      },
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
      name: "process_purchase_orders",
      description: "Автономно продолжить покупки: торговаться, проверить резерв, найти кошелёк, проверить зафиксированный расчёт цены объявления в ETH и отправить точную сумму SepoliaETH с хэшем в чат.",
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

const systemPrompt = `Ты — автономный агент C2C-маркетплейса «Рядом». Отвечай по-русски, коротко и дружелюбно.
Твоя задача — искать товары и полностью вести разрешённые пользователем покупки и продажи через инструменты с реальными данными.
Если пользователь просит найти товар, сначала собери достаточные параметры: что ищем, категория, бюджет или диапазон цены, желаемый статус и предпочтительная сортировка. Категорию можно уверенно вывести из запроса, но бюджет при отсутствии уточни. Не вызывай поиск, пока запрос слишком общий. Если пользователь называет имя или фамилию продавца, используй search_products_by_seller_name; не пытайся искать имя продавца как название товара.
ACTIVE — доступен для покупки, RESERVED — товар на холде, SOLD — продан, REMOVED — снят.
После поиска кратко объясни выбор. Не выдумывай товары, цены, изображения, id и статусы.
Пользователь делегировал тебе проведение сделок. Для покупки по выбранному товару используй start_purchase, а для продолжения торга, резерва и оплаты — process_purchase_orders. Для проверки и ведения продаж используй process_sales_inbox; inspect_sales_inbox оставь для просмотра без действий. Если просит перепродать купленные товары — inspect_completed_purchases.
Для публикации одного или нескольких полностью заполненных товаров используй create_products_batch. Если пользователь просит найти описание, цену и картинку в интернете, используй research_and_create_products. Перед публикацией уточни модель товара и состояние, если они не указаны. Не выдумывай результаты веб-поиска и не заявляй об успешной публикации без результата инструмента.
Цена из сообщения остаётся неформальным предложением, потому что MCP не хранит цену торга в заказе. Покупатель начинает торг с 70% цены объявления. Для продажи автоматически допустима цена не ниже 90% цены объявления; более высокая цена тоже допустима. Среди допустимых CREATED-заказов выбирай самый высокий. На цену ниже порога продавец сообщает минимальную допустимую цену и оставляет заказ открытым для продолжения торга.
После accept_order агент продавца обязан повторно проверить: заказ стал ACCEPTED, товар стал RESERVED. Только затем он фиксирует spot-курс ETH/RUB, пересчитывает цену объявления в ETH, сообщает расчёт и публичный кошелёк Ethereum Sepolia. Агент покупателя считает подтверждением продавца только свежие статусы ACCEPTED и RESERVED, отвечает на каждый новый комментарий продавца и просит снять товар с открытой продажи через RESERVED. Перед каждым переводом он проверяет уже отправленные по этому заказу хэши и баланс кошелька; общая сумма всех отправленных транзакций не может превышать зафиксированную цену. Сделка завершается только когда правильный адрес получил всю сумму и блоки финализированы. Затем агент продавца подтверждает получение и вызывает complete_order. До этого не заявляй, что товар продан.
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

function extractTransactionHashes(messages: Message[]) {
  return [...new Set(messages.flatMap((message) => message.text.match(/0x[0-9a-fA-F]{64}/g) || []))];
}

function extractEthPaymentQuote(text: string) {
  const match = text.match(/Расчёт оплаты:\s*([\d\s.,]+)\s*₽\s*÷\s*([\d\s.,]+)\s*₽\/ETH\s*=\s*([\d.,]+)\s*(?:Sepolia)?ETH/i);
  if (!match) return undefined;
  const number = (value: string) => Number(value.replace(/\s/g, "").replace(",", "."));
  const rubAmount = number(match[1]);
  const ethRubRate = number(match[2]);
  const amountEth = number(match[3]);
  if (![rubAmount, ethRubRate, amountEth].every((value) => Number.isFinite(value) && value > 0)) return undefined;
  return { rub_amount: rubAmount, eth_rub_rate: ethRubRate, amount_eth: amountEth.toFixed(8) };
}

function quoteMatchesListing(quote: ReturnType<typeof extractEthPaymentQuote>, listedPrice: number) {
  if (!quote || Math.abs(quote.rub_amount - listedPrice) > 0.01) return false;
  return Math.abs(quote.rub_amount / quote.eth_rub_rate - Number(quote.amount_eth)) <= 0.00000001;
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
      for (const message of productMessages.filter((item) => item.sender_id && item.sender_id !== profile.id)) {
        const relatedOrder = productOrders.find((order) => order.id === message.order_id || order.buyer_id === message.sender_id);
        observedOffers.push({ message, product, order: relatedOrder, offered_price: extractOfferPrice(message.text) });
      }
      const accepted = productOrders.find((order) => order.status === "ACCEPTED");

      if (accepted?.buyer_id) {
        const reservedProduct = await callChecked<Product>(client, "get_product", { product_id: product.id });
        if (reservedProduct.status !== "RESERVED") {
          actions.push({ kind: "reserve_requested", product_id: product.id, order_id: accepted.id, detail: "Заказ подтверждён, но платформа ещё не вернула статус RESERVED" });
          continue;
        }
        const conversation = productMessages.filter((message) => message.sender_id === accepted.buyer_id || message.receiver_id === accepted.buyer_id);
        let lockedQuote = conversation.filter((message) => message.sender_id === profile.id).map((message) => extractEthPaymentQuote(message.text)).find((quote) => quoteMatchesListing(quote, listedPrice));
        const quoteMarker = `Расчёт оплаты: ${listedPrice.toFixed(2)} ₽`;
        if (!lockedQuote) {
          const quote = await quoteRubPriceInEth(listedPrice);
          lockedQuote = { rub_amount: Number(quote.rub_amount), eth_rub_rate: Number(quote.eth_rub_rate), amount_eth: quote.amount_eth };
          await callChecked(client, "send_message", {
            product_id: product.id,
            order_id: accepted.id,
            receiver_id: accepted.buyer_id,
            text: `Товар «${product.title}» зарезервирован за вами. ${quoteMarker} ÷ ${quote.eth_rub_rate} ₽/ETH = ${quote.amount_eth} ETH по spot-курсу Coinbase, зафиксированному ${quote.quoted_at}. Переведите ровно ${quote.amount_eth} SepoliaETH. Кошелёк Sepolia: ${payment.address}. Сеть: Ethereum Sepolia, Chain ID ${payment.chain_id}. После отправки пришлите полный хэш транзакции 0x…`,
          });
          actions.push({ kind: "wallet_sent", product_id: product.id, order_id: accepted.id, detail: `Покупателю отправлены реквизиты и расчёт ${quote.amount_eth} ETH` });
        }

        const transactionHashes = extractTransactionHashes(conversation.filter((message) => message.sender_id === accepted.buyer_id));
        if (!transactionHashes.length) continue;
        const paymentTotal = await verifyPaymentTotal(transactionHashes, { address: payment.address, amount_eth: lockedQuote.amount_eth });
        if (paymentTotal.total_finalized_matches) {
          const successMarker = `Оплата заказа подтверждена и финализирована: ${paymentTotal.total_finalized_eth} ETH`;
          if (!wasSent(conversation, profile.id, accepted.buyer_id, successMarker)) {
            await callChecked(client, "send_message", {
              product_id: product.id,
              order_id: accepted.id,
              receiver_id: accepted.buyer_id,
              text: `${successMarker}. Требовалось ${paymentTotal.expected_amount_eth} ETH по цене объявления. Сделка завершена, товар отмечен как проданный.`,
            });
          }
          await callChecked(client, "complete_order", { order_id: accepted.id });
          actions.push({ kind: "sold", product_id: product.id, order_id: accepted.id, detail: "Транзакция финализирована, товар переведён в SOLD" });
        } else if (paymentTotal.total_sent_matches && paymentTotal.has_pending) {
          actions.push({ kind: "payment_pending", product_id: product.id, order_id: accepted.id, detail: `Отправлено ${paymentTotal.total_sent_eth} ETH, агент ждёт финализации` });
        } else {
          const remainingMarker = `Недостающая сумма на кошельке продавца: ${paymentTotal.remaining_received_eth} ETH`;
          if (wasSent(conversation, profile.id, accepted.buyer_id, remainingMarker)) continue;
          await callChecked(client, "send_message", {
            product_id: product.id,
            order_id: accepted.id,
            receiver_id: accepted.buyer_id,
            text: `Проверены все хэши по заказу. На правильный кошелёк поступило ${paymentTotal.total_received_eth} ETH из ${paymentTotal.expected_amount_eth} ETH; всего по заказу отправлено ${paymentTotal.total_sent_eth} ETH. ${remainingMarker}. Товар остаётся в резерве, а агент покупателя не должен превышать общую цену объявления.`,
          });
          actions.push({ kind: "payment_invalid", product_id: product.id, order_id: accepted.id, detail: "Покупателю запрошена недостающая сумма" });
        }
        continue;
      }

      const created = productOrders.filter((order) => order.status === "CREATED" && order.buyer_id).map((order) => {
        const buyerMessages = productMessages.filter((message) => message.sender_id === order.buyer_id);
        const offeredPrice = buyerMessages.map((message) => extractOfferPrice(message.text)).find((value) => value !== undefined) ?? listedPrice;
        const message = buyerMessages[0];
        return { order, offeredPrice, message };
      }).sort((left, right) => right.offeredPrice - left.offeredPrice);

      const eligible = created.filter((candidate) => candidate.offeredPrice >= minimumPrice);
      for (const candidate of created.filter((item) => item.offeredPrice < minimumPrice)) {
        const buyerId = candidate.order.buyer_id;
        if (!buyerId) continue;
        const rejectionMarker = `минимально допустимая цена — ${minimumPrice.toFixed(2)} ₽`;
        const finalPriceMessage = productMessages.find((message) => message.sender_id === profile.id && message.receiver_id === buyerId && message.text.includes(rejectionMarker));
        const latestBuyerMessage = productMessages.find((message) => message.sender_id === buyerId);
        const latestBuyerOffer = latestBuyerMessage ? extractOfferPrice(latestBuyerMessage.text) : undefined;
        if (finalPriceMessage && latestBuyerMessage && messageTime(latestBuyerMessage) > messageTime(finalPriceMessage) && (isOfferDeclined(latestBuyerMessage.text) || (latestBuyerOffer !== undefined && latestBuyerOffer < minimumPrice))) {
          await callChecked(client, "cancel_order", { order_id: candidate.order.id });
          await callChecked(client, "send_message", { product_id: product.id, order_id: candidate.order.id, receiver_id: buyerId, text: `Не удалось договориться о минимальной цене ${minimumPrice.toFixed(2)} ₽, поэтому агент продавца отклонил заказ. Товар остаётся доступен другим покупателям.` });
          actions.push({ kind: "rejected", product_id: product.id, order_id: candidate.order.id, detail: "Заказ ниже финальной цены отклонён агентом" });
          continue;
        }
        if (!wasSent(productMessages, profile.id, buyerId, rejectionMarker)) {
          await callChecked(client, "send_message", { product_id: product.id, order_id: candidate.order.id, receiver_id: buyerId, text: `Спасибо за предложение ${candidate.offeredPrice.toFixed(2)} ₽. Оно ниже допустимого порога: ${rejectionMarker}. Это минимальная и финальная цена; заказ оставлен открытым для вашего ответа.` });
          actions.push({ kind: "rejected", product_id: product.id, order_id: candidate.order.id, detail: "Покупателю отправлена минимальная цена 90%; торг продолжается" });
        }
      }

      const best = eligible[0];
      if (best?.order.buyer_id) {
        await callChecked(client, "accept_order", { order_id: best.order.id });
        const [reservedProduct, acceptedOrder] = await Promise.all([
          callChecked<Product>(client, "get_product", { product_id: product.id }),
          callChecked<Order>(client, "get_order", { order_id: best.order.id }),
        ]);
        if (acceptedOrder.status !== "ACCEPTED" || reservedProduct.status !== "RESERVED") {
          throw new Error("Платформа не подтвердила перевод заказа в ACCEPTED и товара в RESERVED");
        }
        const quote = await quoteRubPriceInEth(listedPrice);
        actions.push({ kind: "reserved", product_id: product.id, order_id: best.order.id, detail: `Принято лучшее предложение ${best.offeredPrice.toFixed(2)} ₽` });
        await callChecked(client, "send_message", {
          product_id: product.id,
          order_id: best.order.id,
          receiver_id: best.order.buyer_id,
          text: `Предложение ${best.offeredPrice.toFixed(2)} ₽ принято. Товар «${product.title}» зарезервирован за вами. Расчёт оплаты: ${quote.rub_amount} ₽ ÷ ${quote.eth_rub_rate} ₽/ETH = ${quote.amount_eth} ETH по spot-курсу Coinbase, зафиксированному ${quote.quoted_at}. Переведите ровно ${quote.amount_eth} SepoliaETH. Кошелёк Sepolia: ${payment.address}. Сеть: Ethereum Sepolia, Chain ID ${payment.chain_id}. После отправки пришлите полный хэш транзакции 0x…`,
        });
        actions.push({ kind: "wallet_sent", product_id: product.id, order_id: best.order.id, detail: `Покупателю отправлены реквизиты и расчёт ${quote.amount_eth} ETH` });
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
    const offeredPrice = Number.isFinite(requestedPrice) && requestedPrice > 0 ? requestedPrice : Math.round(listedPrice * 0.7 * 100) / 100;
    const order = await callChecked<Order>(client, "create_order", { product_id: product.id });
    await callChecked(client, "send_message", {
      product_id: product.id,
      order_id: order.id,
      text: `Здравствуйте! Мой агент создал заказ на «${product.title}» и предлагает ${offeredPrice.toFixed(2)} ₽. Если предложение подходит, подтвердите заказ и пришлите реквизиты Ethereum Sepolia. После тестового перевода агент отправит хэш транзакции.`,
    });
    return { order, product, offered_price: offeredPrice };
  });
}

function extractWalletAddress(text: string) {
  return text.match(/0x[0-9a-fA-F]{40}/)?.[0];
}

function isFinalPrice(text: string) {
  return /финальн|окончательн|минимальн[^.]{0,24}цен|торг[ау] нет|без торга|ниже не (?:буду|могу)|снижени[юя] не подлежит|последн(?:яя|юю) цен/i.test(text);
}

function isOfferAccepted(text: string) {
  return /соглас(?:ен|на)|предложение (?:подходит|принято)|договорились|готов(?:а)? продать|цена подходит|устраивает/i.test(text);
}

function isOfferDeclined(text: string) {
  return /не соглас(?:ен|на)|не подходит|отказываюсь|не готов(?:а)?|дорого|отмен(?:яй|ите)|не буду покупать/i.test(text);
}

function messageTime(message?: Message) {
  return message?.created_at ? Date.parse(message.created_at) || 0 : 0;
}

async function processPurchaseOrders() {
  return withMcp(async (client) => {
    const [profile, orders] = await Promise.all([
      callChecked<{ id: string }>(client, "get_my_profile"),
      callChecked<Order[]>(client, "get_my_orders", { role: "buyer", limit: 100 }),
    ]);
    const orderList = Array.isArray(orders) ? orders.filter((order) => ["CREATED", "ACCEPTED"].includes(order.status)) : [];
    const actions: SaleAction[] = [];

    for (const order of orderList.slice(0, 24)) {
      const productId = order.product_id || order.product?.id;
      if (!productId) continue;
      const product = await callChecked<Product>(client, "get_product", { product_id: productId }).catch(() => order.product);
      if (!product) continue;
      const listedPrice = Number(product.price);
      if (!Number.isFinite(listedPrice) || listedPrice <= 0) continue;
      const sellerId = order.seller_id || product.seller_id;
      const messages = await callChecked<Message[]>(client, "get_messages", { product_id: productId, order_id: order.id, limit: 100 }).catch(() => [] as Message[]);
      const conversation = (Array.isArray(messages) ? messages : []).sort((left, right) => messageTime(right) - messageTime(left));
      const sellerMessages = conversation.filter((message) => message.sender_id && message.sender_id !== profile.id && (!sellerId || message.sender_id === sellerId));
      const buyerMessages = conversation.filter((message) => message.sender_id === profile.id);
      const transferredHashes = extractTransactionHashes(buyerMessages.filter((message) => /перевод|транзакц/i.test(message.text)));

      const latestSeller = sellerMessages[0];
      const latestBuyer = buyerMessages[0];
      const previousOffer = buyerMessages.map((message) => extractOfferPrice(message.text)).find((price) => price !== undefined);
      const sellerPrice = sellerMessages.map((message) => extractOfferPrice(message.text)).find((price) => price !== undefined);
      const walletFromMessages = sellerMessages.map((message) => extractWalletAddress(message.text)).find(Boolean);
      const walletFromDescription = extractWalletAddress(product.description || "");
      const wallet = walletFromMessages ?? walletFromDescription;
      const paymentQuote = sellerMessages.map((message) => extractEthPaymentQuote(message.text)).find((quote) => quoteMatchesListing(quote, listedPrice));
      const productReserved = product.status === "RESERVED" && order.status === "ACCEPTED";

      if (!productReserved) {
        if (!previousOffer) {
          const initialOffer = Math.round(listedPrice * 0.7 * 100) / 100;
          await callChecked(client, "send_message", { product_id: productId, order_id: order.id, text: `Предлагаю ${initialOffer.toFixed(2)} ₽ за «${product.title}». Если цена подходит, подтвердите заказ и переведите товар в резерв. Если нет — назовите минимальную или финальную цену.` });
          actions.push({ kind: "buyer_offer", product_id: productId, order_id: order.id, detail: `Начат торг с ${initialOffer.toFixed(2)} ₽` });
          continue;
        }

        if (latestSeller && messageTime(latestSeller) > messageTime(latestBuyer)) {
          const sellerStoppedBargaining = isFinalPrice(latestSeller.text);
          const sellerAccepted = isOfferAccepted(latestSeller.text);
          if (sellerStoppedBargaining || sellerAccepted || (sellerPrice !== undefined && sellerPrice <= previousOffer)) {
            const agreedPrice = sellerPrice ?? previousOffer;
            const marker = "Подтвердите заказ и снимите товар с открытой продажи, переведя его в статус RESERVED";
            if (!wasSent(conversation, profile.id, sellerId, marker)) {
              await callChecked(client, "send_message", { product_id: productId, order_id: order.id, text: `Принимаю ${agreedPrice.toFixed(2)} ₽${sellerStoppedBargaining ? " как финальную цену" : ""}. ${marker}. После резерва пришлите номер кошелька Ethereum Sepolia для тестового перевода.` });
              actions.push({ kind: "reserve_requested", product_id: productId, order_id: order.id, detail: `Согласована цена ${agreedPrice.toFixed(2)} ₽, запрошен резерв` });
            }
          } else if (sellerPrice !== undefined && sellerPrice > previousOffer) {
            const nextOffer = Math.min(listedPrice, Math.round((previousOffer + (sellerPrice - previousOffer) / 2) * 100) / 100);
            const marker = `Предлагаю ${nextOffer.toFixed(2)} ₽`;
            if (!wasSent(conversation, profile.id, sellerId, marker)) {
              await callChecked(client, "send_message", { product_id: productId, order_id: order.id, text: `${marker}. Это встречное предложение между моей ставкой и вашей ценой. Если ниже уже невозможно — напишите, что цена финальная.` });
              actions.push({ kind: "buyer_offer", product_id: productId, order_id: order.id, detail: `Отправлено встречное предложение ${nextOffer.toFixed(2)} ₽` });
            }
          } else {
            const commentMarker = `Спасибо за комментарий: «${latestSeller.text.slice(0, 120)}»`;
            if (!wasSent(conversation, profile.id, sellerId, commentMarker)) {
              await callChecked(client, "send_message", { product_id: productId, order_id: order.id, text: `${commentMarker}. Я продолжаю сделку. Если дополнительных условий нет, подтвердите заказ и снимите товар с открытой продажи, переведя его в RESERVED.` });
              actions.push({ kind: "reserve_requested", product_id: productId, order_id: order.id, detail: "Агент ответил на комментарий продавца и продолжил сделку" });
            }
          }
        }
        continue;
      }

      if (!wallet || !paymentQuote) {
        const marker = "пришлите номер кошелька Ethereum Sepolia и точный расчёт суммы ETH";
        if (!wasSent(conversation, profile.id, sellerId, marker)) {
          await callChecked(client, "send_message", { product_id: productId, order_id: order.id, text: `Товар зарезервирован. Пожалуйста, ${marker}: цена объявления ${listedPrice.toFixed(2)} ₽, курс ETH/RUB и итоговая сумма должны быть зафиксированы в сообщении сделки.` });
          actions.push({ kind: "wallet_requested", product_id: productId, order_id: order.id, detail: "У продавца запрошены кошелёк и расчёт ETH по цене объявления" });
        }
        continue;
      }

      const [freshProduct, freshOrder] = await Promise.all([
        callChecked<Product>(client, "get_product", { product_id: productId }),
        callChecked<Order>(client, "get_order", { order_id: order.id }),
      ]);
      if (freshProduct.status !== "RESERVED" || freshOrder.status !== "ACCEPTED") {
        await callChecked(client, "send_message", { product_id: productId, order_id: order.id, text: "Реквизиты получены, но продавец ещё не подтвердил заказ и не снял товар с открытой продажи. Подтвердите заказ: платформа должна вернуть ACCEPTED, а товар — RESERVED." });
        actions.push({ kind: "reserve_requested", product_id: productId, order_id: order.id, detail: "Перед оплатой повторно запрошен RESERVED" });
        continue;
      }

      const paymentTotal = transferredHashes.length ? await verifyPaymentTotal(transferredHashes, { address: wallet, amount_eth: paymentQuote.amount_eth }) : undefined;
      if (paymentTotal?.total_sent_matches) continue;
      const amountToSend = paymentTotal?.remaining_amount_eth || paymentQuote.amount_eth;
      const sent = await sendTestPayment(wallet, amountToSend);
      await callChecked(client, "send_message", {
        product_id: productId,
        order_id: order.id,
        text: `Тестовый перевод ${sent.amount_eth} SepoliaETH выполнен на кошелёк ${sent.to}. Ранее по этому заказу отправлено ${paymentTotal?.total_sent_eth || "0"} ETH; суммарный перевод не превышает ${paymentQuote.amount_eth} ETH. Хэш транзакции: ${sent.hash}. Проверьте статус в сети: ${sent.explorer_url}`,
      });
      actions.push({ kind: "payment_sent", product_id: productId, order_id: order.id, detail: `Тестовый перевод отправлен, хэш ${sent.hash}` });
    }

    return { actions, orders: orderList };
  });
}

const marketplaceCategories = new Set(["electronics", "computers", "phones", "gaming", "transport", "home", "clothes", "other"]);

function validListing(value: unknown): ListingInput | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<ListingInput>;
  const title = typeof item.title === "string" ? item.title.trim().slice(0, 200) : "";
  const description = typeof item.description === "string" ? item.description.trim().slice(0, 4000) : "";
  const price = Number(item.price);
  const category = typeof item.category === "string" && marketplaceCategories.has(item.category) ? item.category : "other";
  if (!title || !description || !Number.isFinite(price) || price <= 0) return undefined;
  return { title, description, price: Math.round(price * 100) / 100, category };
}

async function createProductsBatch(args: Record<string, unknown>) {
  const items = Array.isArray(args.products) ? args.products.slice(0, 25) : [];
  if (!items.length) throw new Error("Передайте хотя бы один товар для публикации");
  return withMcp(async (client) => {
    const products: Product[] = [];
    const failures: Array<{ index: number; error: string }> = [];
    for (const [index, value] of items.entries()) {
      const listing = validListing(value);
      if (!listing) { failures.push({ index, error: "Нужны название, описание, положительная цена и категория" }); continue; }
      try { products.push(await callChecked<Product>(client, "create_product", listing)); }
      catch (reason) { failures.push({ index, error: safeError(reason) }); }
    }
    return { products, failures, created_count: products.length, requested_count: items.length };
  });
}

async function researchWebListing(request: WebListingRequest, apiKey: string) {
  const response = await fetch("https://api.deepseek.com/anthropic/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": apiKey },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      max_tokens: 1400,
      messages: [{ role: "user", content: `Найди в интернете актуальные характеристики и типичную цену в рублях для объявления: ${request.product_name}. Состояние: ${request.condition || "не указано"}. Дополнения: ${request.notes || "нет"}. Подготовь честное объявление на русском. Верни только JSON без markdown: {"title":"...","description":"...","price":12345,"category":"electronics|computers|phones|gaming|transport|home|clothes|other"}. Не придумывай характеристики, которых нет в источниках.` }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }],
    }),
  });
  const payload = await response.json() as { content?: Array<{ type?: string; text?: string; content?: Array<{ url?: string }> }>; error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message || "DeepSeek не выполнил веб-поиск");
  const text = (payload.content || []).filter((item) => item.type === "text").map((item) => item.text || "").join("\n");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Веб-поиск не вернул карточку товара");
  const listing = validListing(JSON.parse(text.slice(start, end + 1)));
  if (!listing) throw new Error("Веб-поиск вернул неполные данные товара");
  if (request.category && marketplaceCategories.has(request.category)) listing.category = request.category;
  const sourceUrls = [...new Set((payload.content || []).flatMap((item) => item.type === "web_search_tool_result" ? (item.content || []).map((result) => result.url).filter((url): url is string => Boolean(url)) : []))].slice(0, 3);
  if (sourceUrls.length) listing.description = `${listing.description}\n\nИсточники характеристик и цены:\n${sourceUrls.join("\n")}`.slice(0, 4000);
  return { listing, source_urls: sourceUrls };
}

async function findCommonsImage(productName: string) {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  url.search = new URLSearchParams({ action: "query", generator: "search", gsrsearch: productName, gsrnamespace: "6", gsrlimit: "12", prop: "imageinfo", iiprop: "url|mime|size", format: "json", origin: "*" }).toString();
  const response = await fetch(url);
  if (!response.ok) return undefined;
  const payload = await response.json() as { query?: { pages?: Record<string, { imageinfo?: Array<{ url?: string; mime?: string; size?: number }> }> } };
  const candidates = Object.values(payload.query?.pages || {}).flatMap((page) => page.imageinfo || []);
  return candidates.find((image) => image.url && ["image/jpeg", "image/png", "image/webp"].includes(image.mime || "") && (!image.size || image.size <= 5 * 1024 * 1024));
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  return btoa(binary);
}

async function downloadImage(url: string, mimeHint?: string) {
  const response = await fetch(url, { headers: { Accept: "image/jpeg,image/png,image/webp" } });
  if (!response.ok) throw new Error("Не удалось загрузить найденное изображение");
  const contentType = (response.headers.get("content-type") || mimeHint || "").split(";")[0];
  if (!["image/jpeg", "image/png", "image/webp"].includes(contentType)) throw new Error("Найдено изображение неподдерживаемого формата");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new Error("Найденное изображение превышает 5 МБ");
  return { image_base64: bytesToBase64(bytes), content_type: contentType };
}

async function researchAndCreateProducts(args: Record<string, unknown>) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("Агент пока не настроен");
  const items = (Array.isArray(args.products) ? args.products : []).slice(0, 5).filter((item): item is WebListingRequest => Boolean(item && typeof item === "object" && typeof (item as WebListingRequest).product_name === "string"));
  if (!items.length) throw new Error("Передайте название хотя бы одного товара");
  return withMcp(async (client) => {
    const products: Product[] = [];
    const results: Array<{ product_name: string; product?: Product; sources?: string[]; image_added?: boolean; warning?: string; error?: string }> = [];
    for (const item of items) {
      try {
        const research = await researchWebListing(item, apiKey);
        const product = await callChecked<Product>(client, "create_product", research.listing);
        let imageAdded = false;
        let warning: string | undefined;
        try {
          const image = await findCommonsImage(item.product_name);
          if (image?.url) {
            const payload = await downloadImage(image.url, image.mime);
            await callChecked(client, "add_product_image", { product_id: product.id, ...payload, alt_text: product.title });
            imageAdded = true;
          } else warning = "Подходящее изображение с Wikimedia Commons не найдено";
        } catch (reason) { warning = safeError(reason); }
        products.push(product);
        results.push({ product_name: item.product_name, product, sources: research.source_urls, image_added: imageAdded, warning });
      } catch (reason) { results.push({ product_name: item.product_name, error: safeError(reason) }); }
    }
    return { products, results, created_count: products.length, requested_count: items.length };
  });
}

async function callAgentTool(name: string, args: Record<string, unknown>) {
  if (name === "create_products_batch") return createProductsBatch(args);
  if (name === "research_and_create_products") return researchAndCreateProducts(args);
  if (name === "search_products_by_seller_name") return searchProductsBySellerName(args);
  if (name === "inspect_sales_inbox") return inspectSalesInbox();
  if (name === "process_sales_inbox") return processSalesInbox();
  if (name === "start_purchase") return startPurchase(args);
  if (name === "process_purchase_orders") return processPurchaseOrders();
  if (name === "inspect_completed_purchases") return inspectCompletedPurchases();
  if (name === "get_test_payment_details") return getTestPaymentDetails();
  if (name === "verify_test_payment") return verifyTestPayment(args.transaction_hash);
  if (!allowedAgentTools.has(name)) throw new Error("Инструмент агенту недоступен");
  return withMcp((client) => callChecked<unknown>(client, name, args));
}

function normalizedName(value: string) {
  return value.toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

async function searchProductsBySellerName(args: Record<string, unknown>) {
  const sellerName = typeof args.seller_name === "string" ? normalizedName(args.seller_name) : "";
  if (sellerName.length < 2) throw new Error("Укажите имя или фамилию продавца");
  const requestedLimit = typeof args.limit === "number" ? Math.min(12, Math.max(1, Math.trunc(args.limit))) : 12;
  const searchArgs = Object.fromEntries(Object.entries(args).filter(([key]) => key !== "seller_name" && key !== "limit"));

  return withMcp(async (client) => {
    const products = await callChecked<Product[]>(client, "search_products", { ...searchArgs, limit: 100 });
    const productList = Array.isArray(products) ? products : [];
    const sellerIds = [...new Set(productList.map((product) => product.seller_id).filter((id): id is string => Boolean(id)))];
    const profiles = await Promise.all(sellerIds.map(async (profileId) => {
      try { return await callChecked<Profile>(client, "get_profile", { user_id: profileId }); }
      catch { return undefined; }
    }));
    const matchingSellerIds = new Set(profiles.filter((profile): profile is Profile => Boolean(profile)).filter((profile) => {
      const profileName = normalizedName([profile.first_name, profile.last_name].filter(Boolean).join(" "));
      return sellerName.split(" ").every((part) => profileName.includes(part));
    }).map((profile) => profile.id));
    return productList.filter((product) => product.seller_id && matchingSellerIds.has(product.seller_id)).slice(0, requestedLimit);
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
  if (/insufficient funds|exceeds (?:the )?balance|gas required exceeds/i.test(raw)) return "На тестовом кошельке покупателя недостаточно SepoliaETH для перевода.";
  if (/401|unauthorized|authentication|api key/i.test(raw)) return "DeepSeek отклонил ключ доступа. Проверьте настройку ключа.";
  if (/deepseek[\s\S]*(?:balance|insufficient)|(?:balance|insufficient)[\s\S]*deepseek/i.test(raw)) return "На балансе DeepSeek недостаточно средств.";
  return raw.length > 500 ? "Агент временно недоступен. Попробуйте ещё раз." : raw;
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { messages?: unknown; automation?: unknown };
    if (body.automation === "sales") return NextResponse.json(await processSalesInbox());
    if (body.automation === "deals") {
      const [sales, purchases] = await Promise.all([processSalesInbox(), processPurchaseOrders()]);
      return NextResponse.json({ actions: [...sales.actions, ...purchases.actions], sales, purchases });
    }
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
          if (["search_products", "search_products_by_seller_name", "get_my_products"].includes(call.function.name)) {
            const list = Array.isArray(value) ? value as Product[] : [];
            foundProducts = await hydrateProducts(list);
          }
          if (["create_products_batch", "research_and_create_products"].includes(call.function.name) && value && typeof value === "object") {
            const created = value as { products?: Product[] };
            foundProducts = await hydrateProducts(Array.isArray(created.products) ? created.products : []);
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
          if (call.function.name === "process_purchase_orders" && value && typeof value === "object") {
            const processed = value as { orders?: Order[] };
            foundOrders = Array.isArray(processed.orders) ? processed.orders : [];
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
