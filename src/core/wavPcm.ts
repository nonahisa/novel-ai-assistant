/**
 * 音声合成のエンジンが返す WAV を読み、1話の音へつなぐ（設計書6.42.4）。
 *
 * ## ここは vscode に触らない
 *
 * 音の計算だけなので、テストで本物の形の WAV を渡して確かめられる。
 * `Buffer` も使わない（`DataView` で読む）。
 *
 * ## 読めるのは 16bit の PCM だけ
 *
 * AivisSpeech も VOICEVOX も 16bit の PCM を返す。ほかの形（8bit・浮動小数・圧縮）は
 * 見当でつながずに止める——つなぎ方を間違えると、雑音の MP3 が黙ってできる。
 */

export interface PcmFormat {
  sampleRate: number;
  channels: number;
}

/** 音1つ。`samples` は声の数ぶん交互に並ぶ（ステレオなら 左・右・左・右…） */
export interface PcmClip {
  format: PcmFormat;
  samples: Int16Array;
}

/** WAV が読めない・つなげないとき。**作者向けの文**で投げる */
export class WavError extends Error {}

/**
 * WAV を読む。**塊（チャンク）を歩いて `fmt ` と `data` を探す**——
 * 頭から44バイト目を音と決めつけると、`LIST` などの塊が前にある WAV で
 * 塊の中身を音として読んでしまう。
 */
export function parseWav(bytes: Uint8Array): PcmClip {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number): string =>
    String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    throw new WavError("合成の答えが WAV の形ではありません");
  }
  let format: (PcmFormat & { bits: number; code: number }) | undefined;
  let data: { start: number; length: number } | undefined;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt " && size >= 16 && body + 16 <= bytes.length) {
      format = {
        code: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      // 長さが実物より長く書かれた WAV（作りかけ）もあるので、実物の長さで切る
      data = { start: body, length: Math.min(size, bytes.length - body) };
    }
    // 塊は偶数バイトで並ぶ（奇数の長さなら1バイト詰め物がある）
    offset = body + size + (size % 2);
  }
  if (!format || !data) {
    throw new WavError("合成の答えの WAV に、音の形（fmt）か音（data）がありません");
  }
  // 1 は PCM。0xFFFE（拡張の形）でも中身が PCM のことはあるが、確かめずに受けない
  if (format.code !== 1 || format.bits !== 16) {
    throw new WavError(
      `合成の答えの WAV が 16bit の PCM ではありません（形 ${format.code}・${format.bits}bit）`
    );
  }
  if (format.channels < 1 || format.channels > 2 || format.sampleRate <= 0) {
    throw new WavError(
      `合成の答えの WAV の形が読めません（声 ${format.channels}・${format.sampleRate}Hz）`
    );
  }
  const count = Math.floor(data.length / 2);
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i++) samples[i] = view.getInt16(data.start + i * 2, true);
  return { format: { sampleRate: format.sampleRate, channels: format.channels }, samples };
}

/**
 * 文ごとの音を、文の前の間（`gapMs`）の無音を入れてつなぐ。最初の文の前には入れない
 * （書き出した音の頭が黙らないように。画面で鳴らすときも最初の文は間を空けない）。
 *
 * **形が揃わない音はつながない**（標本化の速さを合わせ直す計算は持たない。
 * 声ごとに速さの違うエンジンがあれば、作者に分かる文で止める）。
 */
export function joinClips(parts: ReadonlyArray<{ clip: PcmClip; gapMs: number }>): PcmClip {
  const first = parts[0]?.clip.format;
  if (!first) throw new WavError("つなぐ音がありません");
  let total = 0;
  const gaps: number[] = [];
  parts.forEach(({ clip, gapMs }, i) => {
    if (clip.format.sampleRate !== first.sampleRate || clip.format.channels !== first.channels) {
      throw new WavError(
        `声によって音の形が揃いません（${first.sampleRate}Hz・${first.channels}声と ` +
          `${clip.format.sampleRate}Hz・${clip.format.channels}声）。同じエンジンの声だけで書き出してください`
      );
    }
    const gap = i === 0 ? 0 : silenceLength(first, gapMs);
    gaps.push(gap);
    total += gap + clip.samples.length;
  });
  const samples = new Int16Array(total);
  let at = 0;
  parts.forEach(({ clip }, i) => {
    at += gaps[i]; // 無音は 0 のまま（Int16Array は 0 で埋まって始まる）
    samples.set(clip.samples, at);
    at += clip.samples.length;
  });
  return { format: first, samples };
}

/** 無音の標本の数。声の数の倍数にする（ずれると左右が入れ替わる） */
function silenceLength(format: PcmFormat, gapMs: number): number {
  const ms = Number.isFinite(gapMs) && gapMs > 0 ? gapMs : 0;
  return Math.round((format.sampleRate * ms) / 1000) * format.channels;
}

/** 音の長さ（秒） */
export function clipSeconds(clip: PcmClip): number {
  return clip.samples.length / clip.format.channels / clip.format.sampleRate;
}
