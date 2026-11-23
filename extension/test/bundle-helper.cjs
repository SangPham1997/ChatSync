/** Shared esbuild helper: bundle the extension with `vscode` aliased to the stub. */
'use strict';

const path = require('path');

async function buildExtensionBundle(entry, outfile, stubPath) {
  const esbuild = require('esbuild');
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    outfile,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    alias: { vscode: stubPath },
    logLevel: 'warning',
  });
  return path.resolve(outfile);
}

module.exports = { buildExtensionBundle };
