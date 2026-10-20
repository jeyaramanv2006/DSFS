import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), basicSsl()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@voidshare/shared': path.resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  server: {
    host: process.env.HOST ?? '0.0.0.0',
    port: 5173,
    proxy: { '/api': process.env.VOIDSHARE_API_TARGET ?? 'http://localhost:8080' },
  },
});
