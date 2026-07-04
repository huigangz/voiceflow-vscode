import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // 让导入 vscode 的模块能在单测中加载(仅为测其纯逻辑;见 test/__mocks__/vscode.ts)
      vscode: fileURLToPath(new URL('./test/__mocks__/vscode.ts', import.meta.url)),
    },
  },
});
