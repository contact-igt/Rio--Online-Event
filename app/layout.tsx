import type { Metadata } from "next";
import { Anek_Tamil, Baloo_Thambi_2, Hind_Madurai } from "next/font/google";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

const baloo = Baloo_Thambi_2({
  subsets: ["tamil", "latin"],
  weight: ["600", "700", "800"],
  variable: "--font-baloo",
  display: "swap",
});

const hind = Hind_Madurai({
  subsets: ["tamil", "latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-hind",
  display: "swap",
});

// Tamil glyphs of section headings only (h2/h3): the Tamil subset, one weight, not preloaded. Latin text in a heading falls through to Baloo,
// so the English font does not change.
const anek = Anek_Tamil({
  subsets: ["tamil"],
  weight: ["700"],
  variable: "--font-anek",
  display: "swap",
  preload: false,
});

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
    <html lang="ta" className={`${baloo.variable} ${hind.variable} ${anek.variable}`}>
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
