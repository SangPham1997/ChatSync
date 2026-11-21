import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      // Vitest has no VS Code host -> redirect "vscode" to local mock.
      // Real extension code resolves "vscode" from the host at runtime.
      vscode: resolve(__dirname, 'test/mocks/vscode.ts'),
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['test/unit/**/*.test.ts'],
    globals: true,
  },
})