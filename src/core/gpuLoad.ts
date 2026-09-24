/**
 * 手元のAIへ送る前に、**管理の外の負荷**が無いかを見る（設計書6.76.2）。
 *
 * 札（`localAiLease.ts`）が並べられるのは、この拡張機能と MCP サーバーの
 * 送信だけである。ほかのアプリ——ゲーム・動画・LM Studio 単体・ほかの Ollama の
 * 使い手——は札を取らない。**札が空いているのに GPU が忙しい、メモリが埋まって
 * いる**なら、原因は管理の外にあるとみなして作者に知らせる。
 *
 * ## 見るもの
 *
 * - `nvidia-smi`（NVIDIA の GPU のときだけ）：使用率と、GPU のメモリの使用量・全体
 * - Ollama の `/api/ps`：いま読み込まれているモデルと、それが GPU に載せた量
 *   （**Ollama 自身が載せた分は「ほかのアプリ」から差し引く**——前の実行で
 *   こちらが載せたモデルが、しばらく残っているのはふつうのことだから）
 *
 * ## 閾値（2026-09-25 に作者の機械で実測。RTX 4060 Ti 8GB）
 *
 * - 何もしていないとき：使用率 0%（ときどき 10〜20% が1回だけ跳ねる）、
 *   メモリ 910〜1,032MiB（画面・ブラウザ・VS Code・Claude などの常駐）
 * - Ollama が生成しているとき：使用率 68〜100%
 * - Ollama がモデルを読み込んでいる最中：メモリ 4,840〜5,801MiB、使用率 0〜20%、
 *   **`/api/ps` は空のまま**（読み込みが終わるまで一覧に出ない）。
 *   2026-09-25 朝の「Ollama は何も読み込んでいないのに 5.4GB」はこの形だった見込みが高い
 * - こちらが載せたモデルが残っているだけのとき（`gemma4:e4b`・文脈16,384）：
 *   メモリ 5,149〜5,261MiB、一覧の `size_vram` は 3,063〜3,103MiB
 *   ——**一覧は実際より約1.1GB少ない**（下の `OTHER_VRAM_FLOOR_MIB`）
 *
 * そこで次の2つのどちらかで「管理の外の負荷」とみなす。
 *
 * 1. **使用率の中央値が 50% 以上**（3回測る。1回だけの跳ねで騒がない）
 * 2. **ほかのアプリの GPU メモリが「全体の37.5%」と「3GB」の大きいほう以上**
 *    （8GB の機械で 3,072MiB。常駐＋こちらの残りのモデルの差分で約2.2GB、
 *    読み込み中の 4,840MiB は越える）。**LM Studio へ送るときは見ない**——
 *    LM Studio が載せた分を差し引く手だてが無く、こちらが前に載せたモデルで
 *    毎回騒ぐことになる
 *
 * **VS Code にも Node にも依存させない。** コマンドの実行と通信は外から渡す。
 */

/** `nvidia-smi` に渡す引数。**出力の並びはこの順**（下の読み取りが頼っている） */
export const NVIDIA_SMI_ARGS: readonly string[] = [
  "--query-gpu=name,memory.used,memory.total,utilization.gpu",
  "--format=csv,noheader",
];

/** 使用率がこれ以上なら忙しい（%）。3回の中央値で見る */
export const GPU_BUSY_UTILIZATION_PERCENT = 50;

/**
 * ほかのアプリのメモリの下限（MiB）。小さい GPU で割合だけだと低すぎるため。
 *
 * **2GB では足りなかった。** Ollama の `/api/ps` の `size_vram` は、モデルを
 * 載せたときに実際に使う量より**約1.1GB少ない**（計算用の作業場の分が入らない。
 * `gemma4:e4b`・文脈16,384 で、一覧は 3,103MiB、実際の増え方は約4,230MiB）。
 * こちらが前の実行で載せたモデルが残っているだけで「ほかのアプリ」が
 * 常駐（約1.0GB）＋約1.1GB＝約2.2GBに見えるので、2GB の線では毎回騒ぐ。
 */
