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
 *   こちらが載せたモデルが、しばらく残っているのはふつうのことだから）。
 *   **GPU に入りきらず CPU と分けて載せたモデルがあれば、メモリの線は見ない**
 *   （空いたメモリをそのモデルが埋め、申告も当てにならない。`isSplitAcrossCpu`）
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
 * 1. **使用率の中央値が 50% 以上**（3回測る。1回だけの跳ねで騒がない）。
 *    **GPU と CPU に分けて載せたモデルがあるときは 25% 以上**
 *    （`SPLIT_GPU_BUSY_UTILIZATION_PERCENT`。2026-09-26 深夜の裁定）
 * 2. **ほかのアプリの GPU メモリが「全体の37.5%」と「3GB」の大きいほう以上**
 *    （8GB の機械で 3,072MiB。常駐＋こちらの残りのモデルの差分で約2.2GB、
 *    読み込み中の 4,840MiB は越える）。**LM Studio へ送るときは見ない**——
 *    LM Studio が載せた分を差し引く手だてが無く、こちらが前に載せたモデルで
 *    毎回騒ぐことになる
 *
 * ただし**管理下の誰かが送り終えて間もない（`MANAGED_SEND_SETTLE_MS`）ときは、
 * 1の線を見ない**——直前の生成の名残で使用率が高く出るため（2026-09-25 追記）。
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
 * **GPU と CPU に分けて載せたモデルがあるとき**の使用率の線（%）。
 * 作者の裁定（2026-09-26 深夜）「25〜30%に下げる」から、実測で25%に決めた。
 *
 * ## なぜ下げるか
 *
 * 分けて載せたモデルが生成しているあいだ、GPU は CPU の計算を待って遊ぶ。
 * ほかの使い手の 26b の生成は**中央値 34%・38%・53%**にしかならず
 * （2026-09-25 の実測、RTX 4060 Ti・gemma4:26b）、50%の線では3回のうち2回を
 * 見逃していた。しかも分けて載せたときはメモリの線を見ない（`isSplitAcrossCpu`）
 * ので、残る手がかりは使用率だけである。
 *
 * ## 25%にした理由（同じ日の実測の記録から）
 *
 * - 26b が載っているだけ（待機）：中央値 0〜8%（1回だけの跳ねは 12%）——7回
 * - 読み込みの途中：中央値 9〜20%（1回だけの跳ねは 29%）。**このとき `/api/ps` は
 *   空なので、そもそもこの線は使われない**が、読み込みと重なっても騒がない高さに置く
 * - ほかの使い手の 26b の生成：中央値 34〜53%（1回ずつの最小も 34%）——3回
 *
 * 30%は生成の最小 34%に近すぎる——生成の測定は3回しか無く、文脈が長くなれば
 * CPU の分が増えて使用率はさらに下がりうる。待機と読み込みの最大（20%）からも
 * 生成の最小（34%）からも離れた25%にした。**見逃しのほうを重く見た**——誤った
 * 警告は［このまま送る］で10分黙らせられるが、見逃すと2人が同じ GPU を
 * 取り合って、どちらの実行も遅くなる。
 */
export const SPLIT_GPU_BUSY_UTILIZATION_PERCENT = 25;

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

