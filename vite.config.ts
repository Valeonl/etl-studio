import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// base — путь проекта на GitHub Pages: сайт живёт по /<репозиторий>/, без этого
// абсолютные ссылки на /assets/... дадут 404. Для локальной разработки база "/".
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/etl-studio/" : "/",
  plugins: [react()],
  build: {
    // DuckDB-WASM — 41 МБ wasm; предупреждение о размере чанка здесь ожидаемо и не является проблемой.
    chunkSizeWarningLimit: 1200,
  },
}));
