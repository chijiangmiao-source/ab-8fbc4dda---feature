import { defineConfig } from 'vite';

// 纯静态应用：构建产物 dist/ 可由任意静态服务器（nginx / vite preview）提供。
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  worker: {
    format: 'es',
  },
});
