import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const endpoint = process.env.MCP_SERVER_URL || "https://ai-hackaton.ru/mcp";

function publicError(reason: unknown) {
  const token = process.env.MCP_API_TOKEN;
  const raw = reason instanceof Error ? reason.message : "Неизвестная ошибка MCP";
  const sanitized = token ? raw.replaceAll(token, "[скрыто]") : raw;

  if (/401|unauthorized|auth|api key/i.test(sanitized)) {
    return "MCP-сервер отклонил ключ доступа. Проверьте личный токен.";
  }
  return sanitized;
}

async function withMcp<T>(operation: (client: Client) => Promise<T>) {
  const token = process.env.MCP_API_TOKEN;
  if (!token) throw new Error("На сервере не задан MCP_API_TOKEN");

  const client = new Client({ name: "c2c-web-smoke-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: {
      headers: { Authorization: `Bearer ${token}` },
    },
  });

  try {
    await client.connect(transport);
    return await operation(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function GET() {
  try {
    const response = await withMcp((client) => client.listTools());
    return NextResponse.json({ tools: response.tools });
  } catch (reason) {
    return NextResponse.json({ error: publicError(reason) }, { status: 502 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { name?: unknown; arguments?: unknown };
    if (typeof body.name !== "string" || body.name.length === 0) {
      return NextResponse.json({ error: "Не указано имя MCP-инструмента" }, { status: 400 });
    }
    if (body.arguments !== undefined && (body.arguments === null || typeof body.arguments !== "object" || Array.isArray(body.arguments))) {
      return NextResponse.json({ error: "Аргументы должны быть JSON-объектом" }, { status: 400 });
    }

    const result = await withMcp(async (client) => {
      const availableTools = await client.listTools();
      const selectedTool = availableTools.tools.find((tool) => tool.name === body.name);
      if (!selectedTool) throw new Error("MCP-инструмент не найден");
      if (!selectedTool.annotations?.readOnlyHint) {
        throw new Error("В тестовом интерфейсе разрешены только read-only инструменты");
      }

      return client.callTool({
        name: body.name as string,
        arguments: (body.arguments ?? {}) as Record<string, unknown>,
      });
    });
    return NextResponse.json({ result });
  } catch (reason) {
    return NextResponse.json({ error: publicError(reason) }, { status: 502 });
  }
}
