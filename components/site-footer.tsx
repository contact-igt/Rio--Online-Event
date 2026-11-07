import Image from "next/image";
import Link from "next/link";
import { navLinks, staffLinks } from "@/components/nav-links";

// Navy footer. The logo file has dark lettering, so it sits on a white chip rather than being recoloured.
export function SiteFooter() {
  return (
    <footer className="on-navy bg-rio-navy text-white">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-4 py-8 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
        <div className="flex items-center gap-4">
          <span className="rounded-xl bg-white p-2">
            <Image src="/images/rio logo v2.png" alt="Rio Hospital" width={2000} height={1155} sizes="80px" className="h-9 w-auto" />
          </span>
          <p className="leading-snug">
            <span lang="en" className="block font-semibold">
              Rio Hospital for Women &amp; Children
            </span>
            <span className="block text-white/90">குழந்தைகள் தினக் கொண்டாட்டம் 2026</span>
            <span lang="en" className="block text-sm text-white/90">
              Children&apos;s Day Celebration 2026
            </span>
          </p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6">
          {navLinks.map((l) => (
            <Link key={l.href} href={l.href} className="inline-flex min-h-11 items-center font-semibold underline-offset-4 hover:underline">
              <span lang="en">{l.en}</span>
            </Link>
          ))}
          {staffLinks.map((l) => (
            <Link key={l.href} href={l.href} className="inline-flex min-h-11 items-center text-white/80 underline-offset-4 hover:underline">
              <span lang="en">{l.en}</span>
            </Link>
          ))}
          <a href="https://www.riochildrenshospital.com/" target="_blank" rel="noopener noreferrer" lang="en" className="inline-flex min-h-11 items-center font-semibold text-rio-pink-soft underline underline-offset-4">
            riochildrenshospital.com
          </a>
        </nav>
      </div>
    </footer>
  );
}
