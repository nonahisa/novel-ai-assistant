import * as vscode from "vscode";
import { logLine } from "./logger";

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
  /**
   * 1回の応答で書けた、実測の出力トークン数（設計書6.65.14の1）。
   *
   * **読める長さ（`measuredChars`）と違い、確認なしで自動的に保存される**
   * ——まとめ送信の上限を絞るためだけに使う参考値で、`contextWindow` や
   * `timeoutSeconds` のように呼び出しの挙動そのものを変える設定ではない。
   * 台帳へ繋いだ理由は設計書6.65.14（作者の指摘「設定に入れないのは
   * なぜでしょうか？　チューニングの意味がないように思う」）。
   */
  readonly measuredOutputTokens?: number;
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

/**
 * これを下回るコンテキスト長は、台帳に入っていても使わない。
 *
 * **`novelai.modelTuning` は `object` の設定なので、`minimum` が効かない**
 * （プロバイダごとの `contextWindow` には効いている）。手で `5` と書けば、
 * 送る前から失敗が決まった値でその機能が丸ごと使えなくなる。
 * さくら・ChatGPTの設定が持っている下限と同じ値にしてある。
 */
const MIN_CONTEXT_WINDOW = 1024;

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
    const measuredOutputTokens = positiveNumber(entry.measuredOutputTokens);
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
      ...(measuredOutputTokens !== undefined ? { measuredOutputTokens } : {}),
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

/**
 * 同じ注意を何度も書かないための覚え。
 *
 * 台帳は**呼び出しのたびに読む**ので、挟んだことを毎回書くとログが
 * その1行で埋まり、ほかの失敗が見えなくなる。
 */
const reportedOnce = new Set<string>();

function noteOnce(message: string): void {
  if (reportedOnce.has(message)) return;
  reportedOnce.add(message);
  logLine(message);
}

/**
 * 測って分かった実効のコンテキスト長（トークン）。無ければ undefined。
 *
 * **小さすぎる値は使わない。** 設定の型が `object` なので、VS Code側の
 * `minimum` が効かない（上の `MIN_CONTEXT_WINDOW` に理由）。無視したときは
 * 呼び出し側が従来の設定へ落ちる。
 */
export function tunedContextWindow(
  providerId: string,
  model: string
): number | undefined {
  const tuned = modelTuning(providerId, model)?.contextWindow;
  if (tuned === undefined) return undefined;
  if (tuned < MIN_CONTEXT_WINDOW) {
    // **黙って別の値を使わない。** 作者が書いた値が効いていないことは、
    // 「入力が切り捨てられた」形でしか現れないので、必ず言う
    noteOnce(
      `AIチューニング：${modelTuningKey(providerId, model)} のコンテキスト長 ` +
        `${tuned} は小さすぎるため使いません（${MIN_CONTEXT_WINDOW} 以上にしてください）。` +
        "設定のほうの値を使います。"
    );
    return undefined;
  }
  return tuned;
}

/**
 * 測って分かった待ち時間（秒）。無ければ undefined。
 *
 * **上限で挟む。** 手で `100000` と書くと、1回の呼び出しが27時間待つ。
 * 上限は書き込み側（`recommendTimeoutSeconds`）でしか守られていないので、
 * 読む側でも同じ線を引く。
 */
