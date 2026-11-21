# ChatSync — Status Report

> Generated: **2026-11-21 11:06:57 +07:00**  
> Repo: `D:\AI Trainning\workspace\chatsync`  
> Git: `4491b6e` (`main`) · Node `v22.14.0` · npm `10.9.2`

## Summary

| Check | Status |
|---|---|
| typecheck |  |
| test:m2 |  |
| M1 files | 9 / 9 present |
| M2 files | 12 / 12 present |
| TODOs | 0 (M1) · 3 (M2) |

## Dependencies

### Runtime (14)

- `diff-match-patch` → `^1.0.5`
- `diff2html` → `^3.4.51`
- `dompurify` → `^3.2.3`
- `execa` → `^9.5.2`
- `gray-matter` → `^4.0.3`
- `lru-cache` → `^11.0.2`
- `marked` → `^15.0.4`
- `node-diff3` → `^3.1.2`
- `p-queue` → `^8.0.1`
- `simple-git` → `^3.27.0`
- `strip-ansi` → `^7.1.0`
- `tree-kill` → `^1.2.2`
- `xstate` → `^5.19.1`
- `zod` → `^3.24.1`

### Dev (9)

- `@playwright/test` → `^1.49.1`
- `@types/diff-match-patch` → `^1.0.36`
- `@types/node` → `^22.10.2`
- `@types/vscode` → `^1.95.0`
- `@vscode/test-electron` → `^2.4.1`
- `esbuild` → `^0.24.2`
- `happy-dom` → `^15.11.7`
- `typescript` → `^5.7.2`
- `vitest` → `^2.1.8`

## Project tree

