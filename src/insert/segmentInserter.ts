/**
 * P2b:分段插入器(评审 v9-① / v3-② / v4-② / v6-② / v7-⑤ 全落地)。
 *
 * - 逐段直插**仅编辑器**;段 2+ **锚定上一段插入终点,与当前光标无关**(v9-①):
 *   用户移动光标/滚动(version 未变)不改变插入位置;段 2+ 用 WorkspaceEdit(不动光标不 reveal),
 *   仅首段在 selectionUnchanged 时沿用 insertSnippet(光标跟文本走,与 batch 一致)
 * - version 出现**非管线来源变更**(用户输入/删除/撤销)或编辑器关闭 → **累计兜底模式**(v3-②):
 *   后续段内存累计,切换瞬间提示一次;绝不逐段写剪贴板(writeText 每次覆盖只剩最后一段)
 * - **终端 v1**(v6-② + v7-⑤):逐段不发,会话累计;正常结束时轻量确认 Send / Copy,
 *   Send = 一次性 sendText 不回车不代执行;Copy 或提示被关闭 = 只入剪贴板(安全默认)
 * - 正常停止等待最终输出成功;**flushFallback()**(v4-②)负责 Esc / 转写失败终止 /
 *   device-lost 的一次性剪贴板兜底;Reload 例外为已知限制(不持久化文本,隐私同音频)
 */
import * as vscode from 'vscode';
import { InsertTarget } from './dispatcher';
import { escapeSnippetText } from './logic';
import { advanceLineChar, joinAll, joinSegment } from '../segment/join';

type FallbackReason = 'doc-edited' | 'editor-closed' | 'apply-failed' | 'no-editor-target';

interface AccumulatedSegment {
  text: string;
  onVisible: (() => void) | undefined;
}

export class SegmentInserter {
  /** 编辑器实插模式;terminal/none 从会话开始就是累计模式。 */
  private live: boolean;
  private firstSegment = true;
  /** 管线锚点:上一段插入后的 document version + 插入终点(v9-①)。 */
  private anchor: { version: number; pos: vscode.Position } | undefined;
  private accumulated: AccumulatedSegment[] = [];
  private lastInserted = ''; // 段间 junction 判定(英↔英补空格)
  private fallbackNotified = false;
  private insertedSegments = 0;
  private flushed = false;

  constructor(
    private readonly target: InsertTarget,
    private readonly log: (line: string) => void,
    /**
     * chat-insert v6-B:focused-input 目标的**正常结束**单次注入(extension 注入,
     * 内部 = dispatchInsert 全套三闸/type/验证撤销/剪贴板/文案)。Esc/错误路径的
     * flushFallback 不走此通道(取消后注入是意外行为),维持纯剪贴板。
     */
    private readonly typeFlush?: (text: string) => Promise<void>,
  ) {
    this.live = target.kind === 'editor';
    if (!this.live) {
      this.log(`[inserter] target=${target.kind} → 会话累计模式(终端结束时确认 / 无目标结束入剪贴板)`);
    }
  }

  /** 管线按序调用(前段完成后段才来,保序由 pipeline 保证)。 */
  async insertSegment(text: string, onVisible?: () => void): Promise<void> {
    if (!this.live) {
      this.accumulate(text, onVisible);
      return;
    }
    const t = this.target as Extract<InsertTarget, { kind: 'editor' }>;
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === t.uri && !d.isClosed,
    );
    if (!doc) return this.switchToFallback('editor-closed', text, onVisible);

