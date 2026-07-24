// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { fileURLToPath } from "node:url";
import { VitePWA } from "vite-plugin-pwa";

const eventsPolyfillPath = fileURLToPath(new URL("./src/lib/browser-events.ts", import.meta.url));

export default defineConfig({
  vite: {
    plugins: [
      {
        name: "browser-events-polyfill",
        enforce: "pre",
        resolveId(source) {
          if (source === "events" || source === "node:events") return eventsPolyfillPath;
          return null;
        },
      },
      VitePWA({
        strategies: "generateSW",
        registerType: "autoUpdate",
        injectRegister: null,
        filename: "sw.js",
        devOptions: { enabled: false },
        manifest: false, // we ship our own public/manifest.webmanifest
        workbox: {
          navigateFallback: "/",
          navigateFallbackDenylist: [/^\/~oauth/, /^\/_serverFn/, /^\/api\//],
          globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest,woff,woff2}"],
          cleanupOutdatedCaches: true,
          runtimeCaching: [
            {
              urlPattern: ({ request }) => request.mode === "navigate",
              handler: "NetworkFirst",
              options: {
                cacheName: "html-navigations",
                networkTimeoutSeconds: 5,
              },
            },
            {
              urlPattern: ({ url, sameOrigin }) =>
                sameOrigin && /\.(?:js|css|woff2?|svg|png|jpg|jpeg|webp|ico)$/.test(url.pathname),
              handler: "CacheFirst",
              options: {
                cacheName: "static-assets",
                expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
              },
            },
          ],
        },
      }),
    ],
    resolve: {
      alias: [
        // JsSIP depends on Node's `events` name, which must resolve to the
        // browser EventEmitter implementation in the client bundle.
        { find: /^events$/, replacement: eventsPolyfillPath },
        { find: /^node:events$/, replacement: eventsPolyfillPath },
      ],
    },
  },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
