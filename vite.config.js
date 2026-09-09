import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Components are single-file components, so their templates are compiled at
// build time and the runtime-only `vue` build is all the browser needs — no
// esm-bundler alias, and no template compiler shipped to the client.
export default defineConfig({
  plugins: [vue()],
  server: {
    // Caddy reverse-proxies editor.example.com → localhost:8072, so keep that
    // port (replaces the old `python -m http.server 8072`).
    host: '127.0.0.1',
    port: 8072,
    strictPort: true,
    // Vite rejects unknown Host headers; allow the Caddy-fronted name.
    allowedHosts: ['editor.example.com'],
    // HMR is a websocket the browser opens through Caddy's TLS, so point the
    // client at the public host/port rather than localhost:8072.
    hmr: {
      host: 'editor.example.com',
      clientPort: 443,
      protocol: 'wss',
    },
  },
});
