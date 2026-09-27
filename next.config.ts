import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Dev-only: lets `npm run dev` serve its dev resources through a cloudflared quick tunnel
  // (used to receive Razorpay test webhooks). Ignored by production builds.
  allowedDevOrigins: ["*.trycloudflare.com"],
};

export default nextConfig;
