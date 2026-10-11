/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@ai-workforce/ui', '@ai-workforce/auth', '@ai-workforce/db', '@ai-workforce/domain', '@ai-workforce/billing'],
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
  images: {
    // Nothing uses next/image, so the /_next/image optimizer endpoint is disabled: it carries
    // RCE/DoS advisories (e.g. AVIF handling) that are only fixed in Next 15.5.24+.
    unoptimized: true,
    domains: ['avatars.githubusercontent.com', 'lh3.googleusercontent.com'],
  },
}

module.exports = nextConfig