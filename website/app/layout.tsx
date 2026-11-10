import type { Metadata } from "next";
import { fontVariables } from "@/lib/fonts";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "மழலைத் தமிழே! | Rio Hospital Children's Day 2026",
    template: "%s | மழலைத் தமிழே! Rio Children's Day 2026",
  },
  description:
    "Six online Tamil video competitions for children aged 3 to 12, from Rio Hospital for Women & Children. ஆறு ஆன்லைன் தமிழ்ப் போட்டிகள்.",
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
        <SiteHeader />
        <main id="main" className="wash flex-1">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
