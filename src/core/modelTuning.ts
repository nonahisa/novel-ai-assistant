import * as vscode from "vscode";

/**
 * AIチューニング——**モデルごと**の上限と待ち時間の台帳（設計書6.49）。
 *
 * 「AIが実際に読める長さを測る」は、測った値を `sakura.contextWindow` のような
 * **プロバイダ単位の設定1つ**へ書いていた。同じさくらのAIでも
 * `gpt-oss-120b` と 31B のモデルでは読める長さも要る待ち時間も違うので、
 * **モデルを切り替えた瞬間に、別のモデルで測った値が使われてしまう。**
 *
 * そこで鍵を `プロバイダID/モデル名` にした台帳を持つ。作者が
 * 「モデルを変更したら切り替わる」ことを求めたが、**切り替えの仕組みは要らない**
 * ——引くときの鍵にモデル名が入っているので、モデルを変えれば自然に別の値を引く。
 *
 * **VS Codeの設定（`novelai.modelTuning`）に置く。** `globalState` だと
 * 作者からは存在すら見えず、おかしくなっても消せない。設定なら一覧に出て、
 * 手で直せて、要らなければ丸ごと消せば測る前の状態へ戻る。
 */

/** 1モデルぶんの調整値。**どれも省略できる**（測れたものだけ入る） */
export interface ModelTuning {
  /** 実効のコンテキスト長（トークン）。測って分かった値 */
  readonly contextWindow?: number;
  /** 1回の呼び出しで待つ秒数 */
  readonly timeoutSeconds?: number;
  /** 先頭と末尾の合言葉が両方返った、最大の字数 */
  readonly measuredChars?: number;
  /** 測った時刻（ISO 8601）。古い測定だと分かるように残す */
  readonly measuredAt?: string;
}

/**
 * 待ち時間の下限。**いまの既定（180秒）を下回らせない。**
 *
 * 測定で使う合言葉の出力は極端に短いので、そのまま採ると
 * 「30秒で足りる」という結論になりかねない。実際の機能（誤字脱字の
 * 指摘一覧など）はもっと長い出力を返すので、測定が速くても縮めない。
 */
export const MIN_TIMEOUT_SECONDS = 180;

/**
 * 待ち時間の上限。これ以上待たせるくらいなら、モデルかチャンクの
 * 大きさを見直すほうが作者のためになる。
 */
export const MAX_TIMEOUT_SECONDS = 600;

/** 作者が設定画面で読みやすいように、この刻みへ丸める */
const TIMEOUT_STEP_SECONDS = 30;

/**
 * 測った応答時間に掛ける倍率。
 *
 * **測定の出力は合言葉2つだけで、極端に短い。** 生成にかかる時間の
 * 大半は出力側なので、入力の処理時間しか測っていないこの数字を
 * そのまま使うと、実際の機能では必ず足りない。
 */
const RESPONSE_TIME_MARGIN = 3;

/** 台帳を引くときの鍵。**モデル名まで含めるのが要点** */
export function modelTuningKey(providerId: string, model: string): string {
  return `${providerId}/${model}`;
}

/**
 * 設定に入っている台帳を読む。
 *
 * **壊れていても投げない。** ここは作者が手で編集できる設定であり、
 * 書き間違いのせいでAIが呼べなくなるほうが困る。読めない項目は
 * その項目だけ捨てて、ほかは読む（`workRegistry.ts` の
 * `parseAnnounceConfig` と同じ方針）。
 *
 * **欄の単位で捨てる。** 時刻の書き間違いくらいで、測り直さないと
 * 戻らない `contextWindow` まで道連れにしない。使える欄が1つも
 * 残らなかったときだけ、その項目ごと落とす。
 */
export function parseModelTuning(raw: unknown): Map<string, ModelTuning> {
  const result = new Map<string, ModelTuning>();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return result;
  }

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.trim().length === 0) continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const entry = value as Record<string, unknown>;
    const contextWindow = positiveNumber(entry.contextWindow);
    const timeoutSeconds = positiveNumber(entry.timeoutSeconds);
    const measuredChars = positiveNumber(entry.measuredChars);
    const measuredAt =
      typeof entry.measuredAt === "string" && entry.measuredAt.trim().length > 0
        ? entry.measuredAt
        : undefined;

    const tuning: ModelTuning = {
      // **持っている欄だけを置く。** `undefined` を常に置くと、書き戻した
      // ときに設定へ空の欄が現れて、作者には壊れて見える
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
      ...(measuredChars !== undefined ? { measuredChars } : {}),
      ...(measuredAt !== undefined ? { measuredAt } : {}),
    };
    // 何も読めなかった項目は、持っていても引く値が無い
    if (Object.keys(tuning).length === 0) continue;
    result.set(key, tuning);
  }

  return result;
}

/**
 * 正の有限数のときだけ返す。
 *
 * 0や負や `"131072"` のような文字列は、**読まずに捨てる。** 半端に
 * 読むと「上限0トークン」のような、送る前から失敗が決まった値になる。
 */