```
chatsync/
├── .chatsync/
│   └── skills/
│       ├── explain-folder.md
│       ├── fix-ts.md
│       └── refactor-patch.md
├── .chatsync-backup/
│   ├── 20261121-104425/
│   │   └── src/
│   ├── 20261121-104501-m2/
│   │   └── src/
│   ├── 20261121-104527-m3/
│   │   ├── skills/
│   │   └── src/
│   ├── 20261121-105030-baseline/
│   │   └── src/
│   └── 20261121-105517-baseline/
├── extension/
│   ├── dist/
│   │   ├── extension.js
│   │   └── extension.js.map
│   ├── node_modules/
│   │   ├── .bin/
│   │   ├── @azure/
│   │   ├── @esbuild/
│   │   ├── @types/
│   │   ├── @typespec/
│   │   ├── @vscode/
│   │   ├── agent-base/
│   │   ├── ansi-styles/
│   │   ├── argparse/
│   │   ├── asynckit/
│   │   ├── azure-devops-node-api/
│   │   ├── balanced-match/
│   │   ├── base64-js/
│   │   ├── bl/
│   │   ├── boolbase/
│   │   ├── brace-expansion/
│   │   ├── buffer/
│   │   ├── buffer-crc32/
│   │   ├── buffer-equal-constant-time/
│   │   ├── bundle-name/
│   │   ├── call-bind-apply-helpers/
│   │   ├── call-bound/
│   │   ├── chalk/
│   │   ├── cheerio/
│   │   ├── cheerio-select/
│   │   ├── chownr/
│   │   ├── cockatiel/
│   │   ├── color-convert/
│   │   ├── color-name/
│   │   ├── combined-stream/
│   │   ├── commander/
│   │   ├── concat-map/
│   │   ├── css-select/
│   │   ├── css-what/
│   │   ├── debug/
│   │   ├── decompress-response/
│   │   ├── deep-extend/
│   │   ├── default-browser/
│   │   ├── default-browser-id/
│   │   ├── define-lazy-prop/
│   │   ├── delayed-stream/
│   │   ├── detect-libc/
│   │   ├── dom-serializer/
│   │   ├── domelementtype/
│   │   ├── domhandler/
│   │   ├── domutils/
│   │   ├── dunder-proto/
│   │   ├── ecdsa-sig-formatter/
│   │   ├── encoding-sniffer/
│   │   ├── end-of-stream/
│   │   ├── entities/
│   │   ├── es-define-property/
│   │   ├── es-errors/
│   │   ├── es-object-atoms/
│   │   ├── es-set-tostringtag/
│   │   ├── esbuild/
│   │   ├── escape-string-regexp/
│   │   ├── expand-template/
│   │   ├── fd-slicer/
│   │   ├── form-data/
│   │   ├── fs-constants/
│   │   ├── fs.realpath/
│   │   ├── function-bind/
│   │   ├── get-intrinsic/
│   │   ├── get-proto/
│   │   ├── github-from-package/
│   │   ├── glob/
│   │   ├── gopd/
│   │   ├── has-flag/
│   │   ├── has-symbols/
│   │   ├── has-tostringtag/
│   │   ├── hasown/
│   │   ├── hosted-git-info/
│   │   ├── htmlparser2/
│   │   ├── http-proxy-agent/
│   │   ├── https-proxy-agent/
│   │   ├── iconv-lite/
│   │   ├── ieee754/
│   │   ├── inflight/
│   │   ├── inherits/
│   │   ├── ini/
│   │   ├── is-docker/
│   │   ├── is-inside-container/
│   │   ├── is-wsl/
│   │   ├── jsonc-parser/
│   │   ├── jsonwebtoken/
│   │   ├── jwa/
│   │   ├── jws/
│   │   ├── keytar/
│   │   ├── leven/
│   │   ├── linkify-it/
│   │   ├── lodash.includes/
│   │   ├── lodash.isboolean/
│   │   ├── lodash.isinteger/
│   │   ├── lodash.isnumber/
│   │   ├── lodash.isplainobject/
│   │   ├── lodash.isstring/
│   │   ├── lodash.once/
│   │   ├── lru-cache/
│   │   ├── markdown-it/
│   │   ├── math-intrinsics/
│   │   ├── mdurl/
│   │   ├── mime/
│   │   ├── mime-db/
│   │   ├── mime-types/
│   │   ├── mimic-response/
│   │   ├── minimatch/
│   │   ├── minimist/
│   │   ├── mkdirp-classic/
│   │   ├── ms/
│   │   ├── mute-stream/
│   │   ├── napi-build-utils/
│   │   ├── node-abi/
│   │   ├── node-addon-api/
│   │   ├── nth-check/
│   │   ├── object-inspect/
│   │   ├── once/
│   │   ├── open/
│   │   ├── parse-semver/
│   │   ├── parse5/
│   │   ├── parse5-htmlparser2-tree-adapter/
│   │   ├── parse5-parser-stream/
│   │   ├── path-is-absolute/
│   │   ├── pend/
│   │   ├── prebuild-install/
│   │   ├── pump/
│   │   ├── qs/
│   │   ├── rc/
│   │   ├── read/
│   │   ├── readable-stream/
│   │   ├── run-applescript/
│   │   ├── safe-buffer/
│   │   ├── safer-buffer/
│   │   ├── sax/
│   │   ├── semver/
│   │   ├── side-channel/
│   │   ├── side-channel-list/
│   │   ├── side-channel-map/
│   │   ├── side-channel-weakmap/
│   │   ├── simple-concat/
│   │   ├── simple-get/
│   │   ├── string_decoder/
│   │   ├── strip-json-comments/
│   │   ├── supports-color/
│   │   ├── tar-fs/
│   │   ├── tar-stream/
│   │   ├── tmp/
│   │   ├── tslib/
│   │   ├── tunnel/
│   │   ├── tunnel-agent/
│   │   ├── typed-rest-client/
│   │   ├── typescript/
│   │   ├── uc.micro/
│   │   ├── underscore/
│   │   ├── undici/
│   │   ├── undici-types/
│   │   ├── url-join/
│   │   ├── util-deprecate/
│   │   ├── whatwg-encoding/
│   │   ├── whatwg-mimetype/
│   │   ├── wrappy/
│   │   ├── wsl-utils/
│   │   ├── xml2js/
│   │   ├── xmlbuilder/
│   │   ├── yallist/
│   │   ├── yauzl/
│   │   ├── yazl/
│   │   └── .package-lock.json
│   ├── src/
│   │   ├── apply.ts
│   │   ├── config.ts
│   │   ├── context.ts
│   │   ├── extension.ts
│   │   ├── folder.ts
│   │   ├── logger.ts
│   │   ├── security.ts
│   │   ├── server.ts
│   │   ├── skills.ts
│   │   └── util.ts
│   ├── test/
│   │   ├── .tmp/
│   │   ├── build-smoke.mjs
│   │   ├── bundle-helper.cjs
│   │   ├── dom-stub.cjs
│   │   ├── smoke-entry.cjs
│   │   ├── smoke.cjs
│   │   ├── userscript-smoke.cjs
│   │   └── vscode-stub.js
│   ├── userscript/
│   │   └── chatsync.user.js
│   ├── .gitignore
│   ├── .vscodeignore
│   ├── chatsync.vsix
│   ├── esbuild.mjs
│   ├── icon.png
│   ├── LICENSE
│   ├── package-lock.json
│   ├── package.json
│   ├── README.md
│   └── tsconfig.json
├── src/
│   ├── batch/
│   │   ├── approvePolicy.ts
│   │   └── queue.ts
│   ├── context/
│   │   └── taxonomy.ts
│   ├── git/
│   │   └── diff.ts
│   ├── loop/
│   │   ├── reporter.ts
│   │   ├── runner.ts
│   │   ├── schema.ts
│   │   └── stateMachine.ts
│   ├── patch/
│   │   ├── engine.ts
│   │   ├── locate.ts
│   │   └── merge3.ts
│   ├── review/
│   │   ├── provider.ts
│   │   └── render.ts
│   ├── skills/
│   │   └── loader.ts
│   └── types/
│       └── shims.d.ts
├── test/
│   ├── fixtures/
│   │   └── deepseek-composer.html
│   └── unit/
│       ├── approve/
│       ├── merge3/
│       ├── patch/
│       └── smoke.test.ts
├── userscript/
│   ├── src/
│   │   ├── adapters/
│   │   ├── composer/
│   │   ├── palette/
│   │   └── index.ts
│   ├── chatsync.user.js
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts
├── .env.example
├── .gitignore
├── package-lock.json
├── package.json
├── playwright.config.ts
├── tsconfig.json
└── vitest.config.ts
```

