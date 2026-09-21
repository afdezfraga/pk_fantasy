/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    // Official artwork is hotlinked until `npm run roster:build -- --sprites` caches it locally.
    remotePatterns: [{ protocol: 'https', hostname: 'raw.githubusercontent.com' }],
  },
};

export default nextConfig;
