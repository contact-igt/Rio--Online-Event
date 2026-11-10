import { Anek_Tamil, Baloo_Thambi_2, Hind_Madurai } from "next/font/google";

// Self-hosted by next/font at build time; the website and the admin panel use the same three faces.
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

export const fontVariables = `${baloo.variable} ${hind.variable} ${anek.variable}`;
