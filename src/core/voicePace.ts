import { clipSeconds, parseWav } from "./wavPcm";

/**
 * 人物の声の「声づくりが読む速さに追いついているか」を見張る（設計書6.42.3。0.146.0）。
 *
 * ノートPCの実機確認（i5-1335U・メモリ 8GB・GPU なし・AivisSpeech を CPU で）：約8.5秒の音を
 * 作るのに 13.6〜23.3秒かかった。遅いのは synthesis（audio_query は 0.3〜0.4秒）で、読む速さの
 * 半分ほどしか出ず、先読み（後ろの3文・同時に2つ）をしても文の間があく。作者は「かなり間があきます」。
 * 追いつかない PC では先読みを深くしても間は消えないので、深さは変えずに、測った値で一度知らせる。
 *
 * ここは vscode に触らない純粋な計算（測るのは features の側。時刻も外から渡す）。
 */

/**
 * はじめに数えない文の数。**最初の数文は遅く出やすい**——エンジンがモデルを読み込む・温まる
 * うえ、読み始めは今の文と先読みの文を同時に頼むので、1文ぶんの待ちに前の文の待ちが重なる。
 * ここで知らせると、速い PC でも読み始めのたびに出てしまう
 */
export const PACE_WARMUP_SENTENCES = 2;

/**
 * 続けて遅かったら知らせる文の数。**1文だけ遅いのは、長い文・ほかの処理の割り込みでも起きる**
 * ので数えない。3文続けば、先読みの貯め（後ろの3文）を使い切り、文の間があき始める
 */
export const PACE_SLOW_STREAK = 3;

/** WAV の音の長さ（秒）。読めない形なら undefined（測らないだけで、読み上げは止めない） */
export function wavSeconds(bytes: Uint8Array): number | undefined {
  try {
    const seconds = clipSeconds(parseWav(bytes));
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  } catch {
    return undefined;
  }
}

/** 遅かった文の、1文あたりの値（知らせに出す） */
export interface SlowPace {
  /** 1文の音の長さ（秒。平均） */
  audioSeconds: number;
  /** 1文を作るのにかかった時間（秒。平均） */
  elapsedSeconds: number;
}

/**
 * 1回の読み上げの間、文ごとの「作るのにかかった時間÷できた音の長さ」を見る。
 * 1を超える文が（はじめの数文を除いて）続けて `PACE_SLOW_STREAK` 文あったら、**一度だけ**
 * その文たちの値を返す。読み上げを始め直したら `reset` する（覚えずに、毎回の読み上げで見る）
 */
export class SynthesisPaceWatch {
  private counted = 0;
  private streak: Array<{ elapsed: number; audio: number }> = [];
  private told = false;

  constructor(
    private readonly warmup = PACE_WARMUP_SENTENCES,
    private readonly needed = PACE_SLOW_STREAK
  ) {}

  reset(): void {
    this.counted = 0;
    this.streak = [];
    this.told = false;
  }

  /** 新しく作った1文を記録する。知らせるときだけ値を返す */
  record(elapsedSeconds: number, audioSeconds: number | undefined): SlowPace | undefined {
    if (this.told) return undefined;
    if (audioSeconds === undefined || !(audioSeconds > 0) || !Number.isFinite(elapsedSeconds)) return undefined;
    this.counted++;
    if (this.counted <= this.warmup) return undefined;
    if (elapsedSeconds / audioSeconds <= 1) {
      this.streak = [];
      return undefined;
    }
    this.streak.push({ elapsed: elapsedSeconds, audio: audioSeconds });
    if (this.streak.length < this.needed) return undefined;
    this.told = true;
    const total = this.streak.reduce(
      (sum, one) => ({ elapsed: sum.elapsed + one.elapsed, audio: sum.audio + one.audio }),
      { elapsed: 0, audio: 0 }
    );
    return {
      audioSeconds: total.audio / this.streak.length,
      elapsedSeconds: total.elapsed / this.streak.length,
    };
  }
}

/**
 * 知らせの文。**測った値で出す**。エンジンの名前は選んでいる側（決め打ちしない）。
 * もう片方のエンジンを勧める言葉は書かない——ほかのエンジンでどうなるかはまだ測っていない
 */
export function slowPaceNotice(engineLabel: string, pace: SlowPace): string {
  const audio = pace.audioSeconds.toFixed(1);
  const elapsed = Math.round(pace.elapsedSeconds);
  return (
    `この PC では、${engineLabel} の声づくりが読む速さに追いついていません（${audio}秒の音に約${elapsed}秒）。` +
    "［音声に書き出す］で先に作っておくと、間をあけずに聞けます。"
  );
}
