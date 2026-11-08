import { expect, test, type Page } from "@playwright/test";
import { audit } from "./helpers/audit";
import { builtCss, openStaff, staffBundle } from "./helpers/staff-bundle";

// The REAL administrator and judge pages (server components, called as plain functions) in the installed Chrome with a fake database.
// They show that every number on the dashboards is counted from the rows, that nothing private reaches a judge, that no button is a dead
// end, and that the layouts hold at phone, tablet and desktop widths. The fake rows are test data; nothing here ships.

let bundle = "";
let css = "";

const ID = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${n}`;
const data = {
  submissions: [
    { event_id: 1, status: "draft" },
    { event_id: 1, status: "draft" },
    { event_id: 1, status: "uploaded" },
    { event_id: 1, status: "finalized" },
    { event_id: 1, status: "finalized" },
    { event_id: 1, status: "finalized" },
    { event_id: 4, status: "finalized" },
    { event_id: 4, status: "withdrawn" },
  ],
  judge_profiles: [
    { user_id: "j1", display_name: "Judge One", active: true },
    { user_id: "j2", display_name: "Judge Two", active: false },
  ],
  judge_assignments: [{ judge_id: "j1" }, { judge_id: "j1" }, { judge_id: "j1" }, { judge_id: "j1" }],
  scores: [
    { judge_id: "j1", status: "final" },
    { judge_id: "j1", status: "draft" },
  ],
  winners: [{ id: "w1" }],
  judge_entries: [
    { entry_id: ID(1), entry_code: "RIO-AAAAA-00001", event_id: 4, score_status: null, my_marks: null, my_comments: null },
    { entry_id: ID(2), entry_code: "RIO-AAAAA-00002", event_id: 4, score_status: "draft", my_marks: 70, my_comments: "ok" },
    { entry_id: ID(3), entry_code: "RIO-AAAAA-00003", event_id: 4, score_status: "final", my_marks: 88.5, my_comments: null },
    { entry_id: ID(4), entry_code: "RIO-AAAAA-00004", event_id: 1, score_status: null, my_marks: null, my_comments: null },
  ],
};

test.beforeAll(async () => {
  bundle = await staffBundle();
  css = builtCss();
});

async function open(page: Page, mode: string, rows: Record<string, unknown[]> = data) {
  await openStaff(page, bundle, css, mode, { data: rows });
}

test.describe("administrator dashboard", () => {
  test("every summary number is counted from the rows", async ({ page }) => {
    await open(page, "admin");
    const tile = (label: string) => page.locator("ul[aria-label=Summary] li").filter({ hasText: label });
    await expect(tile("Total registrations")).toContainText("8");
    await expect(tile("Uploaded videos")).toContainText("5"); // one uploaded + four finalized
    await expect(tile("Finalized entries")).toContainText("4");
    await expect(tile("Judges active")).toContainText("1");
    await expect(tile("Winners confirmed")).toContainText("1");
  });

  test("the competition table has the six competitions with their own counts, and a link to each competition's page", async ({ page }) => {
    await open(page, "admin");
    const rows = page.locator("table").first().locator("tbody tr");
    await expect(rows).toHaveCount(6);
    const first = rows.first();
    await expect(first).toContainText("மழலை மொழி");
    const cells = await first.locator("td").allInnerTexts();
    expect(cells.slice(0, 4).map((c) => c.trim())).toEqual(["2", "1", "3", "0"]); // draft, uploaded, finalized, withdrawn
    await expect(first.getByRole("link", { name: /Manage/ })).toHaveAttribute("href", "/admin/events/malalai-mozhi");
    expect((await rows.nth(3).locator("td").allInnerTexts()).slice(0, 4).map((c) => c.trim())).toEqual(["0", "0", "1", "1"]);
  });

  test("judge progress is computed, and an empty system says what to do instead of showing invented rows", async ({ page }) => {
    await open(page, "admin");
    const judgeRow = page.locator("table").nth(1).locator("tbody tr").first();
    await expect(judgeRow).toContainText("Judge One");
    await expect(judgeRow).toContainText("25%"); // 1 final of 4 assigned
    await open(page, "admin", {});
    await expect(page.getByText(/No judges exist yet/)).toBeVisible();
    for (const label of ["Total registrations", "Uploaded videos", "Finalized entries", "Judges active", "Winners confirmed"]) {
      await expect(page.locator("ul[aria-label=Summary] li").filter({ hasText: label })).toContainText("0");
    }
  });

  test("no dead-end buttons: every link has a destination and there is no button at all", async ({ page }) => {
    await open(page, "admin");
    expect(await page.locator("a:not([href])").count()).toBe(0);
    expect(await page.locator("button").count()).toBe(0);
  });
});

test.describe("judge dashboard", () => {
  test("counts, anonymous entry codes, status in words, and no child or parent field", async ({ page }) => {
    await open(page, "judge");
    const tile = (label: string) => page.locator("ul[aria-label=Summary] li").filter({ hasText: label });
    await expect(tile("Assigned entries")).toContainText("4");
    await expect(tile("Finalized")).toContainText("1");
    await expect(tile("Draft saved")).toContainText("1");
    await expect(tile("Not scored")).toContainText("2");
    const list = page.locator("#root ul").last();
    await expect(list.getByRole("link")).toHaveCount(4);
    await expect(list.getByRole("link").first()).toHaveAttribute("href", `/judge/entries/${ID(1)}`);
    await expect(list).toContainText("RIO-AAAAA-00003");
    await expect(list).toContainText("Finalized");
    await expect(list).toContainText("Draft saved");
    await expect(list).toContainText("Not scored");
    const text = await page.locator("#root").innerText();
    expect(text).not.toMatch(/parent name|mobile|@/i);
  });

  test("an empty list says how entries arrive", async ({ page }) => {
    await open(page, "judge", { judge_entries: [] });
    await expect(page.getByText(/No entries are assigned to you yet/)).toBeVisible();
  });

  test("the review page shows the anonymous notice, the competition, the video button, the score controls and the assigned list", async ({ page }) => {
    await open(page, `entry:${ID(2)}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Entry review");
    await expect(page.getByText(/Child and parent identity is hidden from judges/)).toBeVisible();
    await expect(page.getByText("RIO-AAAAA-00002").first()).toBeVisible();
    await expect(page.getByText("8 – 12 years")).toBeVisible();
    await expect(page.getByRole("button", { name: /Load video/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Save draft/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Submit final score/ })).toBeVisible();
    expect(await page.locator("video").count()).toBe(0); // no video address until the judge asks
  });
});

for (const vp of [
  { n: "360", w: 360, h: 780 },
  { n: "390", w: 390, h: 844 },
  { n: "768", w: 768, h: 1024 },
  { n: "1440", w: 1440, h: 900 },
] as const) {
  test.describe(`at ${vp.n}px`, () => {
    test.use({ viewport: { width: vp.w, height: vp.h }, hasTouch: vp.w < 1024, isMobile: vp.w < 768 });
    for (const mode of ["admin", "judge", `entry:${ID(2)}`]) {
      test(`${mode.split(":")[0]}: no horizontal scroll, every control at least 44px, text contrast measured`, async ({ page }) => {
        test.skip(!css, "needs the built stylesheet: run `npm run build` first");
        await open(page, mode);
        const a = await audit(page, "#root");
        expect(a.overflow).toBe(false);
        expect(a.smallTargets).toEqual([]);
        expect(a.lowContrast).toEqual([]);
      });
    }
  });
}
