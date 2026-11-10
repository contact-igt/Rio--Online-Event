import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { signOut } from "@/app/signin/actions";
import { Bilingual } from "@/components/auth/bilingual";
import { SubmitButton } from "@/components/auth/submit-button";
import { DraftList } from "@/components/registration/draft-list";
import { NextSteps } from "@/components/registration/next-steps";
import { SubmittedPanel } from "@/components/registration/submitted-panel";
import { EventSummary } from "@/components/registration/event-summary";
import { ProgressSteps } from "@/components/registration/progress-steps";
import { Icon } from "@/components/ui/icon";
import { RegistrationForm } from "@/components/registration/registration-form";
import { maskEmail } from "@/lib/auth/email";
import { emailEnabled } from "@/lib/email/config";
import { copy } from "@/lib/auth/messages";
import { registerPath } from "@/lib/auth/paths";
import { requireParent } from "@/lib/auth/session";
import { getEvent } from "@/lib/events";
import { getConsentCopy } from "@/lib/registration/consent";
import { listOwnRegistrations } from "@/lib/registration/drafts";
import { reg } from "@/lib/registration/messages";
import { draftIdSchema } from "@/lib/registration/schemas";
import { isRegistrationOpen, loadSettings } from "@/lib/registration/settings";
import { createClient } from "@/lib/supabase/server";
import { submitStep } from "@/lib/submit/server";
import { uploadStep } from "@/lib/upload/server";

export const metadata: Metadata = { title: "பதிவு · Registration", robots: { index: false } };

