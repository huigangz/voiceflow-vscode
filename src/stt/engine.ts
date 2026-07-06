/**
 * inproc-s2:引擎抽象(plan v7 §3.1)。
 *
 * - WhisperEngine = 现 WhisperRunner 公共面的接口化;s4 的 InprocessEngine / EngineManager
 *   实装于此接口之上(WhisperRunner 本身即 server/cli 引擎实现)
 * - dispose / updateConfig 显式异步(v6-③ / v7-②):inprocess 需等在途推理 settle 后才能
 *   释放 pipeline;server/cli 即时 resolve。调用方(引擎切换 / 配置监听 / deactivate)必须 await
 * - EngineBlockedError:应用控制策略拦截的**内部错误类型**(v5-④),不进 WhisperErrorKind
 *   三分;s4 起不出 EngineManager(auto → 触发回退,显式 server/cli → 对外映射 permanent)。
 *   s4 之前的过渡期:直接到达调用方按普通错误呈现(message 已带指引,优于现状的未处理
 *   error 事件/120s 空转)
 */
import type { TranscribeOptions, TranscribeResult, WhisperConfig } from './whisperRunner';

export interface WhisperEngine {
  /** 预热:single-flight,代际 key,失败清空可重试;不收 session signal(v10-①)。 */
  prepare(): Promise<{ coldStartMs?: number }>;
  /** typed error 三分(cancelled/transient/permanent)不变;取消所有权归调用方。 */
  transcribe(wavPath: string, opts?: TranscribeOptions): Promise<TranscribeResult>;
  /** v7-②:内部等旧代际释放完成,调用方必须 await(防新旧引擎/模型并存)。 */
  updateConfig(cfg: WhisperConfig): Promise<void>;
  /** active-use lease:获取即清 idle 计时器;返回幂等 release(v11-②)。 */
  acquireLease(): () => void;
  /** v6-③:异步 dispose——inprocess 等在途推理 settle;server/cli 即时。 */
  dispose(): Promise<void>;
}

/**
 * 策略拦截(Trusted Ownership / SAC 等应用控制)的内部错误。
 *
 * 判据(s1-d 公司机实测 2026-07-06,B' 形态定案,worklog inproc-s1):
 * ① spawn error 且 errno ∈ {UNKNOWN, EPERM}(SAC 形态,副判据——Trusted Ownership
 *    实测不走这里);
 * ② **静默无输出(主判据)**:零 stderr AND(退出任意码**含 0** OR 无输出 watchdog 到点)
 *    AND 从未就绪——正常 whisper-server 数百 ms 内必有 stderr 加载日志;真实崩溃有
 *    stderr 或非零码。自杀进程(dispose/代际失效 kill,`proc.killed`)不适用,维持 transient。
 */
export class EngineBlockedError extends Error {
  override readonly name: string = 'EngineBlockedError';
}

/**
 * v4-⑦:检测语言 → 会话锁定语言的**唯一映射点**。
 * 兼容两种数据源词汇:server verbose_json('chinese'/'english')与
 * inprocess 输出 token 码('zh'/'en';调用方已剥掉 <|…|>)。
 */
export function normalizeDetectedLanguage(raw: string | undefined): 'zh' | 'en' | undefined {
  switch (raw) {
    case 'chinese':
    case 'zh':
      return 'zh';
    case 'english':
    case 'en':
      return 'en';
    default:
      return undefined;
  }
}
