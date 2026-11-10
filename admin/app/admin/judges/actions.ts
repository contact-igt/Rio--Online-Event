"use server";

import type { InviteResult } from "@/lib/staff/invites";
import type { ProvisionResult, ResetResult } from "@/lib/staff/provisioning";

// Judge management needs Express endpoints that do not exist yet. Until then these answer "unavailable" and change nothing.

export async function inviteJudge(_input: { email: string; displayName: string }): Promise<InviteResult> {
  return { ok: false, code: "disabled" };
}

export async function provisionJudge(_input: { email: string; displayName: string; emailVerified: boolean }): Promise<ProvisionResult> {
  return { ok: false, code: "disabled" };
}

export async function resetJudgePassword(_input: { judgeId: string }): Promise<ResetResult> {
  return { ok: false, code: "disabled" };
}

export type ActiveResult = { ok: true } | { ok: false; code: "invalid" | "notAllowed" | "confirmRequired" | "notFound" | "tooMany" | "unavailable" };

export async function setJudgeActive(_input: { judgeId: string; active: boolean; confirmed?: boolean }): Promise<ActiveResult> {
  return { ok: false, code: "unavailable" };
}
