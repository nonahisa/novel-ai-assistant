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

/**
 * 測った速さの比（かかった秒÷音の長さの秒）を、エンジンごとに覚える（作者の依頼 2026-11-14。
 * ［音声に書き出す］の確認の窓に「この PC では何分かかる見込みか」を出すため）。
 *
 * ノートPC（AivisSpeech を CPU）の実測：第16話 3,069字で、音の長さ 507秒に 1,893秒（約3.7倍）。
 * 音の長さの見積もりだけでは、遅い PC で待つ時間を実際の数分の一に思わせてしまう。
 *
 * **端末へは要約だけ残す**（エンジンごとに 直近の比・数えた文の数・測った日時。本文や文は書かない）。
 * 再起動のあとの最初の書き出しでも見込みを出すため。PC の速さは負荷や設定で変わるので、
 * `PACE_STORED_MAX_AGE_DAYS` 日より前の比は使わない。壊れた値は使わず捨てる。
 * 今回の起動で十分に測れたら、そちらを優先する。読み上げ・書き出しで新しく作った文だけを数える
 * （控えから出した音は数えない）。**はじめの数文は数えない**（モデルの読み込みで遅く出る。
 * 見張りと同じ理由）。`PACE_MEMORY_MIN` 文に満たないうちは比を返さない（推測の数字を出さない）。
 * 古い文は捨て、直近の `PACE_MEMORY_WINDOW` 文だけで出す。
 */
export const PACE_MEMORY_MIN = 3;
export const PACE_MEMORY_WINDOW = 40;

/** 端末に残した比を使ってよい日数（これより前に測った比は使わない） */
export const PACE_STORED_MAX_AGE_DAYS = 90;

/** 端末に残す1エンジンぶんの要約 */
export interface PaceSummary {
  /** 音1秒を作るのにかかる秒 */
  ratio: number;
  /** その比を出した文の数 */
  count: number;
  /** 測った日時（ISO 8601） */
  at: string;
}

/** 端末に残す形の鍵（`novelai.voicePace.ratios`）。書く口は `features/voiceReading.ts` の1か所 */
export const VOICE_PACE_STORED_KEY = "novelai.voicePace.ratios";

export class PaceMemory<K extends string = string> {
  private readonly counted = new Map<K, number>();
  private readonly samples = new Map<K, Array<{ elapsed: number; audio: number }>>();
  /** 前の起動までに端末へ残した要約（読み戻したもの） */
  private readonly restored = new Map<K, PaceSummary>();
  /** 前に保存してから、新しく測った文があるか */
  private dirty = false;

  constructor(
    private readonly warmup = PACE_WARMUP_SENTENCES,
    /** 時刻（ミリ秒）。古さの判定と測った日時に使う。テストで差し替える */
    private readonly nowMs: () => number = () => Date.now()
  ) {}

  /** 保存の要るものがあれば true を返して印を下ろす */
  takeDirty(): boolean {
    const was = this.dirty;
    this.dirty = false;
    return was;
  }

  /**
   * 端末に残した要約を読み戻す。**壊れた値は使わず捨てる**（形が違う・数でない・0以下・日時が読めない・
   * 数えた文が `PACE_MEMORY_MIN` 未満）。壊れたものがあれば false を返す（呼び手がログに1行残す）。
   * 古い・未来の日時のものは壊れではないが、使わない（`ratio` が見る）
   */
  restore(raw: unknown): boolean {
    if (raw === undefined || raw === null) return true;
    if (typeof raw !== "object" || Array.isArray(raw)) return false;
    let intact = true;
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const one = value as Partial<Record<keyof PaceSummary, unknown>> | null;
      if (
        typeof one !== "object" ||
        one === null ||
        typeof one.ratio !== "number" ||
        !Number.isFinite(one.ratio) ||
        !(one.ratio > 0) ||
        typeof one.count !== "number" ||
        !Number.isInteger(one.count) ||
        typeof one.at !== "string" ||
        !Number.isFinite(Date.parse(one.at))
      ) {
        intact = false;
        continue;
      }
      if (one.count < PACE_MEMORY_MIN) continue;
      this.restored.set(key as K, { ratio: one.ratio, count: one.count, at: one.at });
    }
    return intact;
  }

  /** 端末へ残す要約。今回十分に測れたエンジンは今の値、そうでなければ読み戻した値をそのまま残す */
  snapshot(): Record<string, PaceSummary> {
    const out: Record<string, PaceSummary> = {};
    for (const [key, summary] of this.restored) out[key] = summary;
    for (const [key, list] of this.samples) {
      const ratio = this.liveRatio(key);
      if (ratio === undefined) continue;
      out[key] = { ratio, count: list.length, at: new Date(this.nowMs()).toISOString() };
    }
    return out;
  }

  record(key: K, elapsedSeconds: number, audioSeconds: number | undefined): void {
    if (audioSeconds === undefined || !(audioSeconds > 0) || !Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
      return;
    }
    const seen = (this.counted.get(key) ?? 0) + 1;
    this.counted.set(key, seen);
    if (seen <= this.warmup) return;
    const list = this.samples.get(key) ?? [];
    list.push({ elapsed: elapsedSeconds, audio: audioSeconds });
    if (list.length > PACE_MEMORY_WINDOW) list.shift();
    this.samples.set(key, list);
    this.dirty = true;
  }

  /** 音1秒を作るのにかかる秒。測れていなければ undefined（今回の起動で十分に測れなければ、端末に残した新しい比） */
  ratio(key: K): number | undefined {
    const live = this.liveRatio(key);
    if (live !== undefined) return live;
    const stored = this.restored.get(key);
    if (!stored) return undefined;
    const age = this.nowMs() - Date.parse(stored.at);
    return age >= 0 && age <= PACE_STORED_MAX_AGE_DAYS * 24 * 3600 * 1000 ? stored.ratio : undefined;
  }

  private liveRatio(key: K): number | undefined {
    const list = this.samples.get(key);
    if (!list || list.length < PACE_MEMORY_MIN) return undefined;
    const total = list.reduce(
      (sum, one) => ({ elapsed: sum.elapsed + one.elapsed, audio: sum.audio + one.audio }),
      { elapsed: 0, audio: 0 }
    );
    return total.audio > 0 ? total.elapsed / total.audio : undefined;
  }
}

/**
 * 書き出しにかかる見込みの秒。**どれかのエンジンの比が無ければ undefined**
 * （一部だけの足し算は、足りない分だけ短く見せてしまう）
 */
export function expectedWorkSeconds(
  parts: ReadonlyArray<{ audioSeconds: number; ratio: number | undefined }>
): number | undefined {
  if (parts.length === 0) return undefined;
  let total = 0;
  for (const part of parts) {
    if (part.ratio === undefined || !(part.ratio > 0)) return undefined;
    total += part.audioSeconds * part.ratio;
  }
  return total;
}
