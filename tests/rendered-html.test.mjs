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
  assert.match(html, /Всё нужное/);
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
