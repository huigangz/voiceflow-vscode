export interface FixtureRegion {
  kind: 'speech' | 'silence';
  startSample: number;
  endSample: number;
  text?: string;
}

export interface FixtureEntry {
  file: string;
  sha256: string;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  source: { kind: string; [k: string]: string };
  regions: FixtureRegion[];
}

export interface FixtureManifest {
  fixtures: FixtureEntry[];
}

export interface DecodedWav {
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  pcm: Int16Array;
}

export declare const FIXTURE_DIR: string;
export declare const MANIFEST: string;
export declare const SAMPLE_RATE: number;
export declare const AUDIO_EXTENSIONS: string[];
export declare const SOURCE_KINDS: Record<string, string[]>;
export declare function encodeWav(pcm: Int16Array, sampleRate?: number): Buffer;
export declare function decodeWav(buf: Buffer): DecodedWav;
export declare function sha256(buf: Buffer): string;
export declare function findUnregisteredAudio(trackedFiles: string[], manifest: { fixtures: { file: string }[] }): string[];
export declare function checkFixtureEntry(entry: FixtureEntry, buf: Buffer): string[];
