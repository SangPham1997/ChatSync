import { defineConfig } from 'vite'
import monkey from 'vite-plugin-monkey'

export default defineConfig({
  plugins: [
    monkey({
      entry: 'src/index.ts',
      userscript: {
        name: 'ChatSync Bridge',
        namespace: 'chatsync',
        version: '0.1.0',
        match: [
          'https://chat.deepseek.com/*',
          'https://chatgpt.com/*',
          'https://claude.ai/*',
        ],
        grant: ['GM_getValue', 'GM_setValue', 'GM_xmlhttpRequest'],
        connect: ['localhost', '127.0.0.1'],
      },
    }),
  ],
})
