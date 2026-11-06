import { readdirSync, readFileSync } from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";
import { bundleFixture } from "./fixtures/bundle";

// Offline browser tests for the video upload panel (M4A). The REAL NextSteps and UploadPanel run in the installed Chrome;
// the server actions are fakes (e2e/fixtures/fake-video-actions.ts) and the "bucket" is https://r2.test, intercepted by
// the test. No Cloudflare, no Supabase, no real video: the sample files are tiny generated WAV clips labelled as video,
// which the browser can still measure, so the real duration reader runs. Real R2 behaviour is UNVERIFIED.

let bundle = "";
let css = ""; // the built stylesheet, when it exists, so the 360 px check measures the real layout

test.beforeAll(async () => {
  try {
    css = readdirSync(".next/static/css").filter((f) => f.endsWith(".css")).map((f) => readFileSync(`.next/static/css/${f}`, "utf8")).join("\n");
  } catch {
    css = "";
  }
  bundle = await bundleFixture("e2e/fixtures/upload-entry.tsx", {
    "@/app/events/[slug]/register/video-actions": "e2e/fixtures/fake-video-actions.ts",
    "@/app/events/[slug]/register/submit-actions": "e2e/fixtures/fake-submit-actions.ts", // NextSteps also renders the submit step
    "next/navigation": "e2e/fixtures/fake-navigation.ts",
  });
});

type Scripted = { request?: unknown[]; confirm?: unknown[] };
type Put = { url: string; contentType: string | undefined; bytes: number };

async function open(page: Page, hash = "", script: Scripted = {}) {
  await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root" style="padding:16px"></div>');
  if (css) await page.addStyleTag({ content: css });
  await page.evaluate(({ h, s }) => {
    location.hash = h;
    window.__script = s as Window["__script"];
  }, { h: hash, s: script });
  await page.addScriptTag({ content: bundle });
  await expect(page.getByRole("button", { name: /Submit entry/ })).toBeVisible();
}

