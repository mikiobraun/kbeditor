import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

// Node by default, so a plain unit test never pays for a jsdom instance. A test
// that walks the DOM or mounts a component opts in with a docblock on its first
// line — `// @vitest-environment jsdom` — which also names the cost where it is
// paid. Those files are called *.dom.test.js by convention.
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
  },
});
