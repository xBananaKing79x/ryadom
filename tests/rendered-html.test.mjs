import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  }, { waitUntil() {}, passThroughOnException() {} });
}

test("server-renders the marketplace shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Рядом — всё нужное поблизости<\/title>/i);
  assert.match(html, /Найдётся/);
  assert.match(html, /Что ищем сегодня/);
  assert.match(html, /Мои продукты/);
  assert.match(html, /src="\/hero-marketplace-v3\.png"/);
  assert.doesNotMatch(html, /MCP_API_TOKEN|c2c_6_/i);
});

test("keeps MCP writes server-side and explicitly allowlisted", async () => {
  const [route, app, image] = await Promise.all([
    readFile(new URL("../app/api/mcp/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/MarketplaceApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../public/hero-marketplace-v3.png", import.meta.url)),
  ]);
  assert.match(route, /const allowedTools = new Set/);
  assert.match(route, /"create_product"/);
  assert.match(route, /result\.isError/);
  assert.match(route, /status: 422/);
  assert.match(route, /Authorization: `Bearer \$\{token\}`/);
  assert.doesNotMatch(app, /MCP_API_TOKEN|Authorization:\s*["'`]Bearer/i);
  assert.match(app, /"create_order"/);
  assert.match(app, /"send_message"/);
  assert.match(app, /notification-button/);
  assert.match(app, /Отметить все прочитанными/);
  assert.match(app, /ryadom:read-messages/);
  assert.match(app, /product\.status\?\.toUpperCase\(\) !== "REMOVED"/);
  assert.match(app, /setMyProducts\(\(current\) => current\.filter\(\(item\) => item\.id !== product\.id\)\)/);
  assert.ok(image.byteLength > 100_000);
  assert.ok(templateRoot.pathname.endsWith("/new-chat/"));
});

test("uses the image MIME type required by the marketplace", async () => {
  const source = await readFile(new URL("../app/MarketplaceApp.tsx", import.meta.url), "utf8");
  assert.match(source, /content_type: file\.type/);
  assert.match(source, /5 \* 1024 \* 1024/);
  assert.doesNotMatch(source, /file\.type\.replace\("image\/"/);
});

test("keeps the DeepSeek agent server-side and MCP-driven", async () => {
  const [agentRoute, app, ethereumRoute, sepolia] = await Promise.all([
    readFile(new URL("../app/api/agent/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/MarketplaceApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/ethereum/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/sepolia.ts", import.meta.url), "utf8"),
  ]);
  assert.match(agentRoute, /process\.env\.DEEPSEEK_API_KEY/);
  assert.match(agentRoute, /deepseek-v4-flash/);
  assert.match(agentRoute, /search_products/);
  assert.match(agentRoute, /search_products_by_seller_name/);
  assert.match(agentRoute, /callChecked<Profile>\(client, "get_profile", \{ user_id: profileId \}\)/);
  assert.match(agentRoute, /get_my_orders/);
  assert.match(agentRoute, /inspect_sales_inbox/);
  assert.match(agentRoute, /process_sales_inbox/);
  assert.match(agentRoute, /start_purchase/);
  assert.match(agentRoute, /process_purchase_orders/);
  assert.match(agentRoute, /automation === "deals"/);
  assert.match(agentRoute, /walletFromDescription/);
  assert.match(agentRoute, /acceptedOrder.status !== "ACCEPTED"/);
  assert.match(agentRoute, /reservedProduct.status !== "RESERVED"/);
  assert.ok(agentRoute.indexOf('freshProduct.status !== "RESERVED" || freshOrder.status !== "ACCEPTED"') < agentRoute.indexOf("sendTestPayment(wallet, amountToSend)"));
  assert.match(agentRoute, /listedPrice \* 0\.9/);
  assert.match(agentRoute, /listedPrice \* 0\.7/);
  assert.match(agentRoute, /"accept_order"/);
  assert.match(agentRoute, /"complete_order"/);
  assert.match(agentRoute, /"send_message"/);
  assert.match(agentRoute, /inspect_completed_purchases/);
  assert.match(agentRoute, /extractOfferPrice/);
  assert.match(agentRoute, /get_test_payment_details/);
  assert.match(agentRoute, /verify_test_payment/);
  assert.match(ethereumRoute, /verifyTestPayment/);
  assert.match(sepolia, /eth_getTransactionReceipt/);
  assert.match(sepolia, /eth_getBlockByNumber/);
  assert.match(sepolia, /"finalized"/);
  assert.match(sepolia, /sendTestPayment/);
  assert.match(sepolia, /createPublicClient/);
  assert.match(sepolia, /getBalance/);
  assert.match(sepolia, /verifyPaymentTotal/);
  assert.match(sepolia, /total_sent_matches/);
  assert.match(sepolia, /SEPOLIA_PAYMENT_PRIVATE_KEY/);
  assert.match(sepolia, /recipient_matches/);
  assert.match(sepolia, /amount_matches/);
  assert.match(sepolia, /quoteRubPriceInEth/);
  assert.match(sepolia, /api\.coinbase\.com\/v2\/prices\/ETH-RUB\/spot/);
  assert.match(agentRoute, /payment\.total_finalized_matches/);
  assert.match(agentRoute, /settlementMatchesListing/);
  assert.match(agentRoute, /finalizedRub \+ 0\.01 >= listedPrice/);
  assert.match(agentRoute, /completedOrder\.status !== "COMPLETED" && completedProduct\.status !== "SOLD"/);
  assert.match(agentRoute, /Ответ на сообщение покупателя/);
  assert.match(agentRoute, /Продавец отказался от сделки/);
  assert.match(agentRoute, /sendTestPayment\(wallet, amountToSend\)/);
  assert.match(agentRoute, /create_products_batch/);
  assert.match(agentRoute, /research_and_create_products/);
  assert.match(agentRoute, /web_search_20250305/);
  assert.match(agentRoute, /commons\.wikimedia\.org/);
  assert.match(agentRoute, /add_product_image/);
  assert.match(agentRoute, /cancel_order/);
  assert.match(sepolia, /SEPOLIA_PAYMENT_ADDRESS/);
  assert.doesNotMatch(app, /SEPOLIA_PAYMENT_PRIVATE_KEY/);
  assert.doesNotMatch(app, /DEEPSEEK_API_KEY|api\.deepseek\.com/);
  assert.match(app, /Агент по сделкам/);
  assert.match(app, /floating-agent-button/);
  assert.doesNotMatch(app, /className="agent-nav-button"/);
  assert.match(app, /ryadom:agent-button-position/);
  assert.match(app, /event\.key === "Enter"/);
  assert.match(app, /!event\.shiftKey/);
  assert.match(app, /requestSubmit\(\)/);
  assert.match(app, /agentChatRef/);
  assert.match(app, /chat\.scrollHeight/);
  assert.match(app, /setInterval\(\(\) => void tick\(\), 5_000\)/);
  assert.match(app, /Новое сообщение по объявлению/);
  assert.match(app, /ryadom:agent-seen-message-ids/);
  assert.match(app, /agent-offer-product/);
  assert.match(app, /order-product-image/);
  assert.match(app, /Открыть карточку →/);
  assert.match(app, /Провести покупки/);
  assert.match(app, /createAgentOrder/);
  assert.match(app, /acceptAgentOrder/);
  assert.match(app, /reserveAgentOffer/);
  assert.match(app, /approveAgentOffer/);
  assert.match(app, /declineAgentOffer/);
  assert.match(app, /relistPurchasedProduct/);
  assert.match(app, /Выставлено на продажу/);
  assert.match(app, /eth_sendTransaction/);
  assert.match(app, /Тестовая оплата ETH/);
  assert.match(app, /Проверить статус/);
  assert.match(app, /Оплата в блокчейне/);
  assert.match(app, /Чат с продавцом/);
  assert.match(app, /Проверить счёт/);
  assert.match(app, /verifyDealTransaction/);
  assert.ok(app.indexOf("deal-settlement") < app.indexOf("deal-chat-panel"));
});

test("renders key attributes in agent product miniatures", async () => {
  const app = await readFile(new URL("../app/MarketplaceApp.tsx", import.meta.url), "utf8");
  assert.match(app, /product\.description \|\| "Описание пока не добавлено"/);
  assert.match(app, /money\(product\.price\)/);
});
