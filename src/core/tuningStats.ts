import type { ModelTuning } from "./modelTuning";

/**
 * AIチューニングの実測を、1枚の表にして見せる（作者の要望、2026-09-06
 * 「速度が一番早いモデルがわかる統計の一覧が出ると嬉しい」）。
 *
 * 台帳（`core/modelTuning.ts`）はモデルごとに測った値を持っているが、
 * **読むには設定のJSONを開くしかなかった。** どのモデルがいちばん速いかは、
 * 鍵（`プロバイダ/モデル`）を目で追って数字を見比べる作業になる。
 *
 * ここは**組み立てだけ**を持つ純粋関数の集まりで、VS Codeには触らない
 * （台帳を読んで画面へ出すのは `features/showTuningStats.ts`）。表の中身は
 * 作者が手で編集できる設定から来るので、**欠けていることを前提に組む**
 * ——測っていない欄は「—」で出し、0や当て推量で埋めない。
 */

/** 画面に出すときの名前。タブの見出しとファイル名の前置きになる */
export const TUNING_STATS_TITLE = "AIチューニングの実測一覧";

/** 測っていない項目の見せ方。**0とは違う**ので、数字を書かない */
const UNKNOWN = "—";

/** 一覧の1行ぶん */
export interface TuningStatsEntry {
  /** 画面に出すAIの名前（プロバイダの表示名。分からなければIDのまま） */
  readonly providerLabel: string;
  /** モデル名（台帳の鍵の後半） */
  readonly model: string;
  readonly tuning: ModelTuning;
}

/**
 * 台帳の鍵（`プロバイダID/モデル名`）を割って、一覧の行にする。
 *
 * **割るのは最初の `/` だけ。** Ollamaは `hf.co/作者/モデル:q4` のような
 * 名前を扱うので、全部で割るとモデル名が切れて別物になる。
 *
 * @param providerLabel プロバイダIDを表示名へ直す手。表示名を知っているのは
 *   `AIRegistry` だけなので、こちらは受け取るだけにする（この層から
 *   VS Codeへは触らない）
 */
export function tuningStatsEntries(
  table: ReadonlyMap<string, ModelTuning>,
  providerLabel: (providerId: string) => string
): TuningStatsEntry[] {
  return [...table.entries()].map(([key, tuning]) => {
    const separator = key.indexOf("/");
    // **割れない鍵も落とさない。** 作者が手で書いた覚え書きが混ざって
    // いても、一覧そのものが消えるよりは、そのまま見せるほうがよい
    const providerId = separator < 0 ? key : key.slice(0, separator);
    const model = separator < 0 ? "" : key.slice(separator + 1);
    return { providerLabel: providerLabel(providerId), model, tuning };
  });
}

/**
 * 出力の実測の速さ（トークン/秒。小数1桁）。
 *
 * **測れないものは返さない。** 所要0ミリ秒は「無限に速い」ではなく
 * 「時間を測れていない」であり、そこで巨大な数を返すと、その行が
 * 一覧の先頭に「最速」として居座る。
 */
export function outputTokensPerSecond(
  tokens: number | undefined,
  elapsedMs: number
): number | undefined {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) {
    return undefined;
  }
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return undefined;
  return Math.round((tokens / (elapsedMs / 1000)) * 10) / 10;
}

/**
 * 実測の一覧（Markdownの表）。
 *
 * 並びは**速い順**で、速度の分かっていない行は末尾へ回す——速さを見に
 * 来た人に、まず速さの分かっている行を見せる。
 */
