import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

// Keep a copy of the userscript inside the extension folder so it ships in the
// .vsix (served at GET /userscript.js and used by the "Save userscript" command).
const scriptSource = path.resolve('..', 'userscript', 'chatsync.user.js');
const scriptTarget = path.resolve('userscript', 'chatsync.user.js');
if (fs.existsSync(scriptSource)) {
  fs.mkdirSync(path.dirname(scriptTarget), { recursive: true });
  fs.copyFileSync(scriptSource, scriptTarget);
  console.log(`[copy] ${path.relative(process.cwd(), scriptTarget)}`);
}

/** @type {esbuild.BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node16',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[esbuild] watching...');
} else {
  await esbuild.build(options);
}
