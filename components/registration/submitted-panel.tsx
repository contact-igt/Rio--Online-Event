import { Bilingual } from "@/components/auth/bilingual";
import Link from "next/link";
import { Icon, type IconName } from "@/components/ui/icon";
import { formatDateBilingual } from "@/lib/registration/date";
import { reg } from "@/lib/registration/messages";

// What a parent sees once an entry has been submitted: a clear success message and the saved details, read-only.
// It never claims an e-mail was sent. When confirmation e-mail is switched on it says one WILL be sent; otherwise it says nothing about
// e-mail. The participation certificate is shown as planned, because it does not exist yet.
// The optional permission to share is shown for information and is clearly not a condition of entering.

export type SubmittedDetails = {
  childName: string;
  childAge: number;
  eventNameTa: string;
  eventNameEn: string;
  submittedAt: string | null;
  mediaConsent: boolean;
  /** The parent's own address, masked. */
  registeredEmail?: string | null;
  /** Set only when a confirmation e-mail will really be sent. */
  emailMasked: string | null;
  reference: string | null;
};

function Row({ icon, label, children }: { icon: IconName; label: { ta: string; en: string }; children: React.ReactNode }) {
  return (
    <div className="grid gap-x-4 gap-y-0.5 py-3 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] sm:items-center">
      <dt className="flex items-center gap-3 text-rio-slate">
        <Icon name={icon} className="h-5 w-5 text-rio-rose" />
        <Bilingual m={label} />
      </dt>
      <dd className="min-w-0 font-semibold text-rio-navy [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

export function SubmittedPanel(d: SubmittedDetails) {
  const date = formatDateBilingual(d.submittedAt);
  return (
    <section aria-labelledby="submitted-title" className="card p-5 sm:p-8">
      <div className="flex flex-col items-center gap-3 text-center sm:flex-row sm:text-left">
        <span aria-hidden="true" className="grid size-16 shrink-0 place-items-center rounded-full bg-[#dff5e8] text-rio-ok">
          <Icon name="check" className="h-9 w-9" />
        </span>
        <h2 id="submitted-title" className="text-[clamp(1.5rem,4vw,2.25rem)] font-extrabold">
          {reg.submit.doneTitle.ta} <span lang="en" className="block text-rio-rose">{reg.submit.doneTitle.en}</span>
        </h2>
      </div>
      <p className="mt-4">
        <Bilingual m={reg.submit.thanks} />
      </p>
      <p className="mt-2 font-semibold text-rio-navy">
        <Bilingual m={reg.submit.final} />
      </p>

      <div className="mt-5 overflow-hidden rounded-2xl border border-rio-navy/10">
        <h3 className="flex items-center gap-3 bg-rio-mist px-4 py-3 font-display text-lg font-bold">
          <Icon name="clipboard" className="h-6 w-6 text-rio-rose" />
          {reg.submit.detailsTitle.ta} <span lang="en">/ {reg.submit.detailsTitle.en}</span>
        </h3>
        <dl className="divide-y divide-rio-navy/10 px-4">
          <Row icon="trophy" label={reg.submit.competition}>
            {d.eventNameTa} <span lang="en" className="font-medium text-rio-slate">/ {d.eventNameEn}</span>
          </Row>
          <Row icon="user" label={reg.submit.child}>
            {d.childName}
          </Row>
          <Row icon="smile" label={reg.submit.age}>
            {d.childAge} <span lang="en" className="font-medium text-rio-slate">/ {d.childAge} years</span>
          </Row>
          {d.registeredEmail && (
            <Row icon="mail" label={reg.submit.registeredEmail}>
              <span lang="en">{d.registeredEmail}</span>
            </Row>
          )}
          <Row icon="check" label={reg.submit.status}>
            <span className="inline-block rounded-full bg-[#dff5e8] px-3 py-0.5 text-rio-ok">
              {reg.submit.submitted.ta} <span lang="en">/ {reg.submit.submitted.en}</span>
            </span>
          </Row>
          <Row icon="video" label={reg.submit.video}>
            {reg.submit.videoDone.ta} <span lang="en" className="font-medium text-rio-slate">/ {reg.submit.videoDone.en}</span>
          </Row>
          {d.reference && (
            <Row icon="list" label={reg.submit.reference}>
              <span className="font-mono">{d.reference}</span>
            </Row>
          )}
          {date && (
            <Row icon="calendar" label={reg.submit.submittedOn}>
              {date}
            </Row>
          )}
        </dl>
      </div>

      {d.emailMasked && (
        <p className="card-soft mt-4 flex items-start gap-3 p-4 font-semibold text-rio-navy">
          <Icon name="mail" className="mt-0.5 h-6 w-6 text-rio-rose" />
          <Bilingual m={reg.submit.emailNote(d.emailMasked)} />
        </p>
      )}
      <p className="mt-4 flex items-start gap-3 rounded-2xl bg-rio-mist p-4 text-rio-navy">
        <Icon name="info" className="mt-0.5 h-6 w-6" />
        <span>
          <Bilingual m={reg.submit.certificate} />
          <Bilingual m={reg.submit.winners} className="mt-2 block" />
        </span>
      </p>
      <p className="mt-4 text-rio-slate">
        <Bilingual m={d.mediaConsent ? reg.submit.mediaGiven : reg.submit.mediaNotGiven} />
      </p>

      <p className="mt-6">
        <Link href="/competitions" className="btn btn-outline w-full sm:w-auto">
          <span>{reg.submit.viewCompetitions.ta}</span>
          <span lang="en" className="font-medium">/ {reg.submit.viewCompetitions.en}</span>
        </Link>
      </p>
    </section>
  );
}
