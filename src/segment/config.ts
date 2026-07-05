/**
 * P2b:segmented 模式配置校验(纯逻辑,可单测)。
 * 评审 v5-② + v7-⑥:所有非法值**拒绝进入 segmented 并报配置错误,不静默 clamp**
 * (用户设 auto-stop 1s 时默认 pause 1.5s 永远切不了段,必须显式暴露)。
 * schema 侧另有 minimum: 0.5(package.json);本函数是运行时防线(settings.json 手写可绕过 schema)。
 */

export interface SegmentedConfigInput {
  /** voiceflow.output.segmentPause(秒)。 */
  segmentPauseS: unknown;
  /** voiceflow.recording.autoStopSilence(秒,0=禁用自动停)。 */
  autoStopSilenceS: number;
}

export type SegmentedConfigResult =
  | { ok: true; segmentPauseMs: number }
  | { ok: false; error: string };

export function validateSegmentedConfig(input: SegmentedConfigInput): SegmentedConfigResult {
  const p = input.segmentPauseS;
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0.5) {
    return {
      ok: false,
      error:
        `Invalid "voiceflow.output.segmentPause" (${String(p)}): must be a finite number >= 0.5 (seconds). ` +
        'Segmented mode is disabled until this is fixed.',
    };
  }
  // autoStopSilence=0(禁用)→ 无上界约束(评审 v5-②)
  if (input.autoStopSilenceS > 0 && p >= input.autoStopSilenceS) {
    return {
      ok: false,
      error:
        `"voiceflow.output.segmentPause" (${p}s) must be smaller than "voiceflow.recording.autoStopSilence" ` +
        `(${input.autoStopSilenceS}s), otherwise the session auto-stops before any segment can be cut. ` +
        'Segmented mode is disabled until this is fixed.',
    };
  }
  return { ok: true, segmentPauseMs: p * 1000 };
}
