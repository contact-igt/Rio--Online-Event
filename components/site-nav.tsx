"use client";

import Link from "next/link";
import { useState } from "react";
import { navLinks, staffLinks } from "@/components/nav-links";

// Wide screens show the links in a row; phones get one Menu button that opens a plain list and closes on any choice.

export function SiteNav() {
  const [open, setOpen] = useState(false);
  const [staffOpen, setStaffOpen] = useState(false);
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

      <div className="relative hidden lg:block" onKeyDown={(e) => e.key === "Escape" && setStaffOpen(false)}>
        <button type="button" aria-expanded={staffOpen} aria-controls="staff-access" onClick={() => setStaffOpen(!staffOpen)} className="btn btn-outline min-h-11 flex-col !gap-0 !px-4 !py-1 text-sm">
          <span>பணியாளர் அணுகல்</span>
          <span lang="en" className="font-semibold">Staff Access</span>
        </button>
        {staffOpen && (
          <ul id="staff-access" aria-label="Staff Access" className="card absolute right-0 top-full z-40 mt-2 w-60 !rounded-2xl p-2">
            {staffLinks.map((l) => (
              <li key={l.href}>
                <Link href={l.href} onClick={() => setStaffOpen(false)} className="flex min-h-11 flex-col justify-center rounded-xl px-3 leading-tight text-rio-navy hover:bg-rio-blush">
                  <span className="text-xs">{l.ta}</span>
                  <span lang="en" className="font-bold">{l.en}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

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
            <nav id="mobile-staff" aria-labelledby="mobile-staff-title" className="mx-auto mt-3 max-w-[1200px] rounded-2xl bg-rio-mist p-3">
              <p id="mobile-staff-title" className="text-sm font-bold text-rio-navy">
                பணியாளர் அணுகல் <span lang="en" className="font-semibold text-rio-slate">/ Staff Access</span>
              </p>
              <ul>
                {staffLinks.map((l) => (
                  <li key={l.href}>
                    <Link href={l.href} onClick={() => setOpen(false)} className="flex min-h-11 items-center font-semibold text-rio-navy underline underline-offset-4">
                      {l.ta} <span lang="en" className="ml-1 text-rio-slate">/ {l.en}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
        )}
      </div>
    </>
  );
}
