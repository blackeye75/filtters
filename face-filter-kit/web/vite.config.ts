import { defineConfig } from "vite";

// Shaders live in ../shared/shaders so Android loads the exact same GLSL.
export default defineConfig({
  server: { fs: { allow: [".."] } },
  build: { target: "es2022" },
});
