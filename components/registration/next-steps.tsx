import { Bilingual } from "@/components/auth/bilingual";
import { reg, type Msg } from "@/lib/registration/messages";
import { SubmitEntry, type SubmitDetails } from "./submit-entry";
import { UploadPanel } from "./upload-panel";

// Video upload works only for a saved entry while registration is open, the bucket is configured and uploads are switched on;
// otherwise it is shown disabled. Final submission works only for an UPLOADED entry while registration is open and final
// submission is switched on (a separate switch, off by default); otherwise its button is disabled.
export type UploadStep = { kind: "off" } | { kind: "on"; submissionId: string; hasVideo: boolean };
export type SubmitStep = { kind: "off" } | ({ kind: "on" } & SubmitDetails);

const disabledButton = "btn btn-outline w-full !border-dashed sm:w-auto";

function Disabled({ step }: { step: Msg }) {
  return (
    <>
      <button type="button" disabled className={disabledButton}>
        <span>{step.ta}</span>
        <span lang="en" className="font-medium">{step.en}</span>
      </button>
      <p className="mt-1 text-rio-slate">
        {reg.nextSteps.soon.ta}
        <span lang="en" className="block">{reg.nextSteps.soon.en}</span>
      </p>
    </>
  );
}

export function NextSteps({ upload, submit }: { upload: UploadStep; submit: SubmitStep }) {
  return (
    <section aria-labelledby="next-steps" className="card p-4 sm:p-6">
      <h2 id="next-steps" className="text-xl font-bold">
        {reg.nextSteps.title.ta} <span lang="en" className="text-rio-slate">/ {reg.nextSteps.title.en}</span>
      </h2>
      <ul className="mt-4 space-y-6">
        <li>
          {upload.kind === "on" ? (
            <>
              <p className="mb-2 font-display text-lg font-bold text-rio-navy">
                <Bilingual m={reg.nextSteps.upload} />
              </p>
              <UploadPanel key={upload.submissionId} submissionId={upload.submissionId} hasVideo={upload.hasVideo} />
            </>
          ) : (
            <Disabled step={reg.nextSteps.upload} />
          )}
        </li>
        <li>
          {submit.kind === "on" ? (
            <>
              <p className="mb-2 font-display text-lg font-bold text-rio-navy">
                <Bilingual m={reg.nextSteps.submit} />
              </p>
              <SubmitEntry key={submit.submissionId} {...submit} />
            </>
          ) : (
            <Disabled step={reg.nextSteps.submit} />
          )}
        </li>
      </ul>
    </section>
  );
}
