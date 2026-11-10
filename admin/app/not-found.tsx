// Deliberately says nothing about what exists here: the same page is shown for a missing page and for an area the visitor may not open.
export default function NotFound() {
  return (
    <section className="mx-auto w-full max-w-[1200px] px-4 py-16 sm:px-6 lg:px-8">
      <h1 className="text-4xl font-bold">பக்கம் கிடைக்கவில்லை</h1>
      <p lang="en" className="mt-2 text-rio-slate">
        This page does not exist.
      </p>
    </section>
  );
}