export const OTHER_VRAM_FLOOR_MIB = 3072;

/** ほかのアプリのメモリの割合の線（8GB の機械で 3,070MiB——下限とほぼ同じにした） */
export const OTHER_VRAM_RATIO = 0.375;

/** 使用率を測る回数と間隔 */
export const UTILIZATION_SAMPLES = 3;
export const UTILIZATION_SAMPLE_GAP_MS = 300;

/** 実行の途中で見直す間隔（ミリ秒）。**毎チャンクでは呼ばない** */
export const LOAD_CHECK_INTERVAL_MS = 5 * 60_000;

/** ［このまま送る］を選んだあと、同じ警告を出さない長さ（ミリ秒） */
export const LOAD_WARNING_SNOOZE_MS = 10 * 60_000;

/** ［待つ］を選んだとき、負荷を見直す間隔（ミリ秒） */
export const LOAD_WAIT_RECHECK_MS = 15_000;

/** GPU 1枚ぶんの読み取り */
export interface GpuSample {
  readonly name: string;
  readonly memoryUsedMiB: number;
  readonly memoryTotalMiB: number;
  readonly utilizationPercent: number;
}

/** 「5412 MiB」「14 %」「5412」から数だけを取る。読めなければ undefined */
function numberOf(field: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(?:MiB|%)?\s*$/.exec(field);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * `nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu
 * --format=csv,noheader` の出力を読む。1行が GPU 1枚。
 *
 * **読めない行は落とす**（`[N/A]`・`[Not Supported]` を返す機種がある）。
 * 名前に「,」が入っても崩れないよう、数の3つは後ろから取る。
 */
export function parseNvidiaSmi(stdout: string): GpuSample[] {
  const samples: GpuSample[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.split(",");
    if (fields.length < 4) continue;
    const utilization = numberOf(fields[fields.length - 1]);
    const total = numberOf(fields[fields.length - 2]);
    const used = numberOf(fields[fields.length - 3]);
    const name = fields.slice(0, fields.length - 3).join(",").trim();
    if (utilization === undefined || total === undefined || used === undefined) {
      continue;
    }
    if (total <= 0) continue;
    samples.push({
      name,
      memoryUsedMiB: used,
      memoryTotalMiB: total,
      utilizationPercent: utilization,
    });
  }
  return samples;
}

/** Ollama に読み込まれているモデル1つ */
export interface OllamaLoadedModel {
  readonly name: string;
  /** GPU に載せた量（バイト） */
  readonly sizeVramBytes: number;
}

/** `/api/ps` の応答を読む。形が違えば undefined */
export function parseOllamaPs(value: unknown): OllamaLoadedModel[] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const models = (value as { models?: unknown }).models;
  if (!Array.isArray(models)) return undefined;
  const loaded: OllamaLoadedModel[] = [];
  for (const item of models) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const name =
      typeof record.name === "string"
        ? record.name
        : typeof record.model === "string"
          ? record.model
          : "";
    const vram = typeof record.size_vram === "number" ? record.size_vram : 0;
    loaded.push({ name, sizeVramBytes: Math.max(0, vram) });
  }
  return loaded;
}

/** 見た結果 */
export interface ExternalLoadInput {
  /** 使用率を測った回ごとの GPU の読み取り（1回目が先頭）。NVIDIA でなければ空 */
  readonly gpuSamples: readonly (readonly GpuSample[])[];
  /** Ollama の読み込み。見られなかったら undefined */
  readonly ollamaModels: readonly OllamaLoadedModel[] | undefined;
  /** どちらへ送るか。LM Studio のときはメモリの線を使わない（上の断り書き） */
  readonly providerId: string;
}

