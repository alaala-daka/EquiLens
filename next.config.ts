import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["gaussdb-node"],
  poweredByHeader: false,
  agentRules: false,
  devIndicators: false,
  // Next blocks /_next/* dev resources from hosts other than localhost; without this the page
  // loads but never hydrates when opened as 127.0.0.1. Add any LAN host used for device testing.
  allowedDevOrigins: ["127.0.0.1"],
  async headers() {
    const development = process.env.NODE_ENV === "development";
    return [{ source: "/:path*", headers: [{
      key: "Content-Security-Policy",
      value: [
        "default-src 'self'",
        `script-src 'self' 'unsafe-inline'${development ? " 'unsafe-eval'" : ""}`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' blob: data:",
        "font-src 'self' data:",
        `connect-src 'self'${development ? " ws://127.0.0.1:* ws://localhost:*" : ""}`,
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
        "form-action 'self'",
      ].join("; "),
    }] }];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
