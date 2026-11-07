import type { PcmClip } from "./wavPcm";
import { VoiceEngineError } from "./voiceEngine";

/**
 * つないだ音を MP3 にする（設計書6.42.4）。
 *
 * ## 変換の部品は外から渡す
 *
 * 変換は LAME の JavaScript 版（`@breezystack/lamejs`。LGPL-3.0）で行う。
 * **LGPL の部品は、拡張機能の束（`dist/extension.js`）へ混ぜずに別のファイル
 * （`dist/lame.js`）として配る**——LAME 自身が「別のファイルとして結んで使う」形を
 * 勧めており、作者や利用者が部品だけを差し替えられる（THIRD-PARTY-NOTICES.md）。
 * そのためここは部品を import せず、作り方（`Mp3EncoderFactory`）を受け取る。
 * テストはパッケージから直接渡す。
 *
 * vscode にも Node にも触らない（純 JavaScript の計算だけ）。
 */

/** LAME の変換器の口（`Mp3Encoder` と同じ形） */
export interface Mp3EncoderLike {
  encodeBuffer(left: Int16Array, right?: Int16Array): Uint8Array;
  flush(): Uint8Array;
}

export type Mp3EncoderFactory = (channels: number, sampleRate: number, kbps: number) => Mp3EncoderLike;

/**
 * 音の速さ。声の朗読なので 128kbps で足りる（AivisSpeech の 44.1kHz でも聞き分けにくい）。
 * 1時間で約 58MB
 */
export const MP3_KBPS = 128;

/** 1回に渡す標本の数（MP3 の1フレームは 1152 標本。その倍数にする） */
const BLOCK = 1152 * 20;
/** 何ブロックごとに手を離すか（中止の合図と、画面の進み具合を通すため） */
const YIELD_EVERY = 8;

export async function encodeMp3(
  clip: PcmClip,
  factory: Mp3EncoderFactory,
  options: { kbps?: number; signal?: AbortSignal; onProgress?: (done: number) => void } = {}
): Promise<Uint8Array> {
  const { channels, sampleRate } = clip.format;
  const encoder = factory(channels, sampleRate, options.kbps ?? MP3_KBPS);
  const frames = clip.samples.length / channels;
  const parts: Uint8Array[] = [];
  let blocks = 0;
  for (let start = 0; start < frames; start += BLOCK) {
    if (options.signal?.aborted) throw new VoiceEngineError("aborted", "中止しました");
    const end = Math.min(frames, start + BLOCK);
    if (channels === 1) {
      parts.push(encoder.encodeBuffer(clip.samples.subarray(start, end)));
    } else {
      // ステレオは左右を分けて渡す（並びは 左・右・左・右…）
      const left = new Int16Array(end - start);
      const right = new Int16Array(end - start);
      for (let i = start; i < end; i++) {
        left[i - start] = clip.samples[i * 2];
        right[i - start] = clip.samples[i * 2 + 1];
      }
      parts.push(encoder.encodeBuffer(left, right));
    }
    blocks++;
    if (blocks % YIELD_EVERY === 0) {
      options.onProgress?.(end / frames);
      // 変換は重い計算なので、ときどき手を離す（拡張機能のほかの処理と中止を止めない）
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  if (options.signal?.aborted) throw new VoiceEngineError("aborted", "中止しました");
  parts.push(encoder.flush());
  options.onProgress?.(1);
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
