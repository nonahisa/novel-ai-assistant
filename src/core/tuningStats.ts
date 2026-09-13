import type { ModelTuning, SpeedSource } from "./modelTuning";
import {
  CHARS_PER_TOKEN,
  MIN_CHARS_PER_TOKEN_SAMPLES,
  resolveCharsPerToken,
} from "./sizeBudget";

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
    "速度は出力の実測（トークン/秒）です。普段のAI呼び出しからも記録します。" +
      "同じモデルでも機械の負荷で変わるので目安です。",
    "",
    "字/トークンも普段の呼び出しから記録します（送った字数 ÷ 応答が申告した" +
      "入力トークン数の、これまでの最小値）。この値が入ると本文の分割が" +
      "変わるので、実際にいくつで見積もっているかを欄の中に併記します。",
    "",
    "| AI | モデル | 出力速度（トークン/秒） | 速度の出どころ | 速度を測った日時 | " +
      "文脈の実効長（トークン） | 読める長さ（字） | 書ける長さ（トークン） | 測った日時 | " +
      "字/トークン（実測） |",
    "|---|---|---|---|---|---|---|---|---|---|"
  );

  const sorted = sortBySpeed(entries);
  // 印は1行だけ。並べ替えたあとの先頭が実測なら、そこが最速である
  // （推定は下へ回してあるので、先頭に来ることは無い）
  const fastest = sorted.findIndex(isMeasuredSpeed);

  sorted.forEach((entry, index) => {
    lines.push(
      "| " +
        [
          escapeCell(entry.providerLabel),
          escapeCell(entry.model),
          speedCell(entry.tuning.outputTokensPerSecond, index === fastest),
          speedSourceCell(entry.tuning.speedSource),
          formatMeasuredAt(entry.tuning.speedMeasuredAt),
          countCell(entry.tuning.contextWindow),
          readCell(entry.tuning),
          outputCell(entry.tuning),
          formatMeasuredAt(entry.tuning.measuredAt),
          charsPerTokenCell(entry.tuning),
        ].join(" | ") +
        " |"
    );
  });

  return lines.join("\n") + "\n";
}

/**
 * 速い順。**速度の無い行は、まとめて末尾へ。**
 *
 * **推定（`estimated`）は、実測の下へ回す。** 換算の係数は安全側
 * （多め）に採ってあるので、推定は**構造的に速く出る**。数字の大小だけで
 * 並べると、一度も測っていないモデルが先頭に立ち、速さを見に来た人が
 * いちばん当てにならない行を最初に読むことになる。
 *
 * 同じ組の中では速い順。速度の無い行どうしは、渡された順のままにする
 * （並べ替える手がかりが無いのに順序を作ると、開くたびに入れ替わって見える）。
 */
function sortBySpeed(entries: readonly TuningStatsEntry[]): TuningStatsEntry[] {
  return [...entries].sort((a, b) => {
    const rank = speedRank(a) - speedRank(b);
    if (rank !== 0) return rank;

    const left = a.tuning.outputTokensPerSecond;
    const right = b.tuning.outputTokensPerSecond;
    if (left === undefined || right === undefined) return 0;
    return right - left;
  });
}

/** 並びの組。小さいほど上（実測 → 推定 → 速度が無い） */
function speedRank(entry: TuningStatsEntry): number {
  if (entry.tuning.outputTokensPerSecond === undefined) return 2;
  return entry.tuning.speedSource === "estimated" ? 1 : 0;
}

/**
 * 実際に測った速さか（◎ を付けてよい行か）。
 *
 * **出どころの分からない古い台帳（0.36.3まで）は実測として扱う。**
 * 推定という区分ができる前の値なので、そこに入っているのは測った値である。
 */
