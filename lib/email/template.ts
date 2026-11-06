import { events, winnersLine } from "@/lib/events";

// The participation confirmation. Plain, bilingual (Tamil first), and deliberately small:
//   * it names the competition and gives the reference (the entry code) and the announcement date;
//   * it contains NO link of any kind, no video, no attachment, no private storage address, and no child's name;
//   * every value is escaped, and the reference must have the exact entry-code shape, so nothing can inject markup or headers.
// The Tamil wording is provisional until the native-speaker review (D13).

const REFERENCE = /^RIO-[A-Z0-9]{5}-[A-Z0-9]{5}$/;

export type Participation = { eventId: number; reference: string };
export type RenderedEmail = { subject: string; html: string; text: string };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function renderParticipationEmail(p: Participation): RenderedEmail {
  const event = events.find((e) => e.number === p.eventId);
  if (!event) throw new Error("unknown competition");
  if (!REFERENCE.test(p.reference)) throw new Error("bad reference");

  const subject = `Entry received: ${event.nameEn} (${p.reference}) | பதிவு பெறப்பட்டது`;
  const lines = {
    greetingEn: "Dear parent or guardian,",
    greetingTa: "அன்புள்ள பெற்றோர் / பாதுகாவலருக்கு,",
    bodyEn: `We have received your child's final entry for ${event.nameEn}. Thank you for taking part in the Children's Day Celebration 2026 by Rio Hospital for Women & Children.`,
    bodyTa: `குழந்தைகள் தினக் கொண்டாட்டம் 2026-ல் பங்கேற்றதற்கு நன்றி. ${event.nameTa} போட்டிக்கான உங்கள் குழந்தையின் இறுதிப் பதிவு எங்களுக்குக் கிடைத்தது.`,
    competitionLabelEn: "Competition",
    competitionLabelTa: "போட்டி",
    referenceLabelEn: "Reference",
    referenceLabelTa: "குறிப்பு எண்",
    announceEn: winnersLine().en,
    announceTa: winnersLine().ta,
    finalEn: "Your entry is final and cannot be changed. Please keep this email and the reference for your records.",
    finalTa: "உங்கள் பதிவு இறுதியானது; மாற்ற முடியாது. இந்த மின்னஞ்சலையும் குறிப்பு எண்ணையும் வைத்துக்கொள்ளுங்கள்.",
    noteEn: "This is an automatic message. Your video is stored privately and is not attached to this email.",
    noteTa: "இது தானியங்கி மின்னஞ்சல். உங்கள் வீடியோ தனிப்பட்ட முறையில் சேமிக்கப்பட்டுள்ளது; இதனுடன் இணைக்கப்படவில்லை.",
    signature: "Rio Hospital for Women & Children",
  };

  const text = [
    `${lines.greetingTa}`,
    `${lines.bodyTa}`,
    `${lines.competitionLabelTa}: ${event.nameTa}`,
    `${lines.referenceLabelTa}: ${p.reference}`,
    `${lines.announceTa}`,
    `${lines.finalTa}`,
    `${lines.noteTa}`,
    "",
    "----------------------------------------",
    "",
    `${lines.greetingEn}`,
    `${lines.bodyEn}`,
    `${lines.competitionLabelEn}: ${event.nameEn}`,
    `${lines.referenceLabelEn}: ${p.reference}`,
    `${lines.announceEn}`,
    `${lines.finalEn}`,
    `${lines.noteEn}`,
    "",
    lines.signature,
  ].join("\n");

  const para = (s: string, extra = "") => `<p style="margin:0 0 12px;${extra}">${esc(s)}</p>`;
  const html = `<!doctype html>
<html lang="ta"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f1f6ff;">
<div style="max-width:560px;margin:0 auto;padding:24px 16px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#14162e;">
<div style="background:#ffffff;border-radius:16px;padding:24px;">
<div style="border-left:6px solid #fd70a1;background:#ffeaf2;border-radius:8px;padding:12px 16px;margin:0 0 20px;">
<p style="margin:0;font-weight:bold;color:#23275a;">${esc(lines.competitionLabelTa)} / ${esc(lines.competitionLabelEn)}: ${esc(event.nameTa)} / ${esc(event.nameEn)}</p>
<p style="margin:4px 0 0;font-weight:bold;color:#23275a;">${esc(lines.referenceLabelTa)} / ${esc(lines.referenceLabelEn)}: <span style="font-family:Consolas,Menlo,monospace;">${esc(p.reference)}</span></p>
</div>
${para(lines.greetingTa)}${para(lines.bodyTa)}${para(lines.announceTa, "font-weight:bold;color:#23275a;")}${para(lines.finalTa)}${para(lines.noteTa, "color:#475569;font-size:14px;")}
<hr style="border:0;border-top:1px solid #d9e2f2;margin:20px 0;">
<div lang="en">${para(lines.greetingEn)}${para(lines.bodyEn)}${para(lines.announceEn, "font-weight:bold;color:#23275a;")}${para(lines.finalEn)}${para(lines.noteEn, "color:#475569;font-size:14px;")}</div>
<p style="margin:16px 0 0;font-weight:bold;color:#23275a;">${esc(lines.signature)}</p>
</div></div></body></html>`;

  return { subject, html, text };
}
