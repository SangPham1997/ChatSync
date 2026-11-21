// Build src/extension.ts -> out/extension.js for VS Code extension load.
// vscode is provided by the host at runtime, must stay external.
import { build, context } from 'esbuild'

const isWatch = process.argv.includes('--watch')

const opts = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'out/extension.js',
  external: ['vscode'],
  sourcemap: true,
  minify: false,
  logLevel: 'info',
}

if (isWatch) {
  const ctx = await context(opts)
  await ctx.watch()
  console.log('[esbuild] watching src/extension.ts -> out/extension.js')
} else {
  await build(opts)
  console.log('[esbuild] built out/extension.js')
}