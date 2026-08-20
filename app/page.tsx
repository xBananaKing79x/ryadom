import type { Metadata } from "next";
import { McpConsole } from "./McpConsole";

export const metadata: Metadata = {
  title: "Место — проверка C2C API",
  description: "Минимальный web-интерфейс для проверки MCP-инструментов C2C-платформы.",
};

export default function Home() {
  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Место — на главную">
          <span className="brand-mark" aria-hidden="true">М</span>
          <span>место</span>
        </a>
        <span className="header-note">тестовый контур</span>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow">C2C-маркетплейс · MCP</p>
          <h1>Проверим связь с&nbsp;каталогом</h1>
          <p className="hero-description">
            Служебный экран первой версии: показывает инструменты платформы,
            их параметры и живые ответы сервера.
          </p>
        </div>
        <div className="hero-orbit" aria-hidden="true">
          <span className="orbit-card orbit-card-top">объявления</span>
          <span className="orbit-card orbit-card-middle">поиск</span>
          <span className="orbit-card orbit-card-bottom">продавцы</span>
        </div>
      </section>

      <McpConsole />

      <footer>
        <span>Место · техническая проверка</span>
        <span>Streamable HTTP</span>
      </footer>
    </main>
  );
}
