"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { confirmVideoUpload, requestVideoUpload } from "@/app/events/[slug]/register/video-actions";
import { Bilingual, FieldError } from "@/components/auth/bilingual";
import { reg, type Msg } from "@/lib/registration/messages";
import { readVideoDuration } from "@/lib/upload/duration";
import { checkFile, checkVideo, videoTypeOf, type UploadErrorCode, type VideoProblem } from "@/lib/upload/rules";

// Direct browser-to-bucket upload of one video for a saved entry. The checks below (type, size, length) only save the
// parent a wasted upload; the server repeats the type and size rules and verifies the stored object. The file goes to
// the bucket with a one-use presigned URL; the app server never receives the video. A failed or cancelled attempt is
// started again from the beginning, which asks the server for a fresh authorization (never reusing an old URL).

type Picked = { file: File; type: string; seconds: number };
type State =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ready"; picked: Picked }
  | { kind: "uploading"; picked: Picked; pct: number }
  | { kind: "verifying"; picked: Picked }
  | { kind: "done" }
  | { kind: "failed"; picked: Picked | null; message: Msg };

const ERRORS = reg.upload.errors;
const message = (code: UploadErrorCode): Msg => (code in reg.upload.problems ? reg.upload.problems[code as VideoProblem] : (ERRORS[code as keyof typeof ERRORS] ?? ERRORS.unavailable));

class PutError extends Error {}

function putFile(url: string, file: File, type: string, onProgress: (pct: number) => void, xhrRef: { current: XMLHttpRequest | null }): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", type); // signed into the URL: it must be exactly this
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.min(99, Math.floor((e.loaded / e.total) * 100)));
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new PutError("status")));
    xhr.onerror = () => reject(new PutError("network"));
    xhr.onabort = () => reject(new PutError("aborted"));
    xhr.send(file);
  });
}

export function UploadPanel({ submissionId, hasVideo }: { submissionId: string; hasVideo: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "idle" });
  const xhr = useRef<XMLHttpRequest | null>(null);
  const busy = state.kind === "checking" || state.kind === "uploading" || state.kind === "verifying";

  async function pick(file: File | undefined) {
    if (!file) return;
    setState({ kind: "checking" });
    const type = videoTypeOf(file);
    const basic = checkFile({ type, bytes: file.size }); // cheap checks first: never decode a file that is already refused
    if (basic) return setState({ kind: "failed", picked: null, message: reg.upload.problems[basic] });
    const seconds = await readVideoDuration(file);
    const problem = checkVideo({ type, bytes: file.size, seconds });
    if (problem) return setState({ kind: "failed", picked: null, message: reg.upload.problems[problem] });
    setState({ kind: "ready", picked: { file, type, seconds: Math.round(seconds ?? 0) } });
  }

  async function upload(picked: Picked) {
    setState({ kind: "uploading", picked, pct: 0 });
    const started = await requestVideoUpload({ submissionId, type: picked.type, bytes: picked.file.size, seconds: picked.seconds }).catch(() => null);
    if (!started) return setState({ kind: "failed", picked, message: ERRORS.network }); // the server could not be reached
    if (!started.ok) return setState({ kind: "failed", picked, message: message(started.code) });
    try {
      await putFile(started.url, picked.file, started.contentType, (pct) => setState({ kind: "uploading", picked, pct }), xhr);
    } catch (e) {
      if (e instanceof PutError && e.message === "aborted") return setState({ kind: "idle" });
      return setState({ kind: "failed", picked, message: e instanceof PutError && e.message === "status" ? ERRORS.missing : ERRORS.network });
    }
    setState({ kind: "verifying", picked });
    const finished = await confirmVideoUpload({ uploadId: started.uploadId }).catch(() => null);
    if (!finished) return setState({ kind: "failed", picked, message: ERRORS.network });
    if (!finished.ok) return setState({ kind: "failed", picked, message: message(finished.code) });
    setState({ kind: "done" });
    router.refresh();
  }

  const pct = state.kind === "uploading" ? state.pct : 0;
  const button = "btn w-full sm:w-auto";

  return (
    <div className="space-y-3">
      <p className="text-rio-slate">
        <Bilingual m={reg.upload.rules} />
      </p>
      {hasVideo && state.kind !== "done" && (
        <p className="font-semibold text-rio-navy">
          <Bilingual m={reg.upload.hasVideo} />
        </p>
      )}

      {state.kind !== "done" && (
        <div>
          <input
            id="video-file"
            type="file"
            accept="video/mp4,video/quicktime,video/webm,.mp4,.m4v,.mov,.webm"
            disabled={busy}
            onChange={(e) => {
              void pick(e.target.files?.[0]);
              e.target.value = ""; // picking the same file again must still fire a change
            }}
            className="peer sr-only"
          />
          <label
            htmlFor="video-file"
            className={`${button} btn-outline cursor-pointer peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-rio-blue ${busy ? "pointer-events-none opacity-75" : ""}`}
          >
            <span>{(hasVideo || state.kind === "ready" || state.kind === "failed" ? reg.upload.chooseOther : reg.upload.choose).ta}</span>
            <span lang="en" className="font-medium">{(hasVideo || state.kind === "ready" || state.kind === "failed" ? reg.upload.chooseOther : reg.upload.choose).en}</span>
          </label>
        </div>
      )}

      {state.kind === "checking" && (
        <p role="status" className="font-semibold text-rio-navy">
          <Bilingual m={reg.upload.checking} />
        </p>
      )}

      {(state.kind === "ready" || state.kind === "failed") && state.picked && (
        <div className="space-y-3">
          <p className="font-semibold text-rio-navy">
            <Bilingual m={reg.upload.ready(state.picked.seconds, (state.picked.file.size / (1024 * 1024)).toFixed(1))} />
          </p>
          <button type="button" onClick={() => void upload(state.picked!)} className={`${button} btn-primary`}>
            <span>{(state.kind === "failed" ? reg.upload.retry : reg.nextSteps.upload).ta}</span>
            <span lang="en" className="font-medium">{(state.kind === "failed" ? reg.upload.retry : reg.nextSteps.upload).en}</span>
          </button>
        </div>
      )}

      {state.kind === "uploading" && (
        <div className="space-y-2">
          <progress value={pct} max={100} aria-label={reg.upload.uploading(pct).en} className="h-3 w-full accent-rio-rose" />
          <p role="status" className="font-semibold text-rio-navy">
            <Bilingual m={reg.upload.uploading(pct)} />
          </p>
          <button type="button" onClick={() => xhr.current?.abort()} className={`${button} btn-outline`}>
            <span>{reg.upload.cancel.ta}</span>
            <span lang="en" className="font-medium">{reg.upload.cancel.en}</span>
          </button>
        </div>
      )}

      {state.kind === "verifying" && (
        <p role="status" className="font-semibold text-rio-navy">
          <Bilingual m={reg.upload.verifying} />
        </p>
      )}

      {state.kind === "failed" && <FieldError id="upload-error" m={state.message} />}

      {state.kind === "done" && (
        <div role="status" className="rounded-2xl border-2 border-rio-ok bg-white p-4">
          <p className="font-display text-xl font-bold text-rio-ok">
            {reg.upload.done.ta} <span lang="en" className="font-medium">/ {reg.upload.done.en}</span>
          </p>
          <p className="mt-1">
            <Bilingual m={reg.upload.doneBody} />
          </p>
        </div>
      )}
    </div>
  );
}
