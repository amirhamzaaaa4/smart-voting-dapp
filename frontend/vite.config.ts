import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `base` lets the same build run at a domain root or under /<repo>/ on GitHub Pages.
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE ?? "./",
  server: { port: 5173 },
  build: {
    rollupOptions: {
      output: {
        // Long-lived vendor chunks cache well across app releases.
        manualChunks: {
          react: ["react", "react-dom"],
          ethers: ["ethers"],
          merkle: ["@openzeppelin/merkle-tree"],
        },
      },
    },
  },
});
