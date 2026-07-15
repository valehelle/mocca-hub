import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';

// Keep node built-ins, electron, and the Agent SDK OUT of the bundle.
// The Agent SDK ships a native Claude Code binary and spawns a subprocess,
// so it must resolve from node_modules at runtime, not be inlined by Vite.
export default defineConfig({
  build: {
    rollupOptions: {
      external: [
        'electron',
        '@anthropic-ai/claude-agent-sdk',
        ...builtinModules,
        ...builtinModules.map((m) => `node:${m}`),
      ],
    },
  },
});
