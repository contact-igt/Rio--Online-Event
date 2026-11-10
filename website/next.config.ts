import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

// The browser uploads a video straight to the private R2 bucket, so connect-src names that one host, and only when uploads
// are switched on (RIO_UPLOADS_ENABLED=yes) and R2 is configured. media-src allows blob: so the browser can read a chosen
// video's length locally.
const r2Account = process.env.RIO_UPLOADS_ENABLED === "yes" && /^[0-9a-f]{32}$/i.test(process.env.R2_ACCOUNT_ID ?? "") ? process.env.R2_ACCOUNT_ID : null;
const r2Origin = r2Account ? ` https://${r2Account}.r2.cloudflarestorage.com` : "";
// No third-party origins anywhere else. Next.js injects inline bootstrap scripts, so
// script-src needs 'unsafe-inline' until pages move to nonce-based CSP (M8 hardening).
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self'${r2Origin}${isDev ? " ws:" : ""}`,
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

// A separate build directory is used only by the approval-gated live upload test (its policy differs by build); anything else falls back to .next.
const distDir = /^\.next(-[a-z]+)*$/.test(process.env.RIO_DIST_DIR ?? "") ? process.env.RIO_DIST_DIR : ".next";

const nextConfig: NextConfig = {
  distDir,
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [
      // The public results page is rendered per request and must never be stored by a browser, proxy or CDN.
      { source: "/results", headers: [{ key: "Cache-Control", value: "no-store, max-age=0" }] },
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
