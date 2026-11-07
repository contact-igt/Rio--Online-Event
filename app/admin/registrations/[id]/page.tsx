import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Icon, type IconName } from "@/components/ui/icon";
import { formatIst } from "@/lib/admin/format";
import { eventName, loadRegistration, statusLabel, videoLabel } from "@/lib/admin/registrations";
import { requireStaff } from "@/lib/staff/auth";

export const metadata: Metadata = { title: "பதிவு விவரம் · Registration", robots: { index: false } };
export const dynamic = "force-dynamic";

function Section({ icon, title, children }: { icon: IconName; title: string; children: React.ReactNode }) {
  return (
    <section className="card p-4 sm:p-6">
      <h2 className="flex items-center gap-3 font-display text-xl font-bold text-rio-navy">
        <Icon name={icon} className="h-6 w-6 text-rio-rose" />
        {title}
      </h2>
      <dl className="mt-3 divide-y divide-rio-navy/10">{children}</dl>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-x-4 gap-y-0.5 py-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
      <dt className="text-rio-slate">{label}</dt>
      <dd className="min-w-0 font-semibold text-rio-navy [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

export default async function AdminRegistrationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  // Not an administrator: 404 (or the staff sign-in when signed out). The row is then read with this administrator's own session.
  const { supabase } = await requireStaff("admin");
  const r = await loadRegistration(supabase, id);
  if (!r) notFound();
  const event = eventName(r.eventId);
  const finalized = r.status === "finalized";

  return (
    <section className="mx-auto w-full max-w-[1200px] px-4 py-[clamp(1.5rem,5vw,3rem)] sm:px-6 lg:px-8">
      <Link href="/admin/registrations" className="inline-flex min-h-11 items-center font-semibold text-rio-rose underline underline-offset-4">
        ← Registrations
      </Link>
      <h1 className="mt-2 text-[clamp(1.75rem,5vw,2.5rem)] font-extrabold">
        <span className="font-mono">{r.entryCode}</span>
        <span className="block text-[0.6em] font-semibold text-rio-slate">{statusLabel[r.status]}</span>
      </h1>
      <p className="mt-3 flex max-w-3xl items-start gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 font-semibold text-rio-navy">
        <Icon name="lock" className="mt-0.5 h-6 w-6 shrink-0 text-amber-700" />
        <span>Personal data of a child and a parent. For administrators only.</span>
      </p>
      {!finalized && r.status !== "withdrawn" && (
        <p role="status" className="mt-3 max-w-3xl rounded-2xl bg-rio-mist p-4 font-semibold text-rio-navy">
          This is NOT a completed submission. {r.status === "draft" ? "The parent has saved details only; no video has been uploaded." : "The video is uploaded and verified, but the parent has not submitted the entry."}
        </p>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Section icon="smile" title="Child">
          <Row label="Child name">{r.childName}</Row>
          <Row label="Child age">{r.childAge} years</Row>
          <Row label="Competition">{event ? `${event.nameTa} / ${event.nameEn}` : r.eventId}</Row>
        </Section>

        <Section icon="users" title="Parent or guardian">
          <Row label="Parent / guardian name">{r.parentName}</Row>
          <Row label="Parent email"><span lang="en">{r.parentEmail}</span></Row>
          <Row label="Mobile number"><span lang="en">{r.parentMobile}</span></Row>
        </Section>

        <Section icon="check" title="Consent">
          <Row label="Guardian consent (required)">
            Recorded <span className="font-medium text-rio-slate">(wording version {r.consentVersion}, {formatIst(r.consentAt)})</span>
          </Row>
          <Row label="Media sharing (optional)">{r.mediaConsent === true ? "Agreed" : r.mediaConsent === false ? "Not agreed" : "Not recorded"}</Row>
        </Section>

        <Section icon="video" title="Progress">
          <Row label="Saved draft">{r.createdAt ? `Yes, saved ${formatIst(r.createdAt)}` : "–"}</Row>
          <Row label="Video verified">{r.hasVideo ? "Yes" : "No"} <span className="font-medium text-rio-slate">({videoLabel(r)})</span></Row>
          <Row label="Final submission">{finalized ? `Yes, submitted ${formatIst(r.finalizedAt)}` : "No"}</Row>
          {r.status === "withdrawn" && <Row label="Withdrawn">{formatIst(r.withdrawnAt)}</Row>}
          <Row label="Last updated">{formatIst(r.updatedAt)}</Row>
          <Row label="Reference number"><span className="font-mono">{r.entryCode}</span></Row>
        </Section>
      </div>
    </section>
  );
}
