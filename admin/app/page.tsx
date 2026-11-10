import { redirect } from "next/navigation";

// The admin site has no home page of its own: the staff sign-in page sends signed-in staff on to their area.
export default function Home() {
  redirect("/staff/login");
}
