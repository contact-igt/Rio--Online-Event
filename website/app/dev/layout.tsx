import { notFound } from "next/navigation";

// Everything under /dev exists for local development only. In production it is a 404 before any child renders.
export default function DevLayout({ children }: { children: React.ReactNode }) {
  if (process.env.NODE_ENV === "production") notFound();
  return children;
}
