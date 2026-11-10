// Browser entry for e2e/staff-login.spec.ts: the REAL StaffLoginForm with a fake server action.
import { createRoot } from "react-dom/client";
import { StaffLoginForm } from "@/components/staff/login-form";

createRoot(document.getElementById("root")!).render(
  <div className="mx-auto max-w-md rounded-2xl border-2 border-rio-navy/15 bg-rio-blush p-5 sm:p-6">
    <StaffLoginForm />
  </div>,
);