/**
 * 管理下の誰か（この拡張機能・別の窓・MCP）が手元のAIへ送り終えてから、
 * **使用率の線を見ない長さ**（ミリ秒）。メモリの線は見る。
 *
 * ## なぜ要るか
 *
 * 札が空いた直後に測ると、**直前の生成の名残**で使用率が高く出る。実機（0.87.3）
 * では MCP の一括処理の2話目の頭で 98%/98%/0% を読み、「管理外の負荷の疑い」を
 * 添えた。0.87.3 で単発が一括処理の合間に入れるようになり、窓でモーダルの警告が
 * 出る場面が増えうる（作者の判断 2026-09-25「直す」）。
 *
 * ## 3秒にした理由（2026-09-25 に作者の機械で実測。RTX 4060 Ti・gemma4:e4b）
 *
 * nvidia-smi を 0.1秒ごとに流しながら、生成を10回（短い文・文脈4,096 を6回、
 * 原稿6,000字・文脈16,384 を4回）投げ、応答が返った時刻からの使用率を見た。
 *
 * - 名残が 50% 以上だった最後の読み取りは、応答の 0.08〜0.53秒後
 *   （この GPU は使用率を約0.5秒ごとにしか更新せず、直前の値を持ち越す）
 * - 製品と同じ測り方（0.3秒おきに3回・中央値）を当てはめると、応答の直後に
 *   測り始めたときだけ 80〜97% と出て、**0.5秒後以降に測り始めれば10回とも 0%**
 *
 * 実測の最長 0.53秒に対して、NVIDIA の説明では使用率の標本の幅が機種により
 * 最長1秒あること、測るのに 0.6秒かかること、応答から札を離すまでの遅れを見込み、
 * 余裕を取って3秒にした。**見逃す側の損は小さい**——送り終えて3秒のうちに
 * ほかのアプリが GPU を使い始めた場合だけで、メモリの線と、実行の途中の
 * 見直し（5分ごと）は効いたままである。
 */
export const MANAGED_SEND_SETTLE_MS = 3000;

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
  /**
   * 載せた量の全体（バイト。`/api/ps` の `size`）。**分けて載せたかの判定にだけ使う**
   * ——値そのものは当てにならない（gemma4:26b で 1.2GB と答えた。下の `isSplitAcrossCpu`）。
   * 応答に無ければ省く
   */
  readonly sizeBytes?: number;
  /** GPU に載せた量（バイト） */
  readonly sizeVramBytes: number;
}

/**
 * GPU に入りきらず、CPU と分けて載せたモデルか（`size` が `size_vram` より大きい）。
 *
 * **分けて載せたモデルは、読み込むときに空いている GPU のメモリをほぼ埋める**
 * ので、そのあいだは GPU の使用量から「ほかのアプリ」の分を読めない。しかも
 * 申告の量が当てにならない（2026-09-25 実測：gemma4:26b は GPU を約6.5GB 使って
 * いるのに、`size` 1.2GB・`size_vram` 0.9GB と答えた）。`size` が無い応答では
 * 決められないので、分けていないものとして扱う（今までどおり）。
 */
