/* eslint-disable @typescript-eslint/no-var-requires */
// Entry point bundled by test/build-smoke.mjs with `vscode` aliased to the stub.
const vscode = require('vscode');
const ext = require('../src/extension.ts');

module.exports = { vscode, ext };
