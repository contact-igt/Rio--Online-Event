import type { Page } from "@playwright/test";

// Measurements for the design checklist, taken in the real browser: horizontal overflow, text contrast for EVERY visible piece of text
// (against the first opaque background behind it), and tap targets under 44px. Nothing here changes the page.

export type Audit = {
  overflow: boolean;
  lowContrast: { text: string; ratio: number; need: number }[];
  smallTargets: { text: string; h: number; w: number }[];
  minRatio: number;
};

export async function audit(page: Page, scope = "body"): Promise<Audit> {
  return page.evaluate((scopeSel) => {
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const rgb = (c: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return { r: d[0]!, g: d[1]!, b: d[2]!, a: d[3]! / 255 };
    };
    const lum = ({ r, g, b }: { r: number; g: number; b: number }) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const backdrop = (el: Element) => {
      for (let n: Element | null = el; n; n = n.parentElement) {
        const c = rgb(getComputedStyle(n).backgroundColor);
        if (c.a > 0.99) return c;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    };
    const root = document.querySelector(scopeSel)!;
    const lowContrast: Audit["lowContrast"] = [];
    let minRatio = 21;
    const seen = new Set<Element>();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const el = t.parentElement;
      if (!el || seen.has(el) || !t.textContent?.trim()) continue;
      seen.add(el);
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0 || style.visibility === "hidden" || style.display === "none" || el.closest("[aria-hidden=true]") || el.closest(".sr-only")) continue;
      const bg = backdrop(el);
      const fg = rgb(style.color);
      const blended = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
      const [a, b] = [lum(blended), lum(bg)];
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const px = parseFloat(style.fontSize);
      const large = px >= 24 || (px >= 18.66 && parseInt(style.fontWeight, 10) >= 700);
      const need = large ? 3 : 4.5;
      if (ratio < minRatio) minRatio = ratio;
      if (ratio < need) lowContrast.push({ text: (t.textContent ?? "").trim().slice(0, 40), ratio: Math.round(ratio * 100) / 100, need });
    }
    const smallTargets = [...root.querySelectorAll("a[href], button, select, input:not([type=hidden]):not([type=checkbox]):not([type=file]), summary")]
      .filter((e) => {
        const r = e.getBoundingClientRect();
        const s = getComputedStyle(e);
        return r.width > 0 && s.display !== "inline" && !e.closest(".sr-only") && s.visibility !== "hidden";
      })
      .map((e) => ({ text: (e.textContent ?? e.getAttribute("name") ?? "").trim().slice(0, 30), h: Math.round(e.getBoundingClientRect().height), w: Math.round(e.getBoundingClientRect().width) }))
      .filter((x) => x.h < 44);
    return { overflow: document.documentElement.scrollWidth > window.innerWidth, lowContrast, smallTargets, minRatio: Math.round(minRatio * 100) / 100 };
  }, scope);
}
