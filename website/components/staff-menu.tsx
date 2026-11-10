"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { staffLinks } from "@/components/nav-links";
import { Icon } from "@/components/ui/icon";

// The only public way to the staff sign-in: a small icon button at the right of the header (all screen sizes) that opens a two-item menu.
// Both items go to the one existing /staff/login page; the role in the address only changes its heading and is never used for access.

export function StaffMenu({ onOpen }: { onOpen?: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLAnchorElement | null)[]>([]);

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) button.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(true);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  function show(first: boolean) {
    onOpen?.();
    setOpen(true);
    // The items exist after this render; focus the first (or last) one so the arrow keys work at once.
    requestAnimationFrame(() => items.current[first ? 0 : staffLinks.length - 1]?.focus());
  }

  function move(e: React.KeyboardEvent) {
    const at = items.current.findIndex((el) => el === document.activeElement);
    const last = staffLinks.length - 1;
    const to = e.key === "ArrowDown" ? (at + 1) % staffLinks.length : e.key === "ArrowUp" ? (at <= 0 ? last : at - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
    if (to >= 0) {
      e.preventDefault();
      items.current[to]?.focus();
    } else if (e.key === "Tab") setOpen(false);
  }

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-label="Staff login"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="staff-menu"
        onClick={() => (open ? close(false) : show(true))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            show(e.key === "ArrowDown");
          }
        }}
        className="btn btn-outline !min-h-11 h-11 w-11 !gap-0 !p-0 aria-expanded:bg-rio-blush"
      >
        <Icon name="userCog" className="h-5 w-5" />
      </button>
      {open && (
        <ul id="staff-menu" role="menu" aria-label="Staff login" onKeyDown={move} className="absolute right-0 top-full z-40 mt-2 w-56 rounded-2xl border border-rio-navy/10 bg-white p-1.5 shadow-[0_18px_32px_-14px_rgb(23_59_120/0.4)]">
          {staffLinks.map((l, i) => (
            <li key={l.href} role="none">
              <Link
                ref={(el) => {
                  items.current[i] = el;
                }}
                href={l.href}
                role="menuitem"
                onClick={() => setOpen(false)}
                className="flex min-h-11 flex-col justify-center rounded-xl px-3 leading-tight text-rio-navy hover:bg-rio-blush focus-visible:bg-rio-blush"
              >
                <span className="text-xs">{l.ta}</span>
                <span lang="en" className="font-bold">
                  {l.en}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