function isMeasuredSpeed(entry: TuningStatsEntry): boolean {
  return speedRank(entry) === 0;
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
/**
 * 読める長さ（作者の指摘、2026-09-13）。
 *
 * **天井まで通った行は、実測ではなく下限値である。** 同じ列に混ぜたままだと
 * 「これ以上は試していない」ことが読めず、小さいモデルのほうが多く読める
 * ように見える。印を付けて分ける。
 */
function readCell(tuning: ModelTuning): string {
  const chars = countCell(tuning.measuredChars);
  if (tuning.measuredChars === undefined) return chars;
  /*
    **断りは重なる。** 天井で止まった値が、さらに合言葉で測ったもので
    あることもある（どちらも「この数字は弱い」の別々の理由なので、
    片方だけ出すと、もう片方の弱さが隠れる）。
  */
  const notes: string[] = [];
  if (tuning.contextHitCeiling) notes.push("これ以上は試していません");
  /*
    **分あたりの上限で降りた測定にも断りを付ける**（作者の裁定、
    2026-09-13夜）。天井の印とは弱さの向きが逆で、こちらは**低めに出て
    いる**——待ってから測り直せば伸びることがある。並べて出すのは、
    どちらも「この数字は弱い」の別々の理由だからである。
  */
  if (tuning.contextLimitedByRate) notes.push("分あたりの上限で決まった値");
  // 入力トークン数で測った行には何も足さない——それが本来の測り方で、
  // 断りが要るのは弱いほうだけである（作者の依頼、2026-09-13）
  if (tuning.contextMeasuredBy === "words") notes.push("合言葉で測定");
  return notes.length > 0 ? `${chars}（${notes.join("。")}）` : chars;
}

/**
 * 書ける長さ（作者の依頼、2026-09-13「書ける長さの文字数は出せないでしょうか？」）。
 *
 * **読める長さは字、書ける長さはトークンで出していた。** 単位が揃って
 * いないと、作者は頭の中で換算しながら読むことになる。作者が数えるのは
 * 字である（原稿も投稿サイトも字で数える）。
 *
 * **字を添えるのは、そのモデルの換算を実測しているときだけ。** かつての
 * 当て推量（0.7字/トークン）で割ると、実測の半分以下の字数が出る——
 * 今日その食い違いを直したばかりなのに、表で古い当て推量を使っては
 * 意味が無い。実測が無い行は、これまでどおりトークンだけを出す。
 *
 * **余白（×0.9）は掛けない。** あれは「送る量を決める」ための安全側で
 * あって、ここは「どれだけ書けたか」を伝えるだけである。安全側へ寄せた
 * 数字を実績として見せると、作者は実際より書けないと受け取る。
 */
function outputCell(tuning: ModelTuning): string {
  const tokens = countCell(tuning.measuredOutputTokens);
  if (tuning.measuredOutputTokens === undefined) return tokens;

  const notes: string[] = [];
  const chars = outputChars(tuning);
  if (chars !== undefined) notes.push(`約${chars.toLocaleString("ja-JP")}字`);
  if (tuning.outputMeasureTimedOut) notes.push("時間切れあり");
  return notes.length > 0 ? `${tokens}（${notes.join("。")}）` : tokens;
}

/**
 * 書けたトークン数を字へ直す。実測の換算が無ければ出さない。
 *
 * **入力から測った換算を、出力にも当てる。** 同じモデル・同じ言語なので
 * 字とトークンの関係は変わらない（入力側でしか測れないのは、AIが返す
 * のが「読んだトークン数」だからである）。**近い値であって、実測では
 * ない**ので「約」を付ける。
 */
function outputChars(tuning: ModelTuning): number | undefined {
  const tokens = tuning.measuredOutputTokens;
  const ratio = tuning.charsPerToken;
  if (tokens === undefined || ratio === undefined) return undefined;
  if (!Number.isFinite(ratio) || ratio <= 0) return undefined;
  return Math.round(tokens * ratio);
}

/**
 * 速度の出どころ（設計書6.65.14）。
 *
 * **当て推量で埋めない。** 0.36.3 の台帳には出どころの欄が無いので、
 * 速度が入っていても札は付かない。そこを「チューニング」と決め打ちすると、
 * 実際には測っていないものを測ったことにしてしまう。
 */
function speedSourceCell(source: SpeedSource | undefined): string {
  switch (source) {
    case "tuning":
      return "チューニング";
    case "call":
      return "普段の呼び出し";
    case "estimated":
      // 換算ぶんの誤差が乗っていることを、数字の隣で分かるようにする
      return "普段の呼び出し（推定）";
    default:
      return UNKNOWN;
  }
}

/**
 * 字/トークンの実測（設計書6.77）。
 *
 * **実際に見積もりへ使う値まで書く。** 台帳の値をそのまま出すだけだと、
 * 「1.461と出ているのにチャンクが増えない」（件数が足りない・余白を
 * 掛けた・0.7を下回って据え置いた）の理由が読めない。**数字が変わったのに
 * なぜ変わったかが読めないのが、いちばん困る。**
 */
function charsPerTokenCell(tuning: ModelTuning): string {
  const measured = tuning.charsPerToken;
  if (measured === undefined) return `${UNKNOWN}（次の呼び出しから記録）`;

  const samples = tuning.charsPerTokenSamples ?? 0;
  const used = resolveCharsPerToken(tuning);
  const count = `${samples.toLocaleString("ja-JP")}回`;
  if (samples < MIN_CHARS_PER_TOKEN_SAMPLES) {
    return (
      `${measured.toFixed(3)}（${count}。` +
      `${MIN_CHARS_PER_TOKEN_SAMPLES}回に満たないため ` +
      `${CHARS_PER_TOKEN} で見積もります）`
    );
  }
  if (used === CHARS_PER_TOKEN) {
    // 実測のほうが悪いモデル。**これまでより不利にしない**ので据え置き
    return `${measured.toFixed(3)}（${count}。低いため ${CHARS_PER_TOKEN} のまま）`;
  }
  return `${measured.toFixed(3)}（${count}。余白を取って ${used.toFixed(3)} で見積もり）`;
}

function countCell(value: number | undefined): string {
  return value === undefined ? UNKNOWN : value.toLocaleString("ja-JP");
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
 *
 * **読める長さと書ける長さも、ここへ出す**（作者の依頼、2026-09-13）。
 * この2つは一覧（`buildTuningStatsMarkdown`）にしか無かったが、モデルを
 * 選ぶのはこの画面である。**選んだあとで一覧を開き直して確かめる**のは、
 * 手順が1つ多い。台帳に入っている値だけを出すので、測っていないモデルの
 * 行はこれまでと変わらない。
 */
export function modelPickDetail(
  capabilities: readonly string[],
  tuning: ModelTuning | undefined
): string | undefined {
  const parts: string[] = [];
  if (capabilities.length > 0) parts.push(`対応: ${capabilities.join(", ")}`);
  if (tuning?.outputTokensPerSecond !== undefined) {
    parts.push(`実測 ${tuning.outputTokensPerSecond.toFixed(1)} トークン/秒`);
  }
  const read = pickReadLength(tuning);
  if (read) parts.push(read);
  const write = pickWriteLength(tuning);
  if (write) parts.push(write);
  return parts.length > 0 ? parts.join(" ／ ") : undefined;
}

/**
 * 選ぶ場に出す「読める長さ」（作者の依頼、2026-09-13
 * 「モデルの一覧ですが、書ける文字数追加もやることリストに入れておいて
 * ください」）。
 *
 * **一覧の断りは、ここでは「以上」の二文字に畳む。** 表（`readCell`）は
 * 「これ以上は試していません」と書ける広さがあるが、ここは選ぶ画面の
 * 1行である。理由まで書くと、対応している機能も速さも押し出されて
 * 読めなくなる。**弱い数字だと分かることだけは落とさない。**
 */
function pickReadLength(tuning: ModelTuning | undefined): string | undefined {
  const chars = tuning?.measuredChars;
  if (chars === undefined) return undefined;
  /*
    **分あたりの上限で降りた値には「以上」を付けない**（作者の裁定、
    2026-09-13夜）。天井の印は「本当はもっと読めるかもしれない」なので
    「以上」でよいが、こちらは**その逆で、値そのものが低く出ている。**
    同じ「以上」を付けると、待てば伸びる数字を**強い実測だと誤解させる。**

    天井の印と重なることは、まず無い（天井の回で降りたのなら、通った
    最大の字数は天井へ届かない）。それでも重なったときは、**弱いほうを
    出す**——強く見せて外すより、弱く見せて外すほうが害が小さい。
  */
  if (tuning?.contextLimitedByRate) {
    return `読める ${chars.toLocaleString("ja-JP")}字（分あたりの上限で頭打ち）`;
  }
  const suffix = tuning?.contextHitCeiling ? "字以上" : "字";
  return `読める ${chars.toLocaleString("ja-JP")}${suffix}`;
}

/**
 * 選ぶ場に出す「書ける長さ」。
 *
 * **字で出せるのは、そのモデルの換算を実測しているときだけ**（`outputChars`
 * と同じ約束）。無ければトークンのまま出す——当て推量で割った字数を
 * 見せるくらいなら、単位が揃っていないほうがましである。
 *
 * 時間切れで打ち切った測定は、その先まで書けたかもしれない。読める長さの
 * 天井と同じく「以上」を添える。
 */
function pickWriteLength(tuning: ModelTuning | undefined): string | undefined {
  const tokens = tuning?.measuredOutputTokens;
  if (tokens === undefined || tuning === undefined) return undefined;
  const suffix = tuning.outputMeasureTimedOut ? "以上" : "";
  const chars = outputChars(tuning);
  return chars === undefined
    ? `書ける ${tokens.toLocaleString("ja-JP")}トークン${suffix}`
    : `書ける 約${chars.toLocaleString("ja-JP")}字${suffix}`;
}

/** 表の中で縦棒が区切りに化けないようにする（`features/diagnoseWeb.ts` と同じ手） */
function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