export function isSplitAcrossCpu(model: OllamaLoadedModel): boolean {
  return model.sizeBytes !== undefined && model.sizeBytes > model.sizeVramBytes;
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
    const size =
      typeof record.size === "number" && Number.isFinite(record.size)
        ? Math.max(0, record.size)
        : undefined;
    loaded.push({
      name,
      ...(size !== undefined ? { sizeBytes: size } : {}),
      sizeVramBytes: Math.max(0, vram),
    });
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
  /**
   * 管理下の誰かが最後に送り終えてからの経過（ミリ秒）。**分からなければ undefined**
   * （台帳が読めない・古い版の窓しか送っていない）——今までどおり使用率も見る。
   * `MANAGED_SEND_SETTLE_MS` 未満なら、使用率の線を見ない（直前の生成の名残）
   */
  readonly sinceManagedSendMs?: number;
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
  // **Ollama が GPU と CPU に分けて載せたモデルがあれば、メモリの線を見ない**
  // （2026-09-25 午後。`isSplitAcrossCpu`）。空いたメモリをそのモデルが埋めて
  // いるので、使用量はほかのアプリの量を表さず、申告も当てにならない。
  // 26b を使うたびに「ほかのアプリが 6.7GB」と読んで警告していた
  const splitModels = (input.ollamaModels ?? []).filter(isSplitAcrossCpu);
  // **そのときは使用率の線を下げる**（作者の裁定 2026-09-26 深夜）。分けて
  // 載せたモデルの生成は GPU を半分ほどしか使わず、50%では見逃す。
  // メモリの線を見ないぶん、使用率がただ1つの手がかりになる
  const busyLine =
    splitModels.length > 0
      ? SPLIT_GPU_BUSY_UTILIZATION_PERCENT
      : GPU_BUSY_UTILIZATION_PERCENT;
  // **直前の生成の名残は見ない。** メモリの線は Ollama の申告分を差し引いて
  // いるので、直後でも今までどおり見てよい（名残で膨らむのは使用率だけ）。
  // 線を下げたときも同じ——名残はむしろ下げた線のほうを越えやすい
  const settling =
    input.sinceManagedSendMs !== undefined &&
    input.sinceManagedSendMs < MANAGED_SEND_SETTLE_MS;
  if (!settling && utilization >= busyLine) {
    reasons.push(`GPU の使用率が ${Math.round(utilization)}% です`);
  }
  const isLmStudio = input.providerId === "lmstudio";
  const watchesMemory = !isLmStudio && splitModels.length === 0;
  if (watchesMemory && otherMiB >= limitMiB) {
    reasons.push(
      `ほかのアプリが GPU のメモリを ${gib(otherMiB)} 使っています（全体 ${gib(totalMiB)}）`
    );
  }

  const summary =
    `GPU 使用率 ${utilizations.map((value) => `${Math.round(value)}%`).join("/")}` +
    `（中央値 ${Math.round(utilization)}%、線 ${busyLine}%` +
    `${splitModels.length > 0 ? "——GPU と CPU に分けて載せているので下げた" : ""}` +
    `${
      settling
        ? `——直前の送信の終わりから${((input.sinceManagedSendMs ?? 0) / 1000).toFixed(1)}秒なので、` +
          "名残とみなして使用率の線は見ない"
        : ""
    }）、` +
    `メモリ ${Math.round(usedMiB)}/${Math.round(totalMiB)}MiB、` +
    `ほかのアプリ ${Math.round(otherMiB)}MiB（線 ${limitMiB}MiB` +
    `${
      isLmStudio
        ? "、LM Studio へ送るので見ない"
        : splitModels.length > 0
          ? `、${splitModels.map((model) => model.name).join("・")} を Ollama が GPU と CPU に分けて` +
            "載せているので見ない"
          : ""
    }）、${ollamaText}`;

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
  /**
   * 管理下の誰かが最後に送り終えた時刻（ミリ秒）。台帳（`local-ai/last-send.json`）
   * から読む。**無い・読めない・失敗したら undefined**（今までどおり使用率も見る）
   */
  readonly lastManagedSendEndedMs?: () => Promise<number | undefined>;
  /** 時計（試験用。省けば `Date.now`） */
  readonly now?: () => number;
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
  // **測り始める前に**経過を出す（測るあいだの0.6秒を足さない——名残を
  // 読むのは1回目と2回目なので、始めの時点で決めるほうが取りこぼさない）
  const sinceManagedSendMs = await readSinceManagedSend(tools);
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
    ...judgeExternalLoad({
      gpuSamples,
      ollamaModels,
      providerId,
      ...(sinceManagedSendMs !== undefined ? { sinceManagedSendMs } : {}),
    }),
    nvidiaSmiFound,
  };
}

/** 最後に管理下の送信が終わってからの経過。分からなければ undefined */
async function readSinceManagedSend(tools: LoadProbeTools): Promise<number | undefined> {
  if (!tools.lastManagedSendEndedMs) return undefined;
  let ended: number | undefined;
  try {
    ended = await tools.lastManagedSendEndedMs();
  } catch {
    // 台帳が読めない。**今までどおり測る**（黙って見逃す側へ倒さない）
    return undefined;
  }
  if (ended === undefined || !Number.isFinite(ended)) return undefined;
  // 時計の細かさのずれで「未来に送り終えた」と読めたら、終えた直後として扱う
  return Math.max(0, (tools.now ?? Date.now)() - ended);
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
