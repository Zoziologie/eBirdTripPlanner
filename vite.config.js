import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { VitePWA } from "vite-plugin-pwa";

// https://vite.dev/config/
export default defineConfig({
  base: "/eBirdTripPlanner/",
  plugins: [
    vue(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.ico", "pwa-192.png", "pwa-512.png"],
      workbox: {
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024, // 10 MB
      },
      manifest: {
        name: "eBird Trip Planner",
        short_name: "eBird Trip",
        description: "Offline-friendly birding trip planning and species reports.",
        theme_color: "#2a9d8f",
        background_color: "#ffffff",
        display: "standalone",
        scope: "/eBirdTripPlanner/",
        start_url: "/eBirdTripPlanner/",
        icons: [
          {
            src: "/eBirdTripPlanner/pwa-192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "/eBirdTripPlanner/pwa-512.png",
            sizes: "512x512",
            type: "image/png",
          },
        ],
      },
    }),
  ],
});
