import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Рядом — всё нужное поблизости",
  description: "Спокойный маркетплейс хороших находок. Покупайте и продавайте вещи людям рядом.",
  openGraph: {
    title: "Рядом — всё нужное поблизости",
    description: "Покупайте и продавайте вещи людям рядом.",
    images: [{ url: "/hero-marketplace-v3.png", width: 1672, height: 941, alt: "Рядом — маркетплейс хороших находок" }],
  },
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
