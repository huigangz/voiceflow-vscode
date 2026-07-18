import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env, window, workspace } from './__mocks__/vscode';
import { SegmentInserter } from '../src/insert/segmentInserter';
import type { InsertTarget } from '../src/insert/dispatcher';

function insertVisible(
  inserter: SegmentInserter,
  text: string,
  onVisible: () => void,
): Promise<void> {
  return inserter.insertSegment(text, onVisible);
}

beforeEach(() => {
  env.clipboard.writeText = async () => {};
  window.terminals = [];
  window.visibleTextEditors = [];
  window.showInformationMessage = async () => undefined;
  window.showWarningMessage = async () => undefined;
  workspace.textDocuments = [];
});

describe('SegmentInserter visible completion', () => {
  it('does not block accumulation and completes every none-target segment after clipboard succeeds', async () => {
    let releaseClipboard!: () => void;
    const clipboardStarted = new Promise<void>((resolve) => {
      env.clipboard.writeText = vi.fn(async () => {
        resolve();
        await new Promise<void>((release) => { releaseClipboard = release; });
      });
    });
    const firstVisible = vi.fn();
    const secondVisible = vi.fn();
    const inserter = new SegmentInserter({ kind: 'none' }, vi.fn());

    await insertVisible(inserter, 'first', firstVisible);
    await insertVisible(inserter, 'second', secondVisible);
    expect(firstVisible).not.toHaveBeenCalled();
    expect(secondVisible).not.toHaveBeenCalled();

    let finished = false;
    const finishing = inserter.finishSession().then(() => { finished = true; });
    await clipboardStarted;
    expect(finished).toBe(false);
    expect(firstVisible).not.toHaveBeenCalled();
    releaseClipboard();
    await finishing;
    expect(firstVisible).toHaveBeenCalledOnce();
    expect(secondVisible).toHaveBeenCalledOnce();
  });

  it('completes terminal segments only after the final send succeeds', async () => {
    const terminal = { exitStatus: undefined, sendText: vi.fn() };
    window.terminals = [terminal];
    window.showInformationMessage = async () => 'Send';
    const visible = vi.fn();
    const inserter = new SegmentInserter(
      { kind: 'terminal', terminal } as unknown as InsertTarget,
      vi.fn(),
    );

    await insertVisible(inserter, 'terminal text', visible);
    expect(visible).not.toHaveBeenCalled();
    await inserter.finishSession();
    expect(terminal.sendText).toHaveBeenCalledWith('terminal text', false);
    expect(visible).toHaveBeenCalledOnce();
  });

  it('completes focused-input segments only after the awaited type flush succeeds', async () => {
    let releaseType!: () => void;
    let typeStarted!: () => void;
    const started = new Promise<void>((resolve) => { typeStarted = resolve; });
    const typeFlush = vi.fn(async () => {
      typeStarted();
      await new Promise<void>((resolve) => { releaseType = resolve; });
    });
    const visible = vi.fn();
    const inserter = new SegmentInserter({ kind: 'focused-input' }, vi.fn(), typeFlush);

    await insertVisible(inserter, 'focused text', visible);
    const finishing = inserter.finishSession();
    await started;
    expect(visible).not.toHaveBeenCalled();
    releaseType();
    await finishing;
    expect(visible).toHaveBeenCalledOnce();
  });

  it('defers an editor fallback segment until its final clipboard write succeeds', async () => {
    let releaseClipboard!: () => void;
    let clipboardStarted!: () => void;
    const started = new Promise<void>((resolve) => { clipboardStarted = resolve; });
    env.clipboard.writeText = vi.fn(async () => {
      clipboardStarted();
      await new Promise<void>((resolve) => { releaseClipboard = resolve; });
    });
    const visible = vi.fn();
    const target = { kind: 'editor', uri: 'file:///missing', version: 1, selection: {} } as InsertTarget;
    const inserter = new SegmentInserter(target, vi.fn());

    await insertVisible(inserter, 'fallback text', visible);
    expect(visible).not.toHaveBeenCalled();
    const finishing = inserter.finishSession();
    await started;
    expect(visible).not.toHaveBeenCalled();
    releaseClipboard();
    await finishing;
    expect(visible).toHaveBeenCalledOnce();
  });

  it('does not complete a visible sample when focused final output fails', async () => {
    const visible = vi.fn();
    const inserter = new SegmentInserter(
      { kind: 'focused-input' },
      vi.fn(),
      async () => { throw new Error('type failed'); },
    );
    await insertVisible(inserter, 'not visible', visible);
    await expect(inserter.finishSession()).rejects.toThrow('type failed');
    expect(visible).not.toHaveBeenCalled();
  });

  it('does not complete a visible sample when terminal send throws synchronously', async () => {
    const terminal = {
      exitStatus: undefined,
      sendText: vi.fn(() => { throw new Error('terminal failed'); }),
    };
    window.terminals = [terminal];
    window.showInformationMessage = async () => 'Send';
    const visible = vi.fn();
    const inserter = new SegmentInserter(
      { kind: 'terminal', terminal } as unknown as InsertTarget,
      vi.fn(),
    );
    await insertVisible(inserter, 'not sent', visible);
    await expect(inserter.finishSession()).rejects.toThrow('terminal failed');
    expect(visible).not.toHaveBeenCalled();
  });

  it('does not complete a visible sample when final clipboard output rejects', async () => {
    env.clipboard.writeText = async () => { throw new Error('clipboard failed'); };
    const visible = vi.fn();
    const inserter = new SegmentInserter({ kind: 'none' }, vi.fn());
    await insertVisible(inserter, 'not copied', visible);
    await expect(inserter.finishSession()).rejects.toThrow('clipboard failed');
    expect(visible).not.toHaveBeenCalled();
  });

  it('suppresses visible samples when cancellation flushes accumulated text', async () => {
    let clipboardWritten!: () => void;
    const written = new Promise<void>((resolve) => { clipboardWritten = resolve; });
    env.clipboard.writeText = vi.fn(async () => { clipboardWritten(); });
    const visible = vi.fn();
    const inserter = new SegmentInserter({ kind: 'none' }, vi.fn());
    await insertVisible(inserter, 'cancelled text', visible);
    inserter.flushFallback('esc');
    await written;
    expect(visible).not.toHaveBeenCalled();
  });

  it('contains a synchronous clipboard failure during cancellation flush', async () => {
    env.clipboard.writeText = () => { throw new Error('clipboard threw'); };
    const visible = vi.fn();
    const inserter = new SegmentInserter({ kind: 'none' }, vi.fn());
    await insertVisible(inserter, 'cancelled text', visible);
    expect(() => inserter.flushFallback('esc')).not.toThrow();
    expect(visible).not.toHaveBeenCalled();
  });
});
