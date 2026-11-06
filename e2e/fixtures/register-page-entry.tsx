// Browser entry for the registration page tests: the REAL /events/[slug]/register page (a server component, called as a plain async
// function) with fake server modules. The hash picks the state: new | draft | uploaded | finalized | closed. Never part of the app.
import { createRoot } from "react-dom/client";
import RegisterPage from "@/app/events/[slug]/register/page";

const state = location.hash.replace("#", "") || "new";
const row = (status: string) => ({
  id: "bbbbbbbb-bbbb-4bbb-8bbb-000000000001",
  event_id: 4,
  status,
  child_name: "Test Child",
  child_age: 9,
  parent_name: "Test Parent",
  parent_mobile: "+919876543210",
  consent_version: "v0-provisional",
  consent_at: "2026-01-01T00:00:00Z",
  media_consent: false,
  entry_code: status === "finalized" ? "RIO-TEST1-00001" : undefined,
  updated_at: "2026-01-01T00:00:00Z",
  finalized_at: status === "finalized" ? "2026-01-02T10:00:00Z" : null,
});

async function main() {
  const rows = state === "new" || state === "closed" ? [] : [row(state)];
  window.__reg = { rows, open: state !== "closed", email: false, uploads: true, finalize: true, ...(window as { __regOverride?: object }).__regOverride };
  const searchParams = Promise.resolve({ draft: rows[0]?.id as string | undefined, saved: undefined as string | undefined });
  const element = await RegisterPage({ params: Promise.resolve({ slug: "kutti-pesalar" }), searchParams });
  createRoot(document.getElementById("root")!).render(element);
  document.body.dataset.ready = "1";
}
void main();
