/** "+919876543210" -> "+91 ••••• ••210": the parent can recognise the number, nobody reading over a shoulder can copy it. */
export function maskMobile(mobile: string): string {
  const digits = mobile.replace(/\D/g, "").slice(-10);
  return digits.length === 10 ? `+91 ••••• ••${digits.slice(-3)}` : "••••••••••";
}
