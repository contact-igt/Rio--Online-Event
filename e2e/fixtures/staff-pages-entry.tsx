// Browser entry for e2e/staff-pages.spec.ts: the REAL administrator and judge pages (server components called as plain async
// functions) with fake data and fake server actions. Bundled by the spec; never part of the app.
import { createRoot } from "react-dom/client";
import AdminPage from "@/app/admin/page";
import JudgePage from "@/app/judge/page";
import JudgeEntryPage from "@/app/judge/entries/[id]/page";

const mode = location.hash.replace("#", "");

async function main() {
  const element =
    mode === "judge" ? await JudgePage() : mode.startsWith("entry:") ? await JudgeEntryPage({ params: Promise.resolve({ id: mode.slice(6) }) }) : await AdminPage();
  createRoot(document.getElementById("root")!).render(element);
  document.body.dataset.ready = "1";
}
void main();
