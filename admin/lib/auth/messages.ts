// All sign-in copy, Tamil first and English second. Tamil strings here are mine, not from the poster;
// they need a native-speaker review before launch (brief D13).

export type Msg = { ta: string; en: string };

export const copy = {
  signIn: {
    title: { ta: "உள்நுழைக", en: "Sign in" },
    // The code length is a server setting (lib/auth/otp-length.ts), so these three messages are built from it.
    lead: (n: number): Msg => ({
      ta: `உங்கள் மின்னஞ்சலுக்கு ${n} இலக்கக் குறியீட்டை அனுப்புவோம். கடவுச்சொல் தேவையில்லை.`,
      en: `We will email you a ${n}-digit code. No password needed.`,
    }),
    selected: { ta: "தேர்ந்தெடுத்த போட்டி", en: "Selected competition" },
    emailLabel: { ta: "மின்னஞ்சல் முகவரி", en: "Email address" },
    expired: {
      ta: "உங்கள் அமர்வு முடிந்துவிட்டது. தொடர மீண்டும் உள்நுழையுங்கள். நீங்கள் உள்ளிட்டவை சேமிக்கப்படவில்லை.",
      en: "Your session ended. Sign in again to continue. What you typed was not saved.",
    },
    send: { ta: "குறியீட்டை அனுப்பு", en: "Send code" },
    sending: { ta: "அனுப்பப்படுகிறது…", en: "Sending…" },
  },
  verify: {
    title: { ta: "குறியீட்டை உள்ளிடுங்கள்", en: "Enter your code" },
    sentTo: { ta: "குறியீடு அனுப்பப்பட்ட முகவரி", en: "Code sent to" },
    codeLabel: (n: number): Msg => ({ ta: `${n} இலக்கக் குறியீடு`, en: `${n}-digit code` }),
    verify: { ta: "சரிபார்", en: "Verify" },
    verifying: { ta: "சரிபார்க்கிறது…", en: "Verifying…" },
    resend: { ta: "புதிய குறியீட்டை அனுப்பு", en: "Send a new code" },
    resending: { ta: "அனுப்பப்படுகிறது…", en: "Sending…" },
    resendIn: { ta: "மீண்டும் அனுப்ப காத்திருக்கவும்", en: "You can send another code in" },
    seconds: { ta: "வினாடிகள்", en: "seconds" },
    hint: {
      ta: "குறியீடு சிறிது நேரத்தில் காலாவதியாகும். செயல்படவில்லை என்றால் புதியதைக் கோருங்கள். மின்னஞ்சல் வரவில்லை என்றால் ஸ்பேம் கோப்புறையைப் பாருங்கள்.",
      en: "Codes expire after a while. If yours stops working, ask for a new one. If nothing arrives, check your spam folder.",
    },
    sentAgain: { ta: "புதிய குறியீடு அனுப்பப்பட்டது.", en: "A new code was sent." },
    differentEmail: { ta: "வேறு மின்னஞ்சலைப் பயன்படுத்து", en: "Use a different email" },
  },
  account: {
    title: { ta: "நீங்கள் உள்நுழைந்துள்ளீர்கள்", en: "You are signed in" },
    as: { ta: "உள்நுழைந்த மின்னஞ்சல்", en: "Signed in as" },
    signOut: { ta: "வெளியேறு", en: "Sign out" },
    competitions: { ta: "போட்டிகளைப் பார்க்க", en: "See competitions" },
  },
  register: {
    title: { ta: "பதிவு விரைவில் தொடங்கும்", en: "Registration opens soon" },
    body: {
      ta: "நீங்கள் உள்நுழைந்துள்ளீர்கள். பதிவுப் படிவம் அடுத்த கட்டத்தில் வரும்.",
      en: "You are signed in. The registration form arrives in the next step.",
    },
  },
  errors: {
    invalidEmail: { ta: "சரியான மின்னஞ்சல் முகவரியை உள்ளிடுங்கள்.", en: "Enter a valid email address." },
    emailNotAccepted: {
      ta: "இந்த மின்னஞ்சல் முகவரி ஏற்கப்படவில்லை. எழுத்துப் பிழை உள்ளதா எனப் பாருங்கள் அல்லது வேறு மின்னஞ்சலைப் பயன்படுத்துங்கள்.",
      en: "This email address was not accepted. Check it for typing mistakes, or use a different address.",
    },
    invalidCode: (n: number): Msg => ({ ta: `${n} இலக்கக் குறியீட்டை உள்ளிடுங்கள்.`, en: `Enter the ${n}-digit code.` }),
    wrongOrExpired: {
      ta: "குறியீடு தவறானது அல்லது காலாவதியாகிவிட்டது. சரிபார்க்கவும் அல்லது புதிய குறியீட்டைக் கோருங்கள்.",
      en: "That code is wrong or has expired. Check it, or send a new code.",
    },
    tooMany: {
      ta: "பல முறை முயன்றுவிட்டீர்கள். சிறிது நேரம் கழித்து மீண்டும் முயலுங்கள்.",
      en: "Too many attempts. Wait a few minutes and try again.",
    },
    sendFailed: {
      ta: "குறியீட்டை அனுப்ப முடியவில்லை. சிறிது நேரம் கழித்து மீண்டும் முயலுங்கள்.",
      en: "We could not send the code. Try again in a moment.",
    },
    signInFailed: {
      ta: "உள்நுழைய முடியவில்லை. சிறிது நேரம் கழித்து மீண்டும் முயலுங்கள்.",
      en: "We could not sign you in. Try again in a moment.",
    },
    unavailable: { ta: "உள்நுழைவு தற்போது கிடைக்கவில்லை.", en: "Sign-in is unavailable right now." },
  },
} as const;

export const cooldownMessage = (seconds: number): Msg => ({
  ta: `புதிய குறியீட்டைக் கோர ${seconds} வினாடிகள் காத்திருங்கள்.`,
  en: `Wait ${seconds} seconds before asking for another code.`,
});
