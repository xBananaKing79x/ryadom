import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Место — C2C-маркетплейс",
  description: "Web-интерфейс C2C-платформы с подключением по MCP.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
