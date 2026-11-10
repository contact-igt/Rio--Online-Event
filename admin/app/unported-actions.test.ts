import { describe, expect, it } from "vitest";
import { assignJudge, confirmWinnerAction, removeWinnerAction } from "./admin/actions";
import { inviteJudge, provisionJudge, resetJudgePassword, setJudgeActive } from "./admin/judges/actions";
import { getPlaybackUrl, saveMyScore } from "./judge/actions";

// These need Express endpoints that do not exist yet. Until they do, each one must refuse and change nothing, whoever calls it.
describe("actions that wait for the new server", () => {
  it("all answer not-ok", async () => {
    const results = await Promise.all([
      assignJudge({ slug: "x", judgeId: "1" }),
      confirmWinnerAction({ slug: "x", submissionId: "1", rank: "1", displayName: "n" }),
      removeWinnerAction({ winnerId: "1" }),
      inviteJudge({ email: "a@b.co", displayName: "n" }),
      provisionJudge({ email: "a@b.co", displayName: "n", emailVerified: true }),
      resetJudgePassword({ judgeId: "1" }),
      setJudgeActive({ judgeId: "1", active: false, confirmed: true }),
      getPlaybackUrl({ entryId: "1" }),
      saveMyScore({ entryId: "1", marks: "50", comments: "", final: true }),
    ]);
    for (const r of results) expect(r.ok).toBe(false);
  });
});
