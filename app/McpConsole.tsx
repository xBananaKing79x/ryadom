"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type McpTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: {
    type?: string;
    required?: string[];
    properties?: Record<string, { type?: string; description?: string; enum?: string[] }>;
  };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
};

type ToolsResponse = {
  tools?: McpTool[];
  error?: string;
};

function emptyArgs(tool?: McpTool) {
  if (!tool?.inputSchema?.properties) return "{}";

  const required = new Set(tool.inputSchema.required ?? []);
  const value = Object.fromEntries(
    Object.entries(tool.inputSchema.properties).filter(([key]) => required.has(key)).map(([key, schema]) => {
      if (schema.enum?.length) return [key, schema.enum[0]];
      if (schema.type === "number" || schema.type === "integer") return [key, 0];
      if (schema.type === "boolean") return [key, false];
      if (schema.type === "array") return [key, []];
      if (schema.type === "object") return [key, {}];
      return [key, ""];
    }),
  );

  return JSON.stringify(value, null, 2);
}

export function McpConsole() {
  const [tools, setTools] = useState<McpTool[]>([]);
  const [selectedName, setSelectedName] = useState("");
  const [argumentsText, setArgumentsText] = useState("{}");
  const [result, setResult] = useState<unknown>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [calling, setCalling] = useState(false);

  const selectedTool = useMemo(
    () => tools.find((tool) => tool.name === selectedName),
    [selectedName, tools],
  );

  const loadTools = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/mcp", { cache: "no-store" });
      const payload = (await response.json()) as ToolsResponse;
      if (!response.ok) throw new Error(payload.error || "MCP-сервер не ответил");
      const nextTools = payload.tools ?? [];
      setTools(nextTools);
      if (nextTools.length > 0) {
        const preferred = nextTools.find((tool) => tool.name === "search_products") ?? nextTools[0];
        setSelectedName(preferred.name);
        setArgumentsText(emptyArgs(preferred));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось подключиться к MCP");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTools();
  }, [loadTools]);

  function selectTool(tool: McpTool) {
    setSelectedName(tool.name);
    setArgumentsText(emptyArgs(tool));
    setResult(undefined);
    setError("");
  }

  async function callTool() {
    if (!selectedTool?.annotations?.readOnlyHint) return;
    setCalling(true);
    setError("");
    setResult(undefined);

    try {
      const parsed = JSON.parse(argumentsText) as Record<string, unknown>;
      const response = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: selectedTool.name, arguments: parsed }),
      });
      const payload = (await response.json()) as { result?: unknown; error?: string };
      if (!response.ok) throw new Error(payload.error || "Инструмент завершился с ошибкой");
      setResult(payload.result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Некорректный ответ");
    } finally {
      setCalling(false);
    }
  }

  const statusLabel = loading
    ? "Подключаемся"
    : error && tools.length === 0
      ? "Нет соединения"
      : `Подключено · ${tools.length} ${tools.length === 1 ? "инструмент" : "инструментов"}`;

  return (
    <section className="console" aria-labelledby="console-title">
      <div className="console-heading">
        <div>
          <p className="eyebrow">Проверка интеграции</p>
          <h2 id="console-title">Инструменты платформы</h2>
        </div>
        <div className={`status ${error && tools.length === 0 ? "status-error" : ""}`}>
          <span className="status-dot" aria-hidden="true" />
          {statusLabel}
        </div>
      </div>

      {loading ? (
        <div className="loading-panel" aria-live="polite">
          <span className="loader" aria-hidden="true" />
          Получаем список MCP tools…
        </div>
      ) : error && tools.length === 0 ? (
        <div className="error-panel" role="alert">
          <div>
            <strong>Подключение не прошло</strong>
            <p>{error}</p>
          </div>
          <button className="secondary-button" onClick={() => void loadTools()} type="button">
            Повторить
          </button>
        </div>
      ) : (
        <div className="workspace">
          <nav className="tool-list" aria-label="MCP-инструменты">
            {tools.map((tool, index) => (
              <button
                className={`tool-item ${tool.name === selectedName ? "tool-item-active" : ""}`}
                key={tool.name}
                onClick={() => selectTool(tool)}
                type="button"
              >
                <span className="tool-index">{String(index + 1).padStart(2, "0")}</span>
                <span>
                  <strong>{tool.name}</strong>
                  <small>{tool.description || "Без описания"}</small>
                </span>
              </button>
            ))}
          </nav>

          <div className="tool-detail">
            <div className="tool-title-row">
              <div>
                <span className="tool-label">Выбранный tool</span>
                <h3>{selectedTool?.name}</h3>
              </div>
              <span className={`method-badge ${selectedTool?.annotations?.readOnlyHint ? "" : "method-badge-write"}`}>
                {selectedTool?.annotations?.readOnlyHint ? "read-only" : "изменяет данные"}
              </span>
            </div>
            <p className="tool-description">{selectedTool?.description || "Описание не передано сервером."}</p>

            <label className="field-label" htmlFor="tool-arguments">Аргументы · JSON</label>
            <textarea
              id="tool-arguments"
              onChange={(event) => setArgumentsText(event.target.value)}
              spellCheck={false}
              value={argumentsText}
            />
            <button
              className="primary-button"
              disabled={calling || !selectedTool?.annotations?.readOnlyHint}
              onClick={() => void callTool()}
              type="button"
            >
              {calling
                ? "Выполняем…"
                : selectedTool?.annotations?.readOnlyHint
                  ? "Выполнить запрос"
                  : "Изменение отключено"}
              <span aria-hidden="true">→</span>
            </button>

            {(result !== undefined || error) && (
              <div className={`result-panel ${error ? "result-error" : ""}`} aria-live="polite">
                <span>{error ? "Ошибка" : "Ответ MCP"}</span>
                <pre>{error || JSON.stringify(result, null, 2)}</pre>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