export function buildTuningStatsMarkdown(
  entries: readonly TuningStatsEntry[]
): string {
  const lines: string[] = [`# ${TUNING_STATS_TITLE}`, ""];

  if (entries.length === 0) {
    // **空の表を出さない。** 見出しだけの表は「壊れている」と読める。
    // 次にすること（測る）を書く
    lines.push("まだ測っていません。「AIチューニング」を実行してください。");
    return lines.join("\n") + "\n";
  }

  lines.push(
    "速度は出力の実測（トークン/秒）です。同じモデルでも機械の負荷で変わるので目安です。",
    "",
    "| AI | モデル | 出力速度（トークン/秒） | 最初の応答（秒） | " +
      "文脈の実効長（トークン） | 読める長さ（字） | 書ける長さ（トークン） | 測った日時 |",
    "|---|---|---|---|---|---|---|---|"
  );

  const sorted = sortBySpeed(entries);
  // 印は1行だけ。同じ速さが並んだときは、先に来た行に付ける
  const fastest = sorted[0]?.tuning.outputTokensPerSecond;

  sorted.forEach((entry, index) => {
    lines.push(
      "| " +
        [
          escapeCell(entry.providerLabel),
          escapeCell(entry.model),
          speedCell(
            entry.tuning.outputTokensPerSecond,
            index === 0 && fastest !== undefined
          ),
          decimalCell(entry.tuning.firstTokenSeconds),
          countCell(entry.tuning.contextWindow),
          countCell(entry.tuning.measuredChars),
          outputCell(entry.tuning),
          formatMeasuredAt(entry.tuning.measuredAt),
        ].join(" | ") +
        " |"
    );
  });

  return lines.join("\n") + "\n";
}

/**
 * 速い順。**速度の無い行は、まとめて末尾へ。**
 *
 * 速度の無い行どうしは、渡された順のままにする（並べ替える手がかりが
 * 無いのに順序を作ると、開くたびに入れ替わって見える）。
 */
function sortBySpeed(entries: readonly TuningStatsEntry[]): TuningStatsEntry[] {
  return [...entries].sort((a, b) => {
    const left = a.tuning.outputTokensPerSecond;
    const right = b.tuning.outputTokensPerSecond;
    if (left === undefined && right === undefined) return 0;
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return right - left;
  });
}

function speedCell(
  tokensPerSecond: number | undefined,
  isFastest: boolean
): string {
  if (tokensPerSecond === undefined) {
    // **「0.0」とは書かない。** 測っていないことと、測って遅かったことは別。
    // 次に測れば埋まると分かるようにしておく
    return `${UNKNOWN}（速度は次に測ったとき）`;
  }
  return `${tokensPerSecond.toFixed(1)}${isFastest ? " ◎ 最速" : ""}`;
}

/** 書ける長さ。**時間切れ混じりの実測には印を残す**（設計書6.77の第2段） */
function outputCell(tuning: ModelTuning): string {
  const tokens = countCell(tuning.measuredOutputTokens);
  if (tuning.measuredOutputTokens === undefined) return tokens;
  return tuning.outputMeasureTimedOut ? `${tokens}（時間切れあり）` : tokens;
}

function countCell(value: number | undefined): string {
  return value === undefined ? UNKNOWN : value.toLocaleString("ja-JP");
}

function decimalCell(value: number | undefined): string {
  return value === undefined ? UNKNOWN : value.toFixed(1);
}

/**
 * 測った日時を、日本時間の `YYYY-MM-DD HH:mm` にする。
 *
 * **固定の +9 時間で足りる。** 日本には夏時間が無いので、これで常に
 * 正しい。実行する機械の時計の設定に左右されないので、表が
 * 「どの時刻で書かれたか」を後から読み違えることもない。
 */
export function formatMeasuredAt(iso: string | undefined): string {
  if (iso === undefined) return UNKNOWN;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return UNKNOWN;
  const jst = new Date(time + 9 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth() + 1)}-` +
    `${pad(jst.getUTCDate())} ${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}`
  );
}

/**
 * モデルを選ぶ画面の説明文（`ai/registry.ts`）。
 *
 * **測ってあれば速さも見せる。** 何を選べばよいかの手がかりは、
 * 対応している機能より「自分の機械でどれだけ速いか」のほうが大きい。
 * 測っていなければ、これまでどおりの一文だけにする——測っていないことを
 * わざわざ書くと、選ぶ画面が注意書きで埋まる。
 */
export function modelPickDetail(
  capabilities: readonly string[],
  tokensPerSecond: number | undefined
): string | undefined {
  const parts: string[] = [];
  if (capabilities.length > 0) parts.push(`対応: ${capabilities.join(", ")}`);
  if (tokensPerSecond !== undefined) {
    parts.push(`実測 ${tokensPerSecond.toFixed(1)} トークン/秒`);
  }
  return parts.length > 0 ? parts.join(" ／ ") : undefined;
}

/** 表の中で縦棒が区切りに化けないようにする（`features/diagnoseWeb.ts` と同じ手） */
function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
