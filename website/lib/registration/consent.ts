import type { Msg } from "../auth/messages";

// Consent wording, keyed by the version an administrator sets in event_settings.current_consent_version.
// A parent can only register against a version this file knows, so nobody can "agree" to wording the app cannot show.
//
// The text below is PROVISIONAL. It is a working draft for the hospital to review (brief decision D5); it has NOT
// been reviewed or approved by legal advisers, and the screen says so. Add the approved text as a new version
// (for example "v1") and have the administrator switch event_settings to it; do not edit a version already in use.

export const PROVISIONAL_VERSION = "v0-provisional";

export type ConsentCopy = {
  version: string;
  provisional: boolean;
  notice: Msg;
  guardian: Msg;
  media: Msg;
};

const texts: Record<string, ConsentCopy> = {
  [PROVISIONAL_VERSION]: {
    version: PROVISIONAL_VERSION,
    provisional: true,
    notice: {
      ta: "இந்த ஒப்புதல் வாசகம் தற்காலிகமானது. இது மருத்துவமனையின் சட்ட ஆலோசகர்களால் இன்னும் மதிப்பாய்வு செய்யப்படவில்லை. பதிவு தொடங்கும் முன் இது மாற்றப்படும்.",
      en: "This consent wording is provisional. It has not yet been reviewed by the hospital's legal advisers and will be replaced before registration opens.",
    },
    guardian: {
      ta: "நான் இந்தக் குழந்தையின் பெற்றோர் அல்லது சட்டப்பூர்வ பாதுகாவலர். மேலே உள்ள விவரங்கள் சரியானவை. குழந்தையின் பெயர் மற்றும் வயது, என் பெயர், மின்னஞ்சல், கைப்பேசி எண் ஆகியவற்றை, குழந்தைகள் தின 2026 போட்டியை நடத்துவதற்காக மட்டும் (தகுதியைச் சரிபார்க்க, இந்தப் பதிவு பற்றி என்னைத் தொடர்பு கொள்ள, நடுவர்கள் பதிவை மதிப்பிட) ரியோ மருத்துவமனை பயன்படுத்த ஒப்புக்கொள்கிறேன்.",
      en: "I am the parent or legal guardian of this child. The details above are correct. I agree that Rio Hospital may use my child's name and age, and my name, email and mobile number, only to run the Children's Day 2026 competition: to check eligibility, to contact me about this entry, and so that judges can review it.",
    },
    media: {
      ta: "விருப்பம்: வெற்றியாளர் அறிவிப்பு போன்ற நிகழ்வு அறிவிப்புகளில் என் குழந்தையின் பதிவையும் முதல் பெயரையும் ரியோ மருத்துவமனை பகிர்வதற்கு ஒப்புக்கொள்கிறேன். இதைத் தேர்ந்தெடுக்காவிட்டாலும் என் குழந்தை போட்டியில் பங்கேற்கலாம்.",
      en: "Optional: I agree that Rio Hospital may share my child's entry and first name in event announcements, such as the winners post. If I do not tick this, my child can still take part.",
    },
  },
};

/** The wording for a version, or null if the app does not know it (registration then stays closed). */
export function getConsentCopy(version: string | null | undefined): ConsentCopy | null {
  return version ? (texts[version] ?? null) : null;
}