## M1 checklist

- [x] `src/loop/schema.ts`
- [x] `src/loop/stateMachine.ts`
- [x] `src/loop/runner.ts`
- [x] `src/loop/reporter.ts`
- [x] `src/skills/loader.ts`
- [x] `userscript/src/index.ts`
- [x] `userscript/src/adapters/deepseek.ts`
- [x] `userscript/src/palette/index.ts`
- [x] `userscript/src/composer/insert.ts`

## M2 checklist

- [x] `src/patch/locate.ts`
- [x] `src/patch/merge3.ts`
- [x] `src/patch/engine.ts`
- [x] `src/batch/queue.ts`
- [x] `src/batch/approvePolicy.ts`
- [x] `src/review/render.ts`
- [x] `src/review/provider.ts`
- [x] `src/context/taxonomy.ts`
- [x] `src/git/diff.ts`
- [x] `test/unit/patch/tiers.test.ts`
- [x] `test/unit/merge3/merge3.test.ts`
- [x] `test/unit/approve/approvePolicy.test.ts`

## TODO inventory

| File | Line | Marker | Text |
|---|---:|---|---|
| `src\context\taxonomy.ts` | 2 | `TODO(M2)` | TODO(M2): they need VS Code API. This file only defines names + resolution. |
| `src\context\taxonomy.ts` | 31 | `TODO(M2)` | TODO(M2): implement provider that turns each mention into a ContextBlock via |
| `src\review\provider.ts` | 2 | `TODO(M2)` | TODO(M2): register as command "chatsync.review.show"; wire diff2html CSS asset. |

