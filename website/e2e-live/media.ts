import type { Browser } from "@playwright/test";
import type { MediaFacts } from "../scripts/live-upload";

// Makes a GENUINE video in the real Chrome that runs the tests: an animated canvas recorded with MediaRecorder into a WebM
// file, then loaded back into a <video> element to prove it can be decoded, has the expected duration and size, and really
// plays. No real person, child, face or voice is involved: the picture is a changing colour with a frame counter.
// Nothing here contacts any server.

export async function generateWebm(browser: Browser, seconds: number): Promise<{ data: Buffer; facts: MediaFacts }> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.setContent('<canvas id="c" width="320" height="240"></canvas>');
    const out = await page.evaluate(async (secs) => {
      const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
      if (!mime) throw new Error("this browser cannot record WebM");
      const canvas = document.getElementById("c") as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      let frame = 0;
      const draw = () => {
        ctx.fillStyle = `hsl(${(frame * 3) % 360} 70% 45%)`;
        ctx.fillRect(0, 0, 320, 240);
        ctx.fillStyle = "#fff";
        ctx.font = "28px sans-serif";
        ctx.fillText(`frame ${frame}`, 20, 120);
        ctx.fillRect((frame * 4) % 300, 200, 20, 20);
        frame += 1;
      };
      draw();
      const timer = setInterval(draw, 33);

      // Warm-up: the first recording in a fresh browser needs its encoder started, which takes about a second on a quiet machine
      // but can take many seconds on a busy one (a 6 s clip then came out empty). Record briefly until the FIRST chunk arrives
      // (at most 30 s) and throw it away, so the real recording below starts with a running encoder and its length is not eaten.
      const warmStream = canvas.captureStream(30);
      const warm = new MediaRecorder(warmStream, { mimeType: mime, videoBitsPerSecond: 300_000 });
      let warmed = false;
      warm.ondataavailable = (e) => {
        if (e.data.size > 0) warmed = true;
      };
      const warmStopped = new Promise<void>((resolve) => (warm.onstop = () => resolve()));
      warm.start(250);
      const warmStart = performance.now();
      while (!warmed && performance.now() - warmStart < 30_000) await new Promise((r) => setTimeout(r, 100));
      warm.stop();
      await warmStopped;
      warmStream.getTracks().forEach((t) => t.stop());
      if (!warmed) throw new Error("the recorder produced no data within 30 s (is the machine too busy?)");

      const stream = canvas.captureStream(30);
      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 300_000 });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
      const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
      recorder.start(1000);
      await new Promise((r) => setTimeout(r, secs * 1000));
      recorder.stop();
      await stopped;
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      if (chunks.length === 0) throw new Error("the recorder produced no data");
      const blob = new Blob(chunks, { type: "video/webm" });

      // load it back: can it be decoded, how long is it, how big is the picture, and does it actually play?
      const video = document.createElement("video");
      video.muted = true;
      video.preload = "auto";
      video.src = URL.createObjectURL(blob);
      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error("the recording cannot be decoded"));
      });
      if (!Number.isFinite(video.duration)) {
        // a live recording has no length in its header until the end is reached
        await new Promise<void>((resolve) => {
          video.ontimeupdate = () => {
            video.ontimeupdate = null;
            resolve();
          };
          video.currentTime = 1e9;
        });
      }
      const duration = video.duration;
      video.currentTime = 0;
      await video.play();
      await new Promise((r) => setTimeout(r, 1500));
      const played = video.currentTime > 0.5;
      video.pause();

      const dataUrl: string = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(blob);
      });
      return { b64: dataUrl.slice(dataUrl.indexOf(",") + 1), facts: { bytes: blob.size, duration, width: video.videoWidth, height: video.videoHeight, played, mime: mime } };
    }, seconds);
    return { data: Buffer.from(out.b64, "base64"), facts: out.facts };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// MP4 fixture. Chrome's MediaRecorder writes MP4 (H.264) as a FRAGMENTED file whose header says "duration 0". A phone camera writes an
// ordinary MP4 with the duration in the header. The fixture is the recorded file converted to that ordinary layout (e2e-live/mp4.ts):
// the encoded video is untouched, only the container is rebuilt. It is then loaded back and PLAYED in Chrome to prove it still decodes.

