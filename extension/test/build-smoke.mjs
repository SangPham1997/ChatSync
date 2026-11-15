import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildExtensionBundle } = require('./bundle-helper.cjs');

await buildExtensionBundle(
  path.resolve('test/smoke-entry.cjs'),
  path.resolve('test/.tmp/smoke-bundle.cjs'),
  path.resolve('test/vscode-stub.js'),
);

console.log('[smoke] bundle built → test/.tmp/smoke-bundle.cjs');