## Verify output

### `npm run typecheck`

```
# 1 TypeScript error(s):
src/patch/locate.ts(6,28): error TS2305: Module '"diff-match-patch"' has no exported member 'Match'.


> chatsync@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit

src/patch/locate.ts(6,28): error TS2305: Module '"diff-match-patch"' has no exported member 'Match'.
```

### `npm run test:m2`

```

> chatsync@0.1.0 test:m2
> vitest run test/unit/patch test/unit/merge3 test/unit/approve

The CJS build of Vite's Node API is deprecated. See https://vite.dev/guide/troubleshooting.html#vite-cjs-node-api-deprecated for more details.

[1m[7m[36m RUN [39m[27m[22m [36mv2.1.9 [39m[90mD:/AI Trainning/workspace/chatsync[39m

 [32mΓ£ô[39m test/unit/approve/approvePolicy.test.ts [2m([22m[2m2 tests[22m[2m)[22m[90m 8[2mms[22m[39m
 [31mΓ¥»[39m test/unit/merge3/merge3.test.ts [2m([22m[2m2 tests[22m[2m | [22m[31m1 failed[39m[2m)[22m[90m 17[2mms[22m[39m
[31m   [31m├ù[31m merge3[2m > [22mclean merge[90m 14[2mms[22m[31m[39m
[31m     ΓåÆ expected false to be true // Object.is equality[39m
 [32mΓ£ô[39m test/unit/patch/tiers.test.ts [2m([22m[2m5 tests[22m[2m)[22m[90m 10[2mms[22m[39m

ΓÄ»ΓÄ»ΓÄ»ΓÄ»ΓÄ»ΓÄ»ΓÄ» Failed Tests 1 ΓÄ»ΓÄ»ΓÄ»ΓÄ»ΓÄ»ΓÄ»ΓÄ»

 FAIL  test/unit/merge3/merge3.test.ts > merge3 > clean merge
AssertionError: expected false to be true // Object.is equality

- Expected
+ Received

- true
+ false

 Γ¥» test/unit/merge3/merge3.test.ts:10:18
      8|     const ai   = 'line1\nline2\nline3-ai'
      9|     const r = merge3(base, user, ai)
     10|     expect(r.ok).toBe(true)
       |                  ^
     11|     if (r.ok) { expect(r.text).toContain('line2-user'); expect(r.text)ΓÇª
     12|   })

ΓÄ»ΓÄ»ΓÄ»ΓÄ»ΓÄ»ΓÄ»ΓÄ»ΓÄ»ΓÄ»ΓÄ»ΓÄ»ΓÄ»ΓÄ»ΓÄ»ΓÄ»ΓÄ»ΓÄ»ΓÄ»ΓÄ»ΓÄ»ΓÄ»ΓÄ»ΓÄ»ΓÄ»[1/1]ΓÄ»

[2m Test Files [22m [1m[31m1 failed[39m[22m[2m | [22m[1m[32m2 passed[39m[22m[90m (3)[39m
[2m      Tests [22m [1m[31m1 failed[39m[22m[2m | [22m[1m[32m8 passed[39m[22m[90m (9)[39m
[2m   Start at [22m 11:07:03
[2m   Duration [22m 1.83s[2m (transform 152ms, setup 0ms, collect 250ms, tests 34ms, environment 2.98s, prepare 700ms)[22m
```

## Next steps

1. **Fix typecheck** — see errors above. Common:
   - `Cannot find module 'diff-match-patch'` → `npm i -D @types/diff-match-patch`
   - `Cannot find module 'X'` for M2 dep → `npm i`
   - Help-text from `tsc` again → `tsconfig.json` corrupted, rerun `fix-tsconfig-m2.ps1`
2. **Fill in 3 TODO(M2) blocks** — see TODO inventory above.

---
*Generated by `gen-report-m2.ps1` on 2026-11-21 11:06:57 +07:00.*