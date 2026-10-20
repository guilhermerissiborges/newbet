import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Arrematto", description: "Live shopping com leilão" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className="antialiased font-sans">{children}</body>
    </html>
  );
}
