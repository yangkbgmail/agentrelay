/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace package ships ESM from dist/; let Next bundle it for the server.
  transpilePackages: ["@agentrelay/core"],
};

export default nextConfig;