import { describeMp4, remuxFragmentedMp4 } from "./mp4";

const MP4_MIME = "video/mp4;codecs=avc1.42E01E";

/** Loads bytes into a <video> in a throw-away page: decoded? how long? how big is the picture? does it really play? */
export async function probePlayback(browser: Browser, data: Buffer, mime: string): Promise<MediaFacts> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.setContent("<video id=v muted></video>");
    return await page.evaluate(async ({ b64, mime }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const video = document.getElementById("v") as HTMLVideoElement;
      video.muted = true;
      video.src = URL.createObjectURL(new Blob([bytes], { type: mime }));
      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error("the file cannot be decoded"));
      });
      const duration = video.duration;
      await video.play();
      await new Promise((r) => setTimeout(r, 1500));
      const played = video.currentTime > 0.5;
      video.pause();
      return { bytes: bytes.length, duration, width: video.videoWidth, height: video.videoHeight, played, mime };
    }, { b64: data.toString("base64"), mime });
  } finally {
    await context.close();
  }
}

/** Records `seconds` of an animated canvas as fragmented MP4 in the real Chrome (no person, voice or personal data). */
async function recordFragmentedMp4(browser: Browser, seconds: number): Promise<Buffer> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.setContent('<canvas id="c" width="320" height="240"></canvas>');
    const b64 = await page.evaluate(async ({ secs, mime }) => {
      if (!MediaRecorder.isTypeSupported(mime)) throw new Error("this browser cannot record MP4");
      const canvas = document.getElementById("c") as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      let frame = 0;
      const draw = () => {
        ctx.fillStyle = `hsl(${(frame * 3) % 360} 70% 45%)`;
        ctx.fillRect(0, 0, 320, 240);
        ctx.fillStyle = "#fff";
        ctx.font = "28px sans-serif";
        ctx.fillText(`frame ${frame}`, 20, 120);
        ctx.fillRect((frame * 4) % 300, 200, 20, 20);
        frame += 1;
      };
      draw();
      const timer = setInterval(draw, 33);
      // warm-up: start the encoder on a throw-away recording until its first chunk arrives (see generateWebm)
      const warmStream = canvas.captureStream(30);
      const warm = new MediaRecorder(warmStream, { mimeType: mime, videoBitsPerSecond: 300_000 });
      let warmed = false;
      warm.ondataavailable = (e) => {
        if (e.data.size > 0) warmed = true;
      };
      const warmStopped = new Promise<void>((resolve) => (warm.onstop = () => resolve()));
      warm.start(250);
      const t0 = performance.now();
      while (!warmed && performance.now() - t0 < 30_000) await new Promise((r) => setTimeout(r, 100));
      warm.stop();
      await warmStopped;
      warmStream.getTracks().forEach((t) => t.stop());
      if (!warmed) throw new Error("the recorder produced no data within 30 s (is the machine too busy?)");

      const stream = canvas.captureStream(30);
      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 300_000 });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
      const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
      recorder.start(1000);
      await new Promise((r) => setTimeout(r, secs * 1000));
      recorder.stop();
      await stopped;
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      if (chunks.length === 0) throw new Error("the recorder produced no data");
      const url: string = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(new Blob(chunks, { type: "video/mp4" }));
      });
      return url.slice(url.indexOf(",") + 1);
    }, { secs: seconds, mime: MP4_MIME });
    return Buffer.from(b64, "base64");
  } finally {
    await context.close();
  }
}

export type Mp4Fixture = { data: Buffer; facts: MediaFacts; header: { fragmented: boolean; seconds: number; samples: number } };

/** A genuine, playable, ordinary MP4 with the true duration in its header. Contacts no server. */
export async function generateMp4(browser: Browser, seconds: number): Promise<Mp4Fixture> {
  const recorded = await recordFragmentedMp4(browser, seconds);
  const data = remuxFragmentedMp4(recorded);
  const facts = await probePlayback(browser, data, "video/mp4"); // the converted file, decoded and played again in Chrome
  const header = describeMp4(data);
  return { data, facts, header: { fragmented: header.fragmented, seconds: header.seconds, samples: header.samples } };
}
