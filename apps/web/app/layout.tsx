import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { connection } from "next/server";
// Self-hosted through next/font/local: the font files are served from our own origin (no Google Fonts; §6.1).
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { AppShell } from "@/components/shell/app-shell";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Hogee", template: "%s · Hogee" },
  description: "Your business plan sets the rules for your spending.",
};

// Light only (DESIGN.md "Ledger and Seal"); the browser chrome takes the top bar's surface colour.
export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#fdfdfe",
};

// Every page renders per request: the CSP nonce (proxy.ts) exists only at request time, and Next.js puts it on the
// scripts it renders. A page built ahead of time would carry no nonce, so the browser would block its scripts.
export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="font-sans antialiased">
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
