import { defineConfig } from 'vite';

// No framework plugin: the app is plain ES modules with Vue used via string
// `template:` options. That means it needs the Vue build that ships the runtime
// template compiler — npm's bare `vue` resolves to the runtime-only build, which
// can't compile those templates, so alias it to the esm-bundler build.
export default defineConfig({
  resolve: {
    alias: { vue: 'vue/dist/vue.esm-bundler.js' },
  },
  define: {
    // Feature flags the esm-bundler build expects (silences build-time warnings).
    __VUE_OPTIONS_API__: 'true',
    __VUE_PROD_DEVTOOLS__: 'false',
  },
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
