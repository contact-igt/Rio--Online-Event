import { Icon } from "@/components/ui/icon";
import { reg } from "@/lib/registration/messages";

// The four steps of taking part, with the state written in words (Done, Next, Later) as well as shown, so a parent always knows whether this
// is only a saved draft or a final submission. Purely informational; the server decides what is allowed.

export type Stage = "none" | "draft" | "uploaded" | "finalized";

const order: Stage[] = ["none", "draft", "uploaded", "finalized"];

export function ProgressSteps({ stage }: { stage: Stage }) {
  const at = order.indexOf(stage);
  const steps = [
    { m: reg.progress.choose, done: true },
    { m: reg.progress.details, done: at >= 1 },
    { m: reg.progress.video, done: at >= 2 },
    { m: reg.progress.submit, done: at >= 3 },
  ];
  const nextIndex = steps.findIndex((s) => !s.done);
  return (
    <section aria-labelledby="progress-title">
      <h2 id="progress-title" className="sr-only">
        {reg.progress.title.ta} / {reg.progress.title.en}
      </h2>
      <ol className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-4">
        {steps.map((s, i) => {
          const state = s.done ? reg.progress.done : i === nextIndex ? reg.progress.next : reg.progress.later;
          const current = i === nextIndex;
          return (
            <li key={s.m.en} aria-current={current ? "step" : undefined} className="flex min-w-0 items-start gap-3">
              <span aria-hidden="true" className={`grid size-10 shrink-0 place-items-center rounded-full font-display font-bold ${s.done ? "bg-rio-mist text-rio-navy" : current ? "bg-rio-rose text-white shadow-[0_10px_18px_-10px_rgb(212_32_107/0.9)]" : "border-2 border-rio-line bg-white text-rio-slate"}`}>
                {s.done ? <Icon name="check" className="h-5 w-5" /> : i + 1}
              </span>
              <p className="min-w-0 leading-snug">
                <span className={`block font-bold [overflow-wrap:anywhere] ${current ? "text-rio-rose" : "text-rio-navy"}`}>
                  {i + 1}. {s.m.en}
                </span>
                <span lang="ta" className="block text-sm text-rio-slate [overflow-wrap:anywhere]">
                  {s.m.ta}
                </span>
                <span className={`mt-0.5 block text-xs font-bold uppercase tracking-wide ${current ? "text-rio-rose" : "text-rio-slate"}`}>
                  {state.en} <span lang="ta" className="normal-case tracking-normal">/ {state.ta}</span>
                </span>
              </p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
