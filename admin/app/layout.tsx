import type { Metadata } from "next";
import { fontVariables } from "@/lib/fonts";
import "./globals.css";

// Staff only: never indexed, and the title says which site this is.
export const metadata: Metadata = {
  title: {
    default: "Rio Children's Day 2026 · Staff",
    template: "%s | Rio Children's Day 2026 · Staff",
  },
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ta" className={fontVariables}>
      <body className="flex min-h-dvh flex-col antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-xl focus:bg-rio-navy focus:px-4 focus:py-3 focus:text-white"
        >
          Skip to content
        </a>
        <main id="main" className="wash flex-1">
          {children}
        </main>
      </body>
    </html>
  );
}