export interface ExternalLoadJudgement {
  /** 管理の外の負荷とみなすか */
  readonly external: boolean;
  /** 作者へ見せる理由（「GPU の使用率が 97%」など）。external のときだけ中身がある */
  readonly reasons: readonly string[];
  /** ログへ残す1行（見た数字をそのまま） */
  readonly summary: string;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function gib(mib: number): string {
  return `${(mib / 1024).toFixed(1)}GB`;
}

/** ほかのアプリのメモリの線（MiB） */
export function otherVramLimitMiB(totalMiB: number): number {
  return Math.max(OTHER_VRAM_FLOOR_MIB, Math.round(totalMiB * OTHER_VRAM_RATIO));
}

/**
 * 管理の外の負荷とみなすかを決める。
 *
 * **札が空いていることは、呼ぶ側が確かめてから呼ぶ**（札の持ち主が送っている
 * 負荷は「管理の中」なので、ここへ来る前に順番待ちで扱っている）。
 */
export function judgeExternalLoad(input: ExternalLoadInput): ExternalLoadJudgement {
  const readings = input.gpuSamples.filter((samples) => samples.length > 0);
  const ollamaVramMiB =
    (input.ollamaModels ?? []).reduce((sum, model) => sum + model.sizeVramBytes, 0) /
    (1024 * 1024);
  const ollamaText =
    input.ollamaModels === undefined
      ? "Ollama の読み込みは不明"
      : input.ollamaModels.length === 0
        ? "Ollama の読み込みなし"
        : `Ollama の読み込み ${input.ollamaModels
            .map((model) => `${model.name}(${gib(model.sizeVramBytes / (1024 * 1024))})`)
            .join("・")}`;

  if (readings.length === 0) {
    // **NVIDIA でなければ、Ollama の情報だけでは決めない。** 読み込まれている
    // モデルは、前にこちらが載せたものがしばらく残っているのがふつうで、
    // 読み込み中のモデルは一覧に出ない（実測）。これだけで騒ぐと空振りが多い
    return {
      external: false,
      reasons: [],
      summary: `GPU の使用率は見られません（nvidia-smi なし）。${ollamaText}`,
    };
  }

  // 複数枚あるときは足し合わせる（どれに載るかはこちらから決められない）
  const last = readings[readings.length - 1];
  const usedMiB = last.reduce((sum, gpu) => sum + gpu.memoryUsedMiB, 0);
  const totalMiB = last.reduce((sum, gpu) => sum + gpu.memoryTotalMiB, 0);
  const utilizations = readings.map((samples) =>
    Math.max(...samples.map((gpu) => gpu.utilizationPercent))
  );
  const utilization = median(utilizations);
  const otherMiB = Math.max(0, usedMiB - ollamaVramMiB);
  const limitMiB = otherVramLimitMiB(totalMiB);

  const reasons: string[] = [];
  if (utilization >= GPU_BUSY_UTILIZATION_PERCENT) {
    reasons.push(`GPU の使用率が ${Math.round(utilization)}% です`);
  }
  const watchesMemory = input.providerId !== "lmstudio";
  if (watchesMemory && otherMiB >= limitMiB) {
    reasons.push(
      `ほかのアプリが GPU のメモリを ${gib(otherMiB)} 使っています（全体 ${gib(totalMiB)}）`
    );
  }

  const summary =
    `GPU 使用率 ${utilizations.map((value) => `${Math.round(value)}%`).join("/")}` +
    `（中央値 ${Math.round(utilization)}%、線 ${GPU_BUSY_UTILIZATION_PERCENT}%）、` +
    `メモリ ${Math.round(usedMiB)}/${Math.round(totalMiB)}MiB、` +
    `ほかのアプリ ${Math.round(otherMiB)}MiB（線 ${limitMiB}MiB` +
    `${watchesMemory ? "" : "、LM Studio へ送るので見ない"}）、${ollamaText}`;

  return { external: reasons.length > 0, reasons, summary };
}

/**
 * いつ負荷を見るか・警告をいつまで出さないか。
 *
 * **毎チャンクで nvidia-smi を呼ばない。** 札を新しく取ったとき（＝実行の始め）と、
 * 持ち続けているあいだは一定の間隔ごとだけにする。
 */
export class LoadCheckSchedule {
  private lastCheckedMs: number | undefined;
  private snoozeUntilMs: number | undefined;
  private snoozedForHold = false;

