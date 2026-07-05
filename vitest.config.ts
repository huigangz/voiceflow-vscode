import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    // 只跑本项目 test/;spike/ 里有解包的第三方 tarball 自带测试,不属于本套件
    include: ['test/**/*.test.ts'],
  },
  resolve: {
    alias: {
      // 让导入 vscode 的模块能在单测中加载(仅为测其纯逻辑;见 test/__mocks__/vscode.ts)
      vscode: fileURLToPath(new URL('./test/__mocks__/vscode.ts', import.meta.url)),
    },
  },
});
