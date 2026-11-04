import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { colors, syntax } from "../../palette";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "corgi-palette",
      enforce: "pre",
      transform(code, id) {
        const tokens = Object.entries({
          ...colors,
          ...Object.fromEntries(Object.entries(syntax).map(([key, rgb]) => [`syntax-${key}`, rgb])),
        })
          .map(([key, rgb]) => `--${key}:rgb(${rgb.join(" ")});`)
          .join("");
        if (id.endsWith("/src/style.css")) return `${code}\n:root{${tokens}}`;
      },
    },
  ],
  build: { outDir: "dist", assetsInlineLimit: 0 },
});
