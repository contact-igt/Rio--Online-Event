// Stands in for lib/staff/provisioning.ts in the offline admin tests: only the switch state comes from the window. No account can be created.
declare global {
  interface Window {
    __prov?: { enabled: boolean; secretKey: "ok" | "missing" | "badFormat"; ready: boolean };
  }
}

export function provisioningReadiness() {
  return window.__prov ?? { enabled: false, secretKey: "missing" as const, ready: false };
}
