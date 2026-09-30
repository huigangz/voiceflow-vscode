/**
 * harness PR5:committed 音频的来源守卫(spec §10.3 机检化)。
 * 仓库里每个被跟踪的音频文件都必须在 test/fixtures/audio/fixtures.json 登记来源、SHA、格式与区段 ——
 * 防的是个人录音被 `git add -f` 或以不在 ignore 里的扩展名(mp3 等)混进仓库。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

// 测试文件按 CommonJS 编译,静态 import .mjs 会被 tsc 拒绝 → 动态加载(同 packageContract.test.ts)
type Mod = typeof import('../scripts/audioFixtures.mjs', { with: { 'resolution-mode': 'import' } });
let m: Mod;
beforeAll(async () => {
  m = await import('../scripts/audioFixtures.mjs');
});

type Entry = Parameters<Mod['checkFixtureEntry']>[0];

function makeEntry(buf: Buffer, samples: number, patch: Partial<Entry> = {}): Entry {
  return {
    file: 'x.wav',
    sha256: m.sha256(buf),
    sampleRate: 16000,
    channels: 1,
    bitsPerSample: 16,
    source: { kind: 'synthetic-procedural', generator: 'test' },
    regions: [
      { kind: 'silence', startSample: 0, endSample: samples / 2 },
      { kind: 'speech', startSample: samples / 2, endSample: samples },
    ],
    ...patch,
  };
}

describe('audioFixtures 纯函数', () => {
  it('encodeWav / decodeWav 往返', () => {
    const pcm = Int16Array.from([0, 1, -1, 32767, -32768, 1234]);
    const wav = m.decodeWav(m.encodeWav(pcm));
    expect(wav).toMatchObject({ format: 1, channels: 1, sampleRate: 16000, bitsPerSample: 16 });
    expect(Array.from(wav.pcm)).toEqual(Array.from(pcm));
  });

  it('decodeWav 跳过 fmt 与 data 之间的其他 chunk', () => {
    const base = m.encodeWav(Int16Array.from([5, 6]));
    const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([3, 0, 0, 0]), Buffer.from('abc\0')]); // 奇数长度 + 填充
    const buf = Buffer.concat([base.subarray(0, 36), list, base.subarray(36)]);
    expect(Array.from(m.decodeWav(buf).pcm)).toEqual([5, 6]);
  });

  it('decodeWav 非 WAV / 缺 data → 抛错', () => {
    expect(() => m.decodeWav(Buffer.from('not a wav file'))).toThrow(/RIFF/);
    expect(() => m.decodeWav(m.encodeWav(new Int16Array(4)).subarray(0, 36))).toThrow(/data/);
  });

  it('findUnregisteredAudio:目录外 / 未登记 / 各种扩展名(大小写不敏感)', () => {
    const manifest = { fixtures: [{ file: 'ok.wav' }] };
    const errors = m.findUnregisteredAudio(
      [
        'test/fixtures/audio/ok.wav',
        'test/fixtures/audio/README.md',
        'test/fixtures/audio/fixtures.json',
        'test/fixtures/audio/new.wav',
        'recording.MP3',
        'test-audio/zh.wav',
        'docs/voice.m4a',
        'src/audio/wav.ts',
      ],
      manifest,
    );
    expect(errors).toEqual([
      '音频文件未登记在 test/fixtures/audio/fixtures.json: test/fixtures/audio/new.wav',
      '音频文件不在 test/fixtures/audio/ 下: recording.MP3',
      '音频文件不在 test/fixtures/audio/ 下: test-audio/zh.wav',
      '音频文件不在 test/fixtures/audio/ 下: docs/voice.m4a',
    ]);
  });

  it('checkFixtureEntry:合规条目无错误', () => {
    const buf = m.encodeWav(new Int16Array(100));
    expect(m.checkFixtureEntry(makeEntry(buf, 100), buf)).toEqual([]);
  });

  it('checkFixtureEntry:SHA 不符 / 格式不符 / 来源缺字段 / 区段有缝或未覆盖', () => {
    const buf = m.encodeWav(new Int16Array(100));
    const check = (patch: Partial<Entry>, b = buf) => m.checkFixtureEntry(makeEntry(b, 100, patch), b).join('\n');

    const flipped = Buffer.from(buf);
    flipped.writeUInt8(flipped.readUInt8(50) ^ 1, 50);
    expect(m.checkFixtureEntry(makeEntry(buf, 100), flipped).join('\n')).toMatch(/SHA 不符/);

    const at8k = m.encodeWav(new Int16Array(100), 8000);
    expect(check({ sha256: m.sha256(at8k) }, at8k)).toMatch(/格式须为/);

    expect(check({ source: { kind: 'personal-recording' } })).toMatch(/source\.kind 非法/);
    expect(check({ source: { kind: 'synthetic-tts', engine: 'SAPI' } })).toMatch(/source\.voice 缺失[\s\S]*source\.generator 缺失/);
    expect(check({ source: { kind: 'licensed', license: 'CC0-1.0' } })).toMatch(/source\.url 缺失/);

    expect(check({ regions: [] })).toMatch(/regions 为空/);
    expect(
      check({
        regions: [
          { kind: 'silence', startSample: 0, endSample: 40 },
          { kind: 'speech', startSample: 50, endSample: 100 },
        ],
      }),
    ).toMatch(/未与上一段首尾相接/);
    expect(check({ regions: [{ kind: 'speech', startSample: 0, endSample: 90 }] })).toMatch(/未恰好覆盖/);
    expect(check({ regions: [{ kind: 'music' as 'speech', startSample: 0, endSample: 100 }] })).toMatch(/kind 非法/);
  });
});

describe('仓库里的 committed 音频', () => {
  it('每个被跟踪的音频文件都登记在清单里,且清单每条都合规', () => {
    const manifest = JSON.parse(readFileSync(m.MANIFEST, 'utf8'));
    const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);

    expect(m.findUnregisteredAudio(tracked, manifest)).toEqual([]);
    expect(manifest.fixtures.length).toBeGreaterThan(0);
    for (const entry of manifest.fixtures) {
      expect(tracked, `${entry.file} 登记了但未被 git 跟踪`).toContain(`${m.FIXTURE_DIR}/${entry.file}`);
      expect(m.checkFixtureEntry(entry, readFileSync(`${m.FIXTURE_DIR}/${entry.file}`))).toEqual([]);
    }
  });
});
