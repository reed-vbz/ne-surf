import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false, // the dev badge would sit inside the legend region and break the pixel diff
};

export default nextConfig;
