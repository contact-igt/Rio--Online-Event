import { StaffBar } from "@/components/staff/staff-bar";

export default function JudgeLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="wash min-h-[60vh]">
      <StaffBar role="judge" />
      {children}
    </div>
  );
}