function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/**
 * 測った応答時間から、設定してよい待ち時間を決める。
 *
 * `Math.min(600, Math.max(180, Math.ceil(秒 * 3 / 30) * 30))`。
 * 掛ける3・下限180・上限600・30秒刻みの理由は、それぞれ上の定数に書いた。
 */
export function recommendTimeoutSeconds(longestResponseSeconds: number): number {
  if (
    !Number.isFinite(longestResponseSeconds) ||
    longestResponseSeconds <= 0
  ) {
    // 測れていないなら、いまの既定を動かす根拠が無い
    return MIN_TIMEOUT_SECONDS;
  }
  const raw = longestResponseSeconds * RESPONSE_TIME_MARGIN;
  const rounded = Math.ceil(raw / TIMEOUT_STEP_SECONDS) * TIMEOUT_STEP_SECONDS;
  return Math.min(MAX_TIMEOUT_SECONDS, Math.max(MIN_TIMEOUT_SECONDS, rounded));
}

const CONFIG_SECTION = "novelai";
const TUNING_SETTING = "modelTuning";

/** プロバイダごとの待ち時間の設定名。6つとも同じ形をしている */
export function timeoutSettingKey(providerId: string): string {
  return `${providerId}.timeoutSeconds`;
}

function readTuningTable(): Map<string, ModelTuning> {
  return parseModelTuning(
    vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>(TUNING_SETTING)
  );
}

/** そのモデルの調整値。**測っていなければ undefined**（従来の設定へ落とす） */
export function modelTuning(
  providerId: string,
  model: string
): ModelTuning | undefined {
  return readTuningTable().get(modelTuningKey(providerId, model));
}

/** 測って分かった実効のコンテキスト長（トークン）。無ければ undefined */
export function tunedContextWindow(
  providerId: string,
  model: string
): number | undefined {
  return modelTuning(providerId, model)?.contextWindow;
}

/** 測って分かった待ち時間（秒）。無ければ undefined */
export function tunedTimeoutSeconds(
  providerId: string,
  model: string
): number | undefined {
  return modelTuning(providerId, model)?.timeoutSeconds;
}

/**
 * そのモデルへの1回の呼び出しで待つ秒数。
 *
 * **順番を1か所で決める**——台帳（AIチューニング）→ プロバイダごとの設定 →
 * 既定。6つのプロバイダがそれぞれ順番を書いていると、片方だけ直したときに
 * 「Ollamaでは効くのにClaudeでは効かない」という食い違いが静かに生まれる。
 *
 * `fallbackSeconds` は**そのプロバイダのpackage.json上の既定**を渡す
 * （Claudeだけ300秒で、ほかは180秒）。設定が宣言されている限りVS Codeが
 * その既定を返すので実行時には使われないが、渡す値を変えると
 * 試験の中だけ挙動が変わってしまう。
 */
export function resolveTimeoutSeconds(
  providerId: string,
  model: string,
  fallbackSeconds: number = MIN_TIMEOUT_SECONDS
): number {
  const tuned = tunedTimeoutSeconds(providerId, model);
  if (tuned !== undefined) return tuned;
  const configured = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<number>(timeoutSettingKey(providerId), fallbackSeconds);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : fallbackSeconds;
}

/** `resolveTimeoutSeconds` のミリ秒版。プロバイダはこちらを使う */
export function resolveTimeoutMs(
  providerId: string,
  model: string,
  fallbackSeconds: number = MIN_TIMEOUT_SECONDS
): number {
  return resolveTimeoutSeconds(providerId, model, fallbackSeconds) * 1000;
}

/**
 * そのモデルぶんの調整値を書く。
 *
 * **ほかのモデルの項目を消さない。** 読んだものへ、その鍵だけ差し替えて
 * 書き戻す。**読めなかった項目も残す**——こちらが読めないだけで作者が
 * 手で書いたものかもしれず、黙って消してよいものではない。
 *
 * **欄を消したいときは `undefined` を渡す。** 測り直しのために一時的に
 * 延ばした待ち時間を元へ戻すとき、「元は欄が無かった」を表す手段が要る
 * （`{ timeoutSeconds: undefined }` を渡せば、その欄だけ消える）。
 * 残る欄が1つも無くなったら、その鍵ごと落とす——中身の無い鍵が設定に
 * 並ぶと、作者には「測ったのに何も入っていない」と読める。
 */
export async function saveModelTuning(
  providerId: string,
  model: string,
  tuning: ModelTuning
): Promise<void> {
  const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const raw = configuration.get<unknown>(TUNING_SETTING);
  const table: Record<string, unknown> =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};

  const key = modelTuningKey(providerId, model);
  const entry = Object.fromEntries(
    Object.entries(tuning).filter(([, value]) => value !== undefined)
  );
  if (Object.keys(entry).length === 0) {
    delete table[key];
  } else {
    table[key] = entry;
  }

  // 機械全体の設定にする。読み込み方も契約も、作品ではなく環境の側の事情で決まる
  await configuration.update(TUNING_SETTING, table, true);
}
