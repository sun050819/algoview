import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  // 相对路径构建：产物可放到任意子路径 / 静态托管 / 本地 file:// 打开，无硬编码地址
  base: './',
  plugins: [react()],
  build: {
    // Monaco 体积较大，这里不做 chunk 拆分限制，保证本地预览稳定
    chunkSizeWarningLimit: 6000,
    rollupOptions: {
      output: {
        manualChunks: {
          monaco: ['monaco-editor'],
          react: ['react', 'react-dom', 'zustand'],
        },
      },
    },
  },
  server: {
    port: 5173,
    open: false,
  },
});