    if (this.firstSegment) {
      await this.insertFirst(doc, t, text, onVisible);
      return;
    }
    // 段 2+:锚定上一段插入终点;version 非管线变更 → 累计兜底(v9-①/v3-②)
    if (!this.anchor || doc.version !== this.anchor.version) {
      return this.switchToFallback('doc-edited', text, onVisible);
    }
    const joined = joinSegment(this.lastInserted, text);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, this.anchor.pos, joined);
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) return this.switchToFallback('apply-failed', text, onVisible);
    const end = advanceLineChar(this.anchor.pos.line, this.anchor.pos.character, joined);
    this.anchor = { version: doc.version, pos: new vscode.Position(end.line, end.character) };
    this.lastInserted = text;
    this.insertedSegments++;
    this.completeVisible([{ text, onVisible }]);
  }

  /** 首段:selectionUnchanged 沿用 insertSnippet(光标随文本,batch 一致);否则 WorkspaceEdit 到记录位。 */
  private async insertFirst(
    doc: vscode.TextDocument,
    t: Extract<InsertTarget, { kind: 'editor' }>,
    text: string,
    onVisible: (() => void) | undefined,
  ): Promise<void> {
    this.firstSegment = false;
    const editor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === t.uri,
    );
    const selectionUnchanged =
      editor !== undefined && doc.version === t.version && editor.selection.isEqual(t.selection);

    if (selectionUnchanged) {
      const ok = await editor.insertSnippet(
        new vscode.SnippetString(escapeSnippetText(text)),
        editor.selection,
        { undoStopBefore: true, undoStopAfter: true },
      );
      if (!ok) return this.switchToFallback('apply-failed', text, onVisible);
      this.anchor = { version: doc.version, pos: editor.selection.active };
      this.lastInserted = text;
      this.insertedSegments++;
      this.completeVisible([{ text, onVisible }]);
      return;
    }
    // 光标已动/文档已变:记录 range 仍合法坐标则 WorkspaceEdit 替换记录选区(不抢光标);否则兜底
    const rangeValid =
      doc.version === t.version || doc.validateRange(t.selection).isEqual(t.selection);
    if (!rangeValid) return this.switchToFallback('doc-edited', text, onVisible);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, t.selection, text);
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) return this.switchToFallback('apply-failed', text, onVisible);
    const end = advanceLineChar(t.selection.start.line, t.selection.start.character, text);
    this.anchor = { version: doc.version, pos: new vscode.Position(end.line, end.character) };
    this.lastInserted = text;
    this.insertedSegments++;
    this.completeVisible([{ text, onVisible }]);
  }

  private accumulate(text: string, onVisible?: () => void): void {
    this.accumulated.push({ text, onVisible });
    this.lastInserted = text;
  }

  /** 切换累计兜底:切换瞬间提示一次(v3-②),本段起全部内存累计。 */
  private switchToFallback(
    reason: FallbackReason,
    pendingText: string,
    onVisible?: () => void,
  ): void {
    this.live = false;
    this.accumulate(pendingText, onVisible);
    if (!this.fallbackNotified) {
      this.fallbackNotified = true;
      const why =
        reason === 'doc-edited'
          ? 'the document was edited during dictation'
          : reason === 'editor-closed'
            ? 'the target editor was closed'
            : 'inserting into the editor failed';
      this.log(`[inserter] switched to clipboard fallback: ${reason}`);
      void vscode.window.showWarningMessage(
        `VoiceFlow: ${why} — remaining segments will be collected and copied to the clipboard at the end of the session.`,
      );
    }
  }

  /**
   * 正常停止收尾:终端 = 轻量确认 Send/Copy(v7-⑤,关闭默认 Copy);
   * 其余累计内容 = 等待写入剪贴板。编辑器直插模式无累计则无事。
   */
  async finishSession(): Promise<void> {
    if (this.target.kind === 'terminal' && this.accumulated.length > 0) {
      const text = joinAll(this.accumulated.map((segment) => segment.text));
      const choice = await vscode.window.showInformationMessage(
        `VoiceFlow: dictation finished (${text.length} chars). Send to the terminal (without pressing Enter), or copy?`,
        'Send',
        'Copy',
      );
      const term = this.target.terminal;
      const alive = term.exitStatus === undefined && vscode.window.terminals.includes(term);
      if (choice === 'Send' && alive) {
        term.sendText(text, false); // 不回车、不转义、绝不代执行
        this.completeVisible(this.takeAccumulated());
        vscode.window.setStatusBarMessage('$(terminal) VoiceFlow: Sent to terminal (not executed)', 5000);
      } else {
        await vscode.env.clipboard.writeText(text);
        this.completeVisible(this.takeAccumulated());
        vscode.window.setStatusBarMessage('$(clippy) VoiceFlow: Copied to clipboard', 5000);
      }
      return;
    }
    // chat-insert v6-B:focused-input 正常结束 = 单次注入点(与 batch 同风险面,D3 逐段顾虑不适用)
    if (this.target.kind === 'focused-input' && this.accumulated.length > 0 && this.typeFlush) {
      const text = joinAll(this.accumulated.map((segment) => segment.text));
      const n = this.accumulated.length;
      this.log(`[inserter] finishSession(focused-input): ${n} segment(s), ${text.length} chars → type flush`);
      await this.typeFlush(text);
      this.completeVisible(this.takeAccumulated());
      return;
    }
    await this.finishClipboardFallback();
  }

  /**
   * 四条退出路径统一兜底(v4-②):累计文本一次性入剪贴板。幂等;错误路径销毁管线前调用,
   * 已完成未插入的段不丢。异步剪贴板写入 fire-and-forget(Reload 例外见已知限制)。
   */
  flushFallback(reason: string): void {
    const pending = this.takeAccumulated();
    if (pending.length === 0) return;
    const text = joinAll(pending.map((segment) => segment.text));
    const n = pending.length;
    this.log(`[inserter] flushFallback(${reason}): ${n} segment(s), ${text.length} chars → clipboard`);
    try {
      void Promise.resolve(vscode.env.clipboard.writeText(text)).then(() =>
        vscode.window.setStatusBarMessage(
          `$(clippy) VoiceFlow: ${n} segment(s) copied to clipboard`,
          5000,
        ),
      ).catch((error: unknown) =>
        this.log(`[inserter] flushFallback(${reason}) failed: ${String(error)}`),
      );
    } catch (error) {
      this.log(`[inserter] flushFallback(${reason}) failed: ${String(error)}`);
    }
  }

  private async finishClipboardFallback(): Promise<void> {
    if (this.flushed || this.accumulated.length === 0) return;
    const text = joinAll(this.accumulated.map((segment) => segment.text));
    const n = this.accumulated.length;
    this.log(`[inserter] finishSession: ${n} segment(s), ${text.length} chars → clipboard`);
    await vscode.env.clipboard.writeText(text);
    const pending = this.takeAccumulated();
    this.completeVisible(pending);
    vscode.window.setStatusBarMessage(
      `$(clippy) VoiceFlow: ${n} segment(s) copied to clipboard`,
      5000,
    );
  }

  private takeAccumulated(): AccumulatedSegment[] {
    if (this.flushed || this.accumulated.length === 0) return [];
    this.flushed = true;
    const pending = this.accumulated;
    this.accumulated = [];
    return pending;
  }

  private completeVisible(segments: readonly AccumulatedSegment[]): void {
    for (const segment of segments) {
      try {
        segment.onVisible?.();
      } catch {
        // Metrics callbacks are best-effort and cannot turn successful output into failure.
      }
    }
  }

  get stats(): { inserted: number; accumulated: number } {
    return { inserted: this.insertedSegments, accumulated: this.accumulated.length };
  }
}
