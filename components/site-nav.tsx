"use client";

import Link from "next/link";
import { useState } from "react";
import { navLinks } from "@/components/nav-links";
import { StaffMenu } from "@/components/staff-menu";

// Wide screens show the links in a row; phones get one Menu button that opens a plain list and closes on any choice.
// The staff sign-in is one icon menu at the right edge on every screen size (opening it closes the phone menu).

export function SiteNav() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <nav aria-label="Main" className="hidden items-center gap-1 lg:flex">
        {navLinks.map((l) => (
          <Link key={l.href} href={l.href} className="inline-flex min-h-11 flex-col items-center justify-center rounded-xl px-3 text-center leading-tight text-rio-navy hover:bg-rio-blush">
            <span className="text-xs">{l.ta}</span>
            <span lang="en" className="font-bold">
              {l.en}
            </span>
          </Link>
        ))}
      </nav>

      <div className="flex items-center gap-2">
        <div className="lg:hidden">
          <button type="button" aria-expanded={open} aria-controls="mobile-nav" onClick={() => setOpen(!open)} className="btn btn-outline min-h-11 !px-4 !py-1">
            <span>மெனு</span>
            <span lang="en" className="font-semibold">Menu</span>
          </button>
          {open && (
            <div className="absolute inset-x-0 top-full z-40 border-t border-rio-navy/10 bg-white px-4 pb-4 pt-2 shadow-[0_24px_32px_-20px_rgb(23_59_120/0.5)]">
              <nav id="mobile-nav" aria-label="Main" className="mx-auto max-w-[1200px]">
                <ul>
                  {navLinks.map((l) => (
                    <li key={l.href}>
                      <Link href={l.href} onClick={() => setOpen(false)} className="flex min-h-12 items-center justify-between gap-3 border-b border-rio-navy/10 font-bold text-rio-navy last:border-0">
                        <span>
                          {l.ta} <span lang="en" className="font-semibold text-rio-slate">/ {l.en}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            </div>
          )}
        </div>
        <StaffMenu onOpen={() => setOpen(false)} />
      </div>
    </>
  );
}