/** The fake bucket: records each PUT and answers as scripted. `hold` keeps a PUT open until released. */
function bucket(page: Page, answers: ("ok" | "403" | "abort" | "hold")[] = []) {
  const puts: Put[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  void page.route("https://r2.test/**", async (route: Route) => {
    const req = route.request();
    puts.push({ url: req.url(), contentType: req.headers()["content-type"], bytes: req.postDataBuffer()?.length ?? 0 });
    const mode = answers.shift() ?? "ok";
    if (mode === "abort") return route.abort("connectionreset");
    if (mode === "403") return route.fulfill({ status: 403, body: "expired" });
    if (mode === "hold") await gate;
    return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", etag: '"x"' }, body: "" });
  });
  return { puts, release: () => release() };
}

type Sample = { name?: string; type?: string; seconds?: number; bytes?: number; garbage?: boolean };

/** Puts a generated file into the panel's file input, the way choosing one in the browser would. */
async function pick(page: Page, s: Sample) {
  await page.evaluate(
    ({ name = "clip.mp4", type = "video/mp4", seconds = 31, bytes, garbage }) => {
      const rate = 8000;
      const dataLength = Math.max(0, Math.floor(seconds * rate));
      const total = Math.max(bytes ?? 0, 44 + dataLength);
      const buf = new Uint8Array(total);
      if (garbage) {
        for (let i = 0; i < total; i++) buf[i] = (i * 2654435761) >>> 24; // noise, not media
      } else {
        const v = new DataView(buf.buffer);
        const tag = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
        tag(0, "RIFF");
        v.setUint32(4, 36 + dataLength, true);
        tag(8, "WAVEfmt ");
        v.setUint32(16, 16, true);
        v.setUint16(20, 1, true);
        v.setUint16(22, 1, true);
        v.setUint32(24, rate, true);
        v.setUint32(28, rate, true);
        v.setUint16(32, 1, true);
        v.setUint16(34, 8, true);
        tag(36, "data");
        v.setUint32(40, dataLength, true);
        buf.fill(128, 44, 44 + dataLength);
      }
      const input = document.getElementById("video-file") as HTMLInputElement;
      const dt = new DataTransfer();
      dt.items.add(new File([buf], name, { type }));
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    s,
  );
}
/** A large file without allocating it: one megabyte repeated, so the size check sees more than 100 MB. */
async function pickHuge(page: Page) {
  await page.evaluate(() => {
    const chunk = new Uint8Array(1024 * 1024);
    const input = document.getElementById("video-file") as HTMLInputElement;
    const dt = new DataTransfer();
    dt.items.add(new File(Array.from({ length: 101 }, () => chunk), "huge.mp4", { type: "video/mp4" }));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

const calls = (page: Page) => page.evaluate(() => window.__calls ?? []);
const upload = (page: Page) => page.getByRole("button", { name: /^Upload video|Upload video$/ }).filter({ hasText: "Upload video" });
const retry = (page: Page) => page.getByRole("button", { name: /Try again/ });

test.describe("choosing a video", () => {
  test("a 31-second video is measured in the browser and offered for upload", async ({ page }) => {
    await open(page);
    await pick(page, { seconds: 31 });
    await expect(page.getByText("31 seconds").first()).toBeVisible();
    await expect(upload(page).first()).toBeEnabled();
    expect(await calls(page)).toEqual([]); // choosing a file contacts no server
  });

  test("the exact limits are accepted: 30 and 90 seconds", async ({ page }) => {
    await open(page);
    for (const seconds of [30, 90]) {
      await pick(page, { seconds });
      await expect(page.getByText(`${seconds} seconds`).first()).toBeVisible();
    }
  });

  const refused: [string, Sample | "huge", RegExp][] = [
    ["shorter than 30 seconds", { seconds: 20 }, /shorter than 30 seconds/],
    ["longer than 90 seconds", { seconds: 95 }, /longer than 90 seconds/],
    ["a file that is not a video type", { type: "text/plain", name: "notes.txt", bytes: 200_000 }, /Choose an MP4, MOV or WebM/],
    ["a file that is too small", { seconds: 6, bytes: 50_000 }, /too small/],
    ["a file the browser cannot read", { garbage: true, bytes: 200_000 }, /could not read this video/],
    ["a file over 100 MB", "huge", /over 100 MB/],
  ];
  for (const [label, sample, message] of refused) {
    test(`refuses ${label}, in both languages, and nothing is requested or uploaded`, async ({ page }) => {
      const r2 = bucket(page);
      await open(page);
      if (sample === "huge") await pickHuge(page);
      else await pick(page, sample);
      await expect(page.locator("#upload-error")).toContainText(message);
      await expect(page.locator("#upload-error")).toContainText(/[஀-௿]/); // the Tamil line is there too
      await expect(upload(page)).toHaveCount(0);
      expect(await calls(page)).toEqual([]);
      expect(r2.puts).toEqual([]);
    });
  }
});

test.describe("uploading", () => {
  test("asks the server for an authorization, PUTs exactly the file with the signed type, shows progress, then confirms", async ({ page }) => {
    const r2 = bucket(page, ["hold"]);
    await open(page);
    await pick(page, { seconds: 31 });
    await upload(page).first().click();

    await expect(page.locator("progress")).toBeVisible(); // a real progress bar while the PUT is open
    await expect(page.getByText(/Uploading… \d+%/)).toBeVisible();
    await expect.poll(() => r2.puts.length).toBe(1);
    r2.release();
    await expect(page.getByText("Video uploaded").first()).toBeVisible();

    const [request, confirm] = await calls(page);
    expect(request!.fn).toBe("request");
    expect(request!.input).toMatchObject({ submissionId: "bbbbbbbb-0000-4000-8000-0000000000b1", type: "video/mp4", seconds: 31 });
    const put = r2.puts[0]!;
    expect(put.url).toMatch(/^https:\/\/r2\.test\/pending\/00000000-0000-4000-8000-\d{12}\?/);
    expect(put.contentType).toBe("video/mp4");
    expect(put.bytes).toBe((request!.input as { bytes: number }).bytes);
    expect(confirm).toMatchObject({ fn: "confirm", input: { uploadId: put.url.match(/pending\/([^?]+)/)![1] } });
    expect(await page.evaluate(() => window.__refreshed)).toBe(1); // the page is refreshed to show the new state
    await expect(page.getByText("Your video is stored privately")).toBeVisible();
  });

  test("an expired or rejected URL (403) fails clearly, and Try again asks for a FRESH authorization", async ({ page }) => {
    const r2 = bucket(page, ["403", "ok"]);
    await open(page);
    await pick(page, { seconds: 40 });
    await upload(page).first().click();
    await expect(page.locator("#upload-error")).toContainText("The upload did not finish");
    expect((await calls(page)).filter((c) => c.fn === "confirm")).toEqual([]); // a failed PUT is never confirmed

    await retry(page).click();
    await expect(page.getByText("Video uploaded").first()).toBeVisible();
    expect(r2.puts).toHaveLength(2);
    expect(r2.puts[1]!.url).not.toBe(r2.puts[0]!.url); // never the old URL again
    const sent = await calls(page);
    const requests = sent.filter((c) => c.fn === "request");
    const confirms = sent.filter((c) => c.fn === "confirm");
    expect(requests).toHaveLength(2);
    expect(confirms).toHaveLength(1);
    expect(confirms[0]!.input.uploadId).toBe(r2.puts[1]!.url.match(/pending\/([^?]+)/)![1]); // only the second upload is confirmed
  });

  test("a dropped connection gets its own message and the retry works", async ({ page }) => {
    const r2 = bucket(page, ["abort", "ok"]);
    await open(page);
    await pick(page, { seconds: 35 });
    await upload(page).first().click();
    await expect(page.locator("#upload-error")).toContainText("The connection dropped");
    await retry(page).click();
    await expect(page.getByText("Video uploaded").first()).toBeVisible();
    expect(r2.puts).toHaveLength(2);
  });

  test("Cancel stops the upload, confirms nothing, and a new file can be chosen", async ({ page }) => {
    const r2 = bucket(page, ["hold"]);
    await open(page);
    await pick(page, { seconds: 33 });
    await upload(page).first().click();
    await expect.poll(() => r2.puts.length).toBe(1);
    await page.getByRole("button", { name: /Cancel/ }).click();
    await expect(page.getByText("Choose a video").first()).toBeVisible();
    await expect(page.locator("#upload-error")).toHaveCount(0);
    expect((await calls(page)).filter((c) => c.fn === "confirm")).toEqual([]);
    r2.release();
    await pick(page, { seconds: 34 });
    await expect(page.getByText("34 seconds").first()).toBeVisible();
  });
});

test.describe("when the server says no", () => {
  const cases: [string, unknown, RegExp][] = [
    ["closed", { ok: false, code: "closed" }, /Registration is closed/],
    ["not the parent's entry", { ok: false, code: "notFound" }, /could not find this entry/],
    ["too many attempts", { ok: false, code: "tooMany" }, /Too many attempts/],
    ["entry locked", { ok: false, code: "locked" }, /can no longer be changed/],
    ["server unavailable", { ok: false, code: "unavailable" }, /unavailable right now/],
    ["the server cannot be reached", "throw", /connection dropped/],
  ];
  for (const [label, step, message] of cases) {
    test(`${label}: a clear message, and nothing is uploaded`, async ({ page }) => {
      const r2 = bucket(page);
      await open(page, "", { request: [step] });
      await pick(page, { seconds: 31 });
      await upload(page).first().click();
      await expect(page.locator("#upload-error")).toContainText(message);
      expect(r2.puts).toEqual([]);
    });
  }

  test("a stored object that does not match is reported, and the retry uses a fresh authorization", async ({ page }) => {
    const r2 = bucket(page);
    await open(page, "", { confirm: [{ ok: false, code: "mismatch" }] });
    await pick(page, { seconds: 31 });
    await upload(page).first().click();
    await expect(page.locator("#upload-error")).toContainText("did not match");
    await retry(page).click();
    await expect(page.getByText("Video uploaded").first()).toBeVisible();
    const ids = (await calls(page)).filter((c) => c.fn === "confirm").map((c) => c.input.uploadId);
    expect(new Set(ids).size).toBe(2);
    expect(r2.puts).toHaveLength(2);
  });
});

test.describe("states, keyboard and phone", () => {
  test("an entry that already has a video says so, and offers to replace it", async ({ page }) => {
    await open(page, "#has");
    await expect(page.getByText("This entry has a video")).toBeVisible();
    await expect(page.getByText("Choose a different video").first()).toBeVisible();
  });

  test("final submission stays disabled, and with uploads off both steps are disabled with no file input", async ({ page }) => {
    await open(page);
    await expect(page.getByRole("button", { name: /Submit entry/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: /Submit entry/ })).toHaveCount(1);
    await page.evaluate(() => (location.hash = "#off"));
    await open(page, "#off");
    await expect(page.getByRole("button", { name: /Upload video/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: /Submit entry/ })).toBeDisabled();
    await expect(page.locator("input[type=file]")).toHaveCount(0);
  });

  test("keyboard only: Tab to the file field, open the chooser with Space, choose, and start with Enter", async ({ page }) => {
    bucket(page);
    await open(page);
    await page.keyboard.press("Tab");
    await expect(page.locator("#video-file")).toBeFocused();
    const chooser = page.waitForEvent("filechooser");
    await page.keyboard.press("Space");
    await (await chooser).setFiles({ name: "clip.mp4", mimeType: "video/mp4", buffer: Buffer.from(wav(31)) });
    await expect(page.getByText("31 seconds").first()).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(upload(page).first()).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Video uploaded").first()).toBeVisible();
  });

  test.describe("phone-sized touch screen", () => {
    test.use({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true });

    test("tap through choosing and uploading, with no horizontal scroll", async ({ page }) => {
      bucket(page);
      await open(page);
      await pick(page, { seconds: 45 });
      await expect(page.getByText("45 seconds").first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await upload(page).first().tap();
      await expect(page.getByText("Video uploaded").first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  });
});

/** A WAV clip as bytes, for the keyboard test's file chooser. */
function wav(seconds: number): Uint8Array {
  const rate = 8000;
  const n = seconds * rate;
  const buf = new Uint8Array(44 + n);
  const v = new DataView(buf.buffer);
  const tag = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  tag(0, "RIFF");
  v.setUint32(4, 36 + n, true);
  tag(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  tag(36, "data");
  v.setUint32(40, n, true);
  buf.fill(128, 44);
  return buf;
}

// Video upload at every width that matters: phone, tablet and desktop, in the idle, has-video and (while a file is checked) ready states.
for (const vp of [{ n: 360, h: 780 }, { n: 390, h: 844 }, { n: 768, h: 1024 }, { n: 1440, h: 900 }] as const) {
  test.describe(`upload panel at ${vp.n}px`, () => {
    test.use({ viewport: { width: vp.n, height: vp.h }, hasTouch: vp.n < 1024, isMobile: vp.n < 768 });
    for (const state of ["", "#has"] as const) {
      test(`fits without horizontal scroll and every control is at least 44px (${state || "no video yet"})`, async ({ page }) => {
        test.skip(!css, "needs the built stylesheet: run `npm run build` first");
        await open(page, state);
        await pick(page, { seconds: 45 });
        await expect(page.getByText("45 seconds").first()).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        const small = await page.evaluate(() =>
          [...document.querySelectorAll("#root button, #root label, #root a, #root input[type=file]")]
            .filter((e) => e.getBoundingClientRect().width > 0 && getComputedStyle(e).display !== "inline" && !e.closest(".sr-only") && !e.classList.contains("sr-only"))
            .map((e) => ({ t: (e.textContent ?? "").trim().slice(0, 24), h: Math.round(e.getBoundingClientRect().height) }))
            .filter((x) => x.h < 44),
        );
        expect(small).toEqual([]);
        const cut = await page.evaluate(() => [...document.querySelectorAll("#root *")].filter((e) => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().right > window.innerWidth + 1).length);
        expect(cut).toBe(0);
      });
    }
  });
}
