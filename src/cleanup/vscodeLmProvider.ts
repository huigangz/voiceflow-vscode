/**
 * vscode.lm 增强 provider(F3.3):复用用户已有 Copilot 等订阅。
 * selectChatModels 为空 → 返回 undefined(graceful fallback,rules-only)。
 * 首次调用时 VS Code 自身会弹授权对话框(S3b 人工验证项)。
 */
import * as vscode from 'vscode';
import { CLEANUP_PROMPT, EnhanceProvider, wrapTranscript } from './pipeline';

export async function createVscodeLmProvider(
  log: (line: string) => void,
): Promise<EnhanceProvider | undefined> {
  let models: vscode.LanguageModelChat[];
  try {
    models = await vscode.lm.selectChatModels();
  } catch (err) {
    log(`[cleanup] vscode.lm 探测失败:${String(err)}`);
    return undefined;
  }
  if (models.length === 0) {
    log('[cleanup] vscode.lm 无可用模型(未装 Copilot 或未登录),rules-only');
    return undefined;
  }
  // 偏好轻快模型:清理任务对能力要求低,延迟优先(§8.1 GPU+LLM ≤8s)
  const model =
    models.find((m) => /mini|haiku|flash|lite/i.test(m.family)) ?? models[0]!;
  log(`[cleanup] vscode.lm 使用 ${model.vendor}/${model.family}`);

  return {
    name: `vscode.lm(${model.family})`,
    async cleanup(text: string, signal: AbortSignal): Promise<string> {
      const cts = new vscode.CancellationTokenSource();
      const onAbort = () => cts.cancel();
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        const res = await model.sendRequest(
          [
            vscode.LanguageModelChatMessage.User(CLEANUP_PROMPT),
            vscode.LanguageModelChatMessage.User(wrapTranscript(text)),
          ],
          {},
          cts.token,
        );
        let out = '';
        for await (const frag of res.text) out += frag;
        return out;
      } finally {
        signal.removeEventListener('abort', onAbort);
        cts.dispose();
      }
    },
  };
}
