/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.externals = {
        ...config.externals,
        'node:fs/promises': 'commonjs2 node:fs/promises',
      };
      config.resolve = {
        ...config.resolve,
        fallback: {
          'fs': false,
        },
      };
    }
    return config;
  },
};

export default nextConfig;
