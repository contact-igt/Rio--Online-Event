// Stands in for next/link in the offline browser fixtures (the real one needs the Next.js router). Renders a plain anchor.
import type { AnchorHTMLAttributes, ReactNode } from "react";

export default function Link({ href, children, ...rest }: { href: string; children?: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}