  /** いま見るべきか。`freshLease` は札を新しく取ったとき true */
  due(nowMs: number, freshLease: boolean): boolean {
    if (this.snoozedForHold) return false;
    if (this.snoozeUntilMs !== undefined && nowMs < this.snoozeUntilMs) return false;
    if (freshLease) return true;
    if (this.lastCheckedMs === undefined) return true;
    return nowMs - this.lastCheckedMs >= LOAD_CHECK_INTERVAL_MS;
  }

  checked(nowMs: number): void {
    this.lastCheckedMs = nowMs;
  }

  /**
   * ［このまま送る］を選んだ。**その実行のあいだ（札を持ち続けているあいだ）と、
   * 少なくとも数分は**同じ警告を出さない（しつこくしない）。
   */
  snooze(nowMs: number): void {
    this.snoozeUntilMs = nowMs + LOAD_WARNING_SNOOZE_MS;
    this.snoozedForHold = true;
  }

  /** 札を離した。「その実行のあいだ」の分だけを解く（数分の分は残る） */
  leaseDropped(): void {
    this.snoozedForHold = false;
  }
}

/** 負荷を見る部品（外から渡す） */
export interface LoadProbeTools {
  /** `nvidia-smi` を走らせて標準出力を返す。**無ければ undefined**（NVIDIA でない） */
  readonly runNvidiaSmi: () => Promise<string | undefined>;
  /** Ollama の `/api/ps` を読む。読めなければ undefined */
  readonly readOllamaPs: () => Promise<readonly OllamaLoadedModel[] | undefined>;
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * 実際に測って決める。使用率を3回（あいだ0.3秒）と、Ollama の読み込みを1回。
 *
 * `nvidia-smi` が無ければ1回で諦め、以後の回も省く判断は呼ぶ側に任せる
 * （undefined を返した回数を覚えるのは、プロセスの寿命を知っている側）。
 */
export async function probeExternalLoad(
  providerId: string,
  tools: LoadProbeTools
): Promise<ExternalLoadJudgement & { nvidiaSmiFound: boolean }> {
  const ollamaModelsPromise = tools.readOllamaPs().catch(() => undefined);
  const gpuSamples: GpuSample[][] = [];
  let nvidiaSmiFound = true;
  for (let index = 0; index < UTILIZATION_SAMPLES; index += 1) {
    if (index > 0) await tools.sleep(UTILIZATION_SAMPLE_GAP_MS);
    const stdout = await tools.runNvidiaSmi();
    if (stdout === undefined) {
      nvidiaSmiFound = false;
      break;
    }
    gpuSamples.push(parseNvidiaSmi(stdout));
  }
  const ollamaModels = await ollamaModelsPromise;
  return {
    ...judgeExternalLoad({ gpuSamples, ollamaModels, providerId }),
    nvidiaSmiFound,
  };
}

/**
 * Ollama の `/api/ps` を読む。2秒で諦める。
 *
 * **通信は外から渡す**（宛先の組み立ても呼ぶ側——どの口で投げるかを
 * `fetchDispatcherNet.test.ts` が字面で見るので、`/api/ps` を呼ぶ側に書かせる）。
 */
export async function readOllamaPsWith(
  request: (signal: AbortSignal) => Promise<{
    ok: boolean;
    json(): Promise<unknown>;
  }>,
  timeoutMs = 2000
): Promise<OllamaLoadedModel[] | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await request(controller.signal);
    if (!response.ok) return undefined;
    return parseOllamaPs(await response.json());
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** 警告の本文（拡張機能の札と MCP の1行で同じ言い方にする） */
export function externalLoadMessage(judgement: ExternalLoadJudgement): string {
  return (
    `${judgement.reasons.join("。")}。` +
    "この拡張機能のほかに、GPU を使っているアプリがあるようです" +
    "（ゲーム・動画・LM Studio・ほかの Ollama の使い手など）。"
  );
}
