import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

// Judges play videos from short-lived signed links on the same private bucket host; media-src names it only when playback is switched on
// (RIO_PLAYBACK_ENABLED=yes). The admin panel never uploads, so connect-src stays on this site.
const playbackAccount = process.env.RIO_PLAYBACK_ENABLED === "yes" && /^[0-9a-f]{32}$/i.test(process.env.R2_ACCOUNT_ID ?? "") ? process.env.R2_ACCOUNT_ID : null;
const playbackOrigin = playbackAccount ? ` https://${playbackAccount}.r2.cloudflarestorage.com` : "";

// No third-party origins anywhere else. Next.js injects inline bootstrap scripts, so
// script-src needs 'unsafe-inline' until pages move to nonce-based CSP (M8 hardening).
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self'${isDev ? " ws:" : ""}`,
  `media-src 'self' blob:${playbackOrigin}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "X-Frame-Options", value: "DENY" },
          // Staff pages hold personal data and must never be indexed.
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
};

export default nextConfig;
