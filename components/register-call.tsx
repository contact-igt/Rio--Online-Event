import Link from "next/link";
import { Icon } from "@/components/ui/icon";

// The call to register for ONE competition. It carries the chosen competition in the address, so nobody picks it twice: signed-out parents
// are sent to sign-in with the competition remembered, and come back to this competition's registration. While registration is closed
// it says so plainly instead of leading to a dead end. The registration page and the database still decide what is allowed.

export function RegisterCall({ slug, open }: { slug: string; open: boolean }) {
  if (!open) {
    return (
      <p className="card-soft px-4 py-3 font-semibold text-rio-navy">
        பதிவு விரைவில் தொடங்கும் <span lang="en" className="font-medium text-rio-slate">/ Registration opens soon</span>
      </p>
    );
  }
  return (
    <Link href={`/events/${slug}/register`} className="btn btn-primary min-h-12 flex-col !gap-0 px-7">
      <span>இந்தப் போட்டிக்குப் பதிவு செய்க</span>
      <span lang="en" className="flex items-center gap-2 text-sm font-semibold">
        Register for this competition <Icon name="arrow" className="h-4 w-4" />
      </span>
    </Link>
  );
}
