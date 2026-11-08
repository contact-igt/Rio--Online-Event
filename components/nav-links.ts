// Header and footer links. Every link goes to a page or section that exists; there is no placeholder link.
export const navLinks = [
  { href: "/competitions", ta: "போட்டிகள்", en: "Competitions" },
  { href: "/#rules", ta: "விதிகள் & பரிசுகள்", en: "Rules & Prizes" },
  { href: "/#how", ta: "பங்கேற்பது எப்படி", en: "How It Works" },
  { href: "/results", ta: "முடிவுகள்", en: "Results" },
] as const;

// Staff Access: both links open the one staff sign-in page. The role in the address only changes its heading; what a person may open is
// decided from their signed-in Supabase role, never from this value.
export const staffLinks = [
  { href: "/staff/login?role=admin", ta: "நிர்வாகி உள்நுழைவு", en: "Admin Login" },
  { href: "/staff/login?role=judge", ta: "நடுவர் உள்நுழைவு", en: "Judge Login" },
] as const;
