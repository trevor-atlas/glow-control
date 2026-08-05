import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Frontend dev server (localhost:5173). API + WebSocket requests are
// proxied to the Bun backend (localhost:3000) so the UI never needs to
// know about a second port. Production builds land in dist/, which the
// Bun server serves directly.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/ws": { target: "ws://localhost:3000", ws: true },
    },
  },
});
