import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';

// Components are single-file components, so their templates are compiled at
// build time and the runtime-only `vue` build is all the browser needs — no
// esm-bundler alias, and no template compiler shipped to the client.
export default defineConfig(({ mode }) => {
  // DEV_PUBLIC_HOST (e.g. in .env.local) names a TLS reverse proxy in front of
  // the dev server. Unset, the dev server is plain localhost with Vite's
  // defaults. The '' prefix lets loadEnv return a variable without VITE_.
  const publicHost = loadEnv(mode, process.cwd(), '').DEV_PUBLIC_HOST;
  return {
    plugins: [vue()],
    server: {
      host: '127.0.0.1',
      port: 8072,
      strictPort: true,
      ...(publicHost && {
        // Vite rejects unknown Host headers; allow the proxied name.
        allowedHosts: [publicHost],
        // HMR is a websocket the browser opens through the proxy's TLS, so
        // point the client at the public host/port, not localhost:8072.
        hmr: { host: publicHost, clientPort: 443, protocol: 'wss' },
      }),
    },
  };
});
