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
  assert.match(html, /Что хотите найти/);
  assert.match(html, /Мои продукты/);
  assert.doesNotMatch(html, /MCP_API_TOKEN|c2c_6_/i);
});

test("keeps MCP writes server-side and explicitly allowlisted", async () => {
  const [route, app, image] = await Promise.all([
    readFile(new URL("../app/api/mcp/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/MarketplaceApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../public/hero-marketplace.png", import.meta.url)),
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
  const [agentRoute, app] = await Promise.all([
    readFile(new URL("../app/api/agent/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/MarketplaceApp.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(agentRoute, /process\.env\.DEEPSEEK_API_KEY/);
  assert.match(agentRoute, /deepseek-v4-flash/);
  assert.match(agentRoute, /search_products/);
  assert.match(agentRoute, /get_my_orders/);
  assert.doesNotMatch(app, /DEEPSEEK_API_KEY|api\.deepseek\.com/);
  assert.match(app, /Агент по покупкам/);
  assert.match(app, /floating-agent-button/);
  assert.doesNotMatch(app, /className="agent-nav-button"/);
  assert.match(app, /ryadom:agent-button-position/);
  assert.match(app, /createAgentOrder/);
  assert.match(app, /acceptAgentOrder/);
});
