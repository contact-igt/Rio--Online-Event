"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createLimiter } from "@/lib/auth/rate-limit";
import { staffSession } from "@/lib/staff/auth";
import { createInviteDeps, inviteJudgeFlow, inviteReadiness, type InviteResult } from "@/lib/staff/invites";

// Administrator-only judge management. Every action verifies the administrator's own verified session FIRST (before reading any setting or
// touching any input), so a parent, a judge or a signed-out caller always gets "notAllowed" and nothing else happens. Judges cannot call
// these: their role is not "admin". The secret key is built inside lib/staff/invites.ts and never leaves the server.

const byAdmin = createLimiter(10, 10 * 60_000);

export async function inviteJudge(input: { email: string; displayName: string }): Promise<InviteResult> {
  const session = await staffSession("admin");
  if (!session) return { ok: false, code: "notAllowed" };
  if (!byAdmin.hit(session.user.id).allowed) return { ok: false, code: "tooMany" };
  const readiness = inviteReadiness();
  if (!readiness.enabled) return { ok: false, code: "disabled" };
  if (readiness.secretKey !== "ok") return { ok: false, code: "notConfigured" };
  try {
    const result = await inviteJudgeFlow(createInviteDeps(session.supabase), { email: input?.email, displayName: input?.displayName });
    revalidatePath("/admin/judges");
    return result;
  } catch {
    return { ok: false, code: "inviteFailed" };
  }
}

export type ActiveResult = { ok: true } | { ok: false; code: "invalid" | "notAllowed" | "confirmRequired" | "notFound" | "tooMany" | "unavailable" };

const activeInput = z.object({ judgeId: z.uuid(), active: z.boolean(), confirmed: z.boolean().optional() });

/** Switches a judge on or off with the administrator's own session (row level security allows only administrators). Switching OFF needs an explicit confirmation. */
export async function setJudgeActive(input: { judgeId: string; active: boolean; confirmed?: boolean }): Promise<ActiveResult> {
  const session = await staffSession("admin");
  if (!session) return { ok: false, code: "notAllowed" };
  if (!byAdmin.hit(session.user.id).allowed) return { ok: false, code: "tooMany" };
  const parsed = activeInput.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid" };
  if (!parsed.data.active && parsed.data.confirmed !== true) return { ok: false, code: "confirmRequired" };
  try {
    const { data, error } = await session.supabase.from("judge_profiles").update({ active: parsed.data.active }).eq("user_id", parsed.data.judgeId).select("user_id");
    if (error) return { ok: false, code: error.code === "42501" ? "notAllowed" : "unavailable" };
    if (!data || data.length === 0) return { ok: false, code: "notFound" };
    revalidatePath("/admin/judges");
    return { ok: true };
  } catch {
    return { ok: false, code: "unavailable" };
  }
}