export default async function RegisterPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ draft?: string; saved?: string }>;
}) {
  const { slug } = await params;
  const event = getEvent(slug);
  if (!event) notFound();
  const user = await requireParent(event.slug);

  const query = await searchParams;
  const supabase = await createClient();
  const settings = await loadSettings(supabase);
  const open = isRegistrationOpen(settings);
  const consent = open ? getConsentCopy(settings?.consentVersion) : null;
  const all = await listOwnRegistrations(supabase); // the parent's own rows only (row level security)

  const mine = (all ?? []).filter((r) => r.event_id === event.number && r.status !== "withdrawn");
  const wanted = draftIdSchema.safeParse(query.draft);
  const current = wanted.success ? (mine.find((r) => r.id === wanted.data) ?? null) : null;
  const editable = current?.status === "draft";
  const justSaved = query.saved === "1" && current !== null;
  const upload = uploadStep({ open, current: current ? { id: current.id, status: current.status } : null });
  const submit = submitStep({
    open,
    current: current ? { id: current.id, status: current.status, childName: current.child_name, childAge: current.child_age, mediaConsent: current.media_consent === true } : null,
    event: { slug: event.slug, nameTa: event.nameTa, nameEn: event.nameEn },
  });

  return (
    <div className="wash">
      <section className="mx-auto w-full max-w-[1200px] px-4 py-[clamp(1.5rem,5vw,3rem)] sm:px-6 lg:px-8">
        <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-x-2 text-sm font-semibold text-rio-navy">
          <Link href="/" className="inline-flex min-h-11 items-center gap-2 underline underline-offset-4">
            <Icon name="chevron" className="h-4 w-4 rotate-180" />
            <span lang="en">Home</span>
          </Link>
          <span aria-hidden="true">/</span>
          <Link href="/competitions" className="inline-flex min-h-11 items-center underline underline-offset-4">
            <span lang="en">Competitions</span>
          </Link>
        </nav>

        <p lang="en" className="eyebrow mt-1">
          <span aria-hidden="true" className="h-px w-8 bg-current" />
          Children&apos;s Day Celebration 2026
        </p>
        <h1 className="mt-2 text-[clamp(1.9rem,6vw,3.25rem)] font-extrabold [overflow-wrap:anywhere]">
          {event.nameTa} <span lang="en">/ {event.nameEn}</span>
        </h1>

        {(open || current) && (
          <div className="mt-6">
            <ProgressSteps stage={current && (current.status === "draft" || current.status === "uploaded" || current.status === "finalized") ? current.status : "none"} />
          </div>
        )}

        {all === null && (
          <p role="alert" className="mt-5 font-semibold text-rio-error">
            <Bilingual m={reg.errors.unavailable} />
          </p>
        )}

        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start lg:gap-8">
          <EventSummary event={event} />

          <div className="min-w-0 space-y-6">
            {justSaved && (
              <div role="status" className="rounded-2xl border-2 border-rio-ok bg-white p-4">
                <p className="font-display text-xl font-bold text-rio-ok">
                  {reg.saved.title.ta} <span lang="en" className="font-medium">/ {reg.saved.title.en}</span>
                </p>
                <p className="mt-1">
                  <Bilingual m={reg.saved.body} />
                </p>
              </div>
            )}

            {!open && (
              <div className="card-soft p-5">
                <h2 className="text-2xl font-bold">
                  {reg.closed.title.ta}
                  <span lang="en" className="block text-rio-slate">{reg.closed.title.en}</span>
                </h2>
                <p className="mt-2">
                  <Bilingual m={reg.closed.body} />
                </p>
              </div>
            )}

            {mine.length > 0 && (
              <div>
                <h2 className="text-2xl font-bold">
                  {reg.list.title.ta} <span lang="en" className="text-rio-slate">/ {reg.list.title.en}</span>
                </h2>
                <div className="mt-3">
                  <DraftList slug={event.slug} items={mine} currentId={current?.id ?? null} canEdit={open} />
                </div>
              </div>
            )}

            {open && consent && (!current || editable) && (
              <div className="card p-5 sm:p-7">
                <div className="flex items-start gap-4">
                  <span aria-hidden="true" className="grid size-12 shrink-0 place-items-center rounded-2xl bg-rio-blush text-rio-rose">
                    <Icon name="edit" className="h-7 w-7" />
                  </span>
                  <div>
                    <h2 className="text-2xl font-bold">
                      {(current ? reg.form.editTitle : reg.title).ta} <span lang="en">/ {(current ? reg.form.editTitle : reg.title).en}</span>
                    </h2>
                    <p className="text-rio-slate">
                      <Bilingual m={reg.form.intro} />
                    </p>
                  </div>
                </div>
                <div className="mt-5">
                  <RegistrationForm
                    key={current?.id ?? "new"}
                    event={{ slug: event.slug, minAge: event.minAge, maxAge: event.maxAge }}
                    email={user.email ?? ""}
                    consent={{ version: consent.version, notice: consent.notice, guardian: consent.guardian, media: consent.media }}
                    draft={
                      current
                        ? {
                            id: current.id,
                            childName: current.child_name,
                            childAge: current.child_age,
                            parentName: current.parent_name,
                            mobileLocal: current.parent_mobile.replace(/\D/g, "").slice(-10),
                            mediaConsent: current.media_consent === true,
                          }
                        : null
                    }
                  />
                </div>
                {current && (
                  <Link href={registerPath(event.slug)} className="mt-4 inline-flex min-h-11 items-center font-semibold text-rio-rose underline underline-offset-4">
                    {reg.form.cancel.ta} <span lang="en">&nbsp;/ {reg.form.cancel.en}</span>
                  </Link>
                )}
              </div>
            )}

            {current && !editable && (
              <p className="font-semibold text-rio-navy">
                <Bilingual m={current.status === "uploaded" ? reg.upload.detailsFixed : reg.errors.locked} />
              </p>
            )}

            {current?.status === "finalized" ? (
              <SubmittedPanel childName={current.child_name} childAge={current.child_age} eventNameTa={event.nameTa} eventNameEn={event.nameEn} submittedAt={current.finalized_at ?? null} mediaConsent={current.media_consent === true} registeredEmail={user.email ? maskEmail(user.email) : null} emailMasked={emailEnabled() && user.email ? maskEmail(user.email) : null} reference={current.entry_code ?? null} />
            ) : (
              (open || current) && <NextSteps upload={upload} submit={submit} />
            )}

            <div className="flex flex-col items-start gap-3 border-t border-rio-navy/15 pt-6">
              <form action={signOut}>
                <SubmitButton idle={copy.account.signOut} busy={copy.account.signOut} tone="secondary" />
              </form>
              <Link href={`/events/${event.slug}`} className="inline-flex min-h-11 items-center font-semibold text-rio-rose underline underline-offset-4">
                ← {event.nameTa}
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
