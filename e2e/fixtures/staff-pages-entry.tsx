// Browser entry for the offline administrator and judge tests: the REAL pages (server components called as plain async functions) with fake
// data and fake server actions. The hash picks the screen: admin | judge | entry:<id> | registrations[|query] | registration:<id> | judges | nav.
// Bundled by the specs; never part of the app.
import { createRoot } from "react-dom/client";
import AdminPage from "@/app/admin/page";
import AdminJudgesPage from "@/app/admin/judges/page";
import AdminRegistrationPage from "@/app/admin/registrations/[id]/page";
import AdminRegistrationsPage from "@/app/admin/registrations/page";
import JudgePage from "@/app/judge/page";
import JudgeEntryPage from "@/app/judge/entries/[id]/page";
import { AdminNav } from "@/components/admin/admin-nav";

const [mode = "admin", query = ""] = decodeURIComponent(location.hash.replace("#", "")).split("|");

async function main() {
  const search = Promise.resolve(Object.fromEntries(new URLSearchParams(query)));
  const element =
    mode === "judge"
      ? await JudgePage()
      : mode.startsWith("entry:")
        ? await JudgeEntryPage({ params: Promise.resolve({ id: mode.slice(6) }) })
        : mode === "registrations"
          ? await AdminRegistrationsPage({ searchParams: search })
          : mode.startsWith("registration:")
            ? await AdminRegistrationPage({ params: Promise.resolve({ id: mode.slice(13) }) })
            : mode === "judges"
              ? await AdminJudgesPage()
              : mode === "nav"
                ? <AdminNav />
                : mode === "layout"
                  ? (
                      // the same grid as app/admin/layout.tsx (which cannot be bundled: it asks Supabase who is signed in)
                      <div className="mx-auto grid w-full max-w-[1400px] lg:grid-cols-[15rem_minmax(0,1fr)]">
                        <AdminNav />
                        <div className="min-w-0 lg:col-start-2">{await AdminPage()}</div>
                      </div>
                    )
                  : await AdminPage();
  createRoot(document.getElementById("root")!).render(element);
  document.body.dataset.ready = "1";
}
void main();