export function tunedTimeoutSeconds(
  providerId: string,
  model: string
): number | undefined {
  const tuned = modelTuning(providerId, model)?.timeoutSeconds;
  if (tuned === undefined) return undefined;
  if (tuned > MAX_TIMEOUT_SECONDS) {
    noteOnce(
      `AIチューニング：${modelTuningKey(providerId, model)} の待ち時間 ` +
        `${tuned} 秒は長すぎるため、${MAX_TIMEOUT_SECONDS} 秒までに抑えます。`
    );
    return MAX_TIMEOUT_SECONDS;
  }
  return tuned;
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

/**
 * コンテキスト長の決め方。プロバイダごとに違うのは、この3つだけである。
 *
 * `resolveContextWindow` へ渡す。**値をここに書かない**——既定も設定名も
 * プロバイダ側の事情なので、持つのはプロバイダのファイルである。
 */
export interface ContextWindowSource {
  /** プロバイダごとの設定名（`novelai.` を除く） */
  readonly settingKey: string;
  /** 設定も台帳も無い／使えないときの既定 */
  readonly fallback: number;
  /**
   * これ未満の設定値は使わない（`package.json` の `minimum` と揃える）。
   * **0なら「正の数ならなんでも」**——LM Studioは読み込んだ長さに
   * 合わせる予備なので、小さい値も作者の意図として尊重する。
   */
  readonly minimum: number;
}

/**
 * そのモデルが読める長さ（トークン）。
 * **台帳（AIチューニング）→ プロバイダごとの設定 → 既定** の順で決める。
 *
 * ## 台帳を見るのは、申告しないプロバイダだけ
 *
 * ChatGPT・LM Studio・さくらのAIは、モデル一覧APIがコンテキスト長を
 * 返さない。だから「測って台帳へ書く」（設計書6.49）が要る。
 *
 * **Ollama・Gemini・ClaudeはAPIが申告するので、台帳を見ない。**
 * 申告のほうが正しく、モデルが差し替わればその場で新しい値になる。
 * ここへ台帳を挟むと、**古い実測が正しい申告を静かに上書きする**
 * ——モデルを入れ替えたのに前のモデルの長さで分割し続ける、という
 * 気づきようのない壊れ方になる。台帳は「申告できないプロバイダの
 * 実測の置き場」であって、全プロバイダ共通の上書き機構ではない。
 *
 * ## 3社が同じ順番を別々に書いていた
 *
 * 読み順・下限・落とし先が3か所に写されており、片方だけ直すと
 * 「ChatGPTでは効くのにさくらでは効かない」が静かに生まれる
 * （待ち時間の `resolveTimeoutSeconds` と同じ理由。設計書6.77の第2段）。
 */
export function resolveContextWindow(
  providerId: string,
  model: string,
  source: ContextWindowSource
): number {
  const tuned = tunedContextWindow(providerId, model);
  if (tuned !== undefined) return tuned;
  const configured = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<number>(source.settingKey, source.fallback);
  return Number.isFinite(configured) &&
    configured > 0 &&
    configured >= source.minimum
    ? configured
    : source.fallback;
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
 * そのモデルぶんの調整値を、**指定した欄だけ差し替えて**書く。
 *
 * **土台にするのは生の設定値である。** `parseModelTuning` を通したものを
 * 書き戻すと、こちらが解釈できなかった欄が黙って消える。作者が
 * `{"contextWindow": "131072", "memo": "26Bはこれ"}` と手で書いていたら、
 * 測って戻すだけでその2つが消えることになる。**読めない欄・知らない欄は
 * そのまま残す**——こちらが読めないだけで、作者にとっては意味がある。
 *
 * ほかのモデルの項目も、当然ながら触らない。
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
  const table = asRecord(configuration.get<unknown>(TUNING_SETTING));

  const key = modelTuningKey(providerId, model);
  const entry = asRecord(table[key]);
  for (const [name, value] of Object.entries(tuning)) {
    if (value === undefined) delete entry[name];
    else entry[name] = value;
  }
  if (Object.keys(entry).length === 0) {
    delete table[key];
  } else {
    table[key] = entry;
  }

  // **読まれる場所へ書く。** `get` は作品フォルダ（ワークスペース）の値を
  // 優先するのに、`update` を必ず機械全体へ向けると、書いても読まれない。
  // 作者からは「反映を押したのに何も変わらない」としか見えず、
  // 無言で効かない状態になる。
  //
  // 作品フォルダ側に値が無いときは、これまでどおり機械全体へ書く——
  // 読み込み方も契約も、作品ではなく環境の側の事情で決まる
  const hasWorkspaceValue =
    configuration.inspect(TUNING_SETTING)?.workspaceValue !== undefined;
  await configuration.update(
    TUNING_SETTING,
    table,
    hasWorkspaceValue
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global
  );
}

/** 素の物なら浅い写しを、そうでなければ空の物を返す（元は書き換えない） */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}
