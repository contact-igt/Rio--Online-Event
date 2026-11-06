import Link from "next/link";

export default function NotFound() {
  return (
    <section className="mx-auto w-full max-w-[1200px] px-4 py-16 sm:px-6 lg:px-8">
      <h1 className="text-4xl font-bold">பக்கம் கிடைக்கவில்லை</h1>
      <p lang="en" className="mt-2 text-rio-slate">
        This page does not exist. Go back to the list of competitions.
      </p>
      <Link href="/competitions" className="btn btn-primary mt-6">
        போட்டிகளுக்குச் செல்க <span lang="en">&nbsp;/ See competitions</span>
      </Link>
    </section>
  );
}
