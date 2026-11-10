import { readdirSync, readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { bundleFixture } from "@/e2e/fixtures/bundle";

// Shared by the offline administrator and judge specs: the one bundle of the real pages with their fake server modules, the built stylesheet,
// and a function that opens a screen in the installed Chrome. Nothing here is part of the app.

export const staffBundle = () =>
  bundleFixture("e2e/fixtures/staff-pages-entry.tsx", {
    "@/lib/staff/auth": "e2e/fixtures/fake-staff-auth.ts",
    "@/lib/staff/invites": "e2e/fixtures/fake-staff-invites.ts",
    "@/lib/staff/provisioning": "e2e/fixtures/fake-staff-provisioning.ts",
    "@/lib/judging/server": "e2e/fixtures/fake-judging-server.ts",
    "@/app/judge/actions": "e2e/fixtures/fake-judge-actions.ts",
    "@/app/admin/judges/actions": "e2e/fixtures/fake-admin-actions.ts",
    "next/navigation": "e2e/fixtures/fake-navigation.ts",
    "next/link": "e2e/fixtures/fake-link.tsx",
  });

export function builtCss(): string {
  try {
    return readdirSync(".next/static/css").filter((f) => f.endsWith(".css")).map((f) => readFileSync(`.next/static/css/${f}`, "utf8")).join("\n");
  } catch {
    return "";
  }
}

export type OpenOptions = { data?: Record<string, unknown[]>; path?: string; provisioning?: unknown; authInfo?: unknown; adminScript?: unknown };

export async function openStaff(page: Page, bundle: string, css: string, hash: string, o: OpenOptions = {}) {
  await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><body style="margin:0;background:#fff8fb"><main id="root" class="wash"></main></body>');
  if (css) await page.addStyleTag({ content: css });
  await page.evaluate(
    ({ h, o }) => {
      location.hash = encodeURIComponent(h);
      const w = window as unknown as Record<string, unknown>;
      w.__staffData = o.data ?? {};
      w.__path = o.path;
      w.__prov = o.provisioning;
      w.__authInfo = o.authInfo ?? null;
      w.__adminScript = o.adminScript;
    },
    { h: hash, o },
  );
  await page.addScriptTag({ content: bundle });
  await page.waitForSelector("body[data-ready='1'] h1, body[data-ready='1'] nav");
}
