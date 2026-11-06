// Reads a video's length in the browser, without uploading anything. This is a convenience for the parent and is NOT
// authoritative: the file stays on the device, the browser reports what it decoded, and the server only receives the
// number. Returns null when the browser cannot read the file (unsupported codec, corrupt file, or too slow).

export function readVideoDuration(file: Blob, timeoutMs = 15_000): Promise<number | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    let settled = false;
    const done = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    video.preload = "metadata";
    video.muted = true;
    video.onerror = () => done(null);
    video.onloadedmetadata = () => {
      if (Number.isFinite(video.duration)) return done(video.duration);
      // some recordings report Infinity until the end is reached: seek far ahead so the browser works out the length
      video.ontimeupdate = () => {
        video.ontimeupdate = null;
        done(Number.isFinite(video.duration) ? video.duration : null);
      };
      video.currentTime = 1e9;
    };
    video.src = url;
  });
}
