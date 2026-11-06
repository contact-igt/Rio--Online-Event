"use client";

import { useRef, useState } from "react";
import { getPlaybackUrl } from "@/app/judge/actions";
import { Bilingual, FieldError } from "@/components/auth/bilingual";
import type { Msg } from "@/lib/auth/messages";
import { staff } from "@/lib/staff/messages";

// Plays one assigned entry's private video. The page never contains a video address: pressing the button asks the server, which
// checks this judge's assignment and signs a link that lives five minutes. A second press while a request runs is ignored.

type State = { kind: "idle" } | { kind: "loading" } | { kind: "ready"; url: string } | { kind: "failed"; message: Msg };
const E = staff.judge.playbackErrors;
const button = "btn btn-primary w-full sm:w-auto";

export function PlaybackPanel({ entryId, available }: { entryId: string; available: boolean }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const inflight = useRef(false);

  if (!available) {
    return (
      <p className="rounded-xl border-l-4 border-rio-pink bg-rio-blush p-3 font-semibold text-rio-navy">
        <Bilingual m={staff.judge.playbackOff} />
      </p>
    );
  }

  async function load() {
    if (inflight.current) return;
    inflight.current = true;
    setState({ kind: "loading" });
    const result = await getPlaybackUrl({ entryId }).catch(() => null);
    inflight.current = false;
    if (!result) return setState({ kind: "failed", message: E.network });
    if (!result.ok) return setState({ kind: "failed", message: E[result.code] ?? E.unavailable });
    setState({ kind: "ready", url: result.url });
  }

  return (
    <div className="space-y-3">
      {state.kind === "ready" && (
        <video
          key={state.url}
          src={state.url}
          controls
          playsInline
          preload="metadata"
          controlsList="nodownload noplaybackrate"
          disablePictureInPicture
          className="aspect-video w-full rounded-xl bg-rio-ink"
          aria-label="Entry video"
        />
      )}
      {state.kind === "failed" && <FieldError id="playback-error" m={state.message} />}
      <button type="button" onClick={() => void load()} disabled={state.kind === "loading"} aria-busy={state.kind === "loading"} className={button}>
        <span>{(state.kind === "ready" ? staff.judge.reloadVideo : staff.judge.loadVideo).ta}</span>
        <span lang="en" className="font-medium">{(state.kind === "ready" ? staff.judge.reloadVideo : staff.judge.loadVideo).en}</span>
      </button>
      <p className="text-rio-slate">
        <Bilingual m={staff.judge.videoNote} />
      </p>
    </div>
  );
}
