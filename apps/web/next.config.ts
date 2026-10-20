import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  // Tailwind v4 via loader do Turbopack (sem PostCSS). Sem isto, só o CSS "cru" de globals.css entra no bundle.
  turbopack: { rules: { "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" } } },
};
export default nextConfig;
