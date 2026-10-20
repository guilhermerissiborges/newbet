import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Arrematto", description: "Live shopping com leilão" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700&family=Inter:wght@400;500;600&display=swap" />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
