import Image from "next/image";
import Link from "next/link";
import { SiteNav } from "@/components/site-nav";

// White header: the supplied Rio Hospital logo file (public/images/rio logo v2.png), unaltered, then the navigation.
export function SiteHeader() {
  return (
    <header className="relative border-b border-rio-navy/10 bg-white">
      <div className="mx-auto flex w-full max-w-[1200px] items-center justify-between gap-3 px-4 py-2.5 sm:px-6 lg:px-8">
        <Link href="/" className="inline-flex min-h-11 items-center gap-3" aria-label="Rio Hospital for Women & Children, home">
          <Image src="/images/rio logo v2.png" alt="Rio Hospital" width={2000} height={1155} priority sizes="(min-width: 640px) 96px, 80px" className="h-10 w-auto sm:h-12" />
          <span aria-hidden="true" className="hidden h-8 w-px bg-rio-navy/20 sm:block" />
          <span lang="en" className="hidden text-sm font-semibold text-rio-slate sm:block">
            for Women &amp; Children
          </span>
        </Link>
        <SiteNav />
      </div>
    </header>
  );
}
