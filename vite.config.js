import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { VitePWA } from "vite-plugin-pwa";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// https://vite.dev/config/
export default defineConfig({
  base: "/eBirdTripPlanner/",
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  plugins: [
    vue(),
    VitePWA({
      registerType: "autoUpdate",
      workbox: {
        globPatterns: [
          "**/*.{js,css,html,ico,png,svg,webmanifest,woff,woff2,jpg,jpeg,gif,webp,avif,json}",
        ],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "google-fonts-stylesheets",
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 365,
              },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "google-fonts-webfonts",
              cacheableResponse: {
                statuses: [0, 200],
              },
              expiration: {
                maxEntries: 30,
                maxAgeSeconds: 60 * 60 * 24 * 365,
              },
            },
          },
          {
            urlPattern: /^https:\/\/api\.mapbox\.com\/directions\/v5\/.*/i,
            handler: "NetworkFirst",
            options: {
              cacheName: "mapbox-directions",
              networkTimeoutSeconds: 5,
              cacheableResponse: {
                statuses: [0, 200],
              },
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 60 * 24 * 7,
              },
            },
          },
          {
            urlPattern: /^https:\/\/(?:api\.mapbox\.com|.*\.tiles\.mapbox\.com)\/.*/i,
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "mapbox-resources",
              cacheableResponse: {
                statuses: [0, 200],
              },
              expiration: {
                maxEntries: 500,
                maxAgeSeconds: 60 * 60 * 24 * 14,
              },
            },
          },
        ],
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
