import { FACT_CONTRADICTION_CATEGORY } from "./factContradiction";

/**
 * 作者が採った・退けた指摘を、**指摘を出したモデルと機能ごとに**数える
 * （設計書6.49.7。作者の判断、2026-09-26）。
 *
 * ## なぜ数えるのか
 *
 * AIの当たり外れは、実データで測るまで分からない（CLAUDE.md「繰り返し
 * 起きた失敗」の2）。ところが測る台を組むのは作者の手間である。
 * **作者は提案パネルで毎日「採る」「退ける」を押している**——それが
 * そのまま、モデルごとの当たりの記録になる。
 *
 * ## `findings.jsonl` とは別に持つ
 *
 * 指摘の置き場（`.aiwriter/findings.jsonl`、6.96.4）にも判断の行はあるが、
 * **「古い指摘を片づける」で指摘ごと消える**（判断の行も一緒に消す決まり）。
 * 数を積み上げる記録がそこにあると、片づけるたびに率が振り出しへ戻る。
 * こちらは判断1件につき1行だけの小さな記録なので、消さずに持つ。
 *
 * ## `vscode` に触らない
 *
 * 読み書きは `features/verdictStore.ts`。ここは「行を読む・数える・
 * 文にする」だけなので、単体で試せる。
 */

/** 数える機能。**機能別AI割当（6.28.9）の鍵と同じ名前にしてある** */
export type VerdictFeature =
  | "typo"
  | "proofread"
  | "contradiction"
  | "deviation"
  | "foreshadow";

/**
 * 提案パネルの分類名（タブの名前）→ 数える機能。
 *
 * **ここに無い分類は数えない。** 数えないものには理由がある。
 *
 * - **表記ゆれ**：AIを使わない（決まりで拾う）。モデルの当たりではない
 * - **編集部からの提案・名前の付け替え・バックアップとの違い**：人か
 *   作者自身の操作が出どころで、AIの指摘ではない
 * - **設定資料の更新**：承認待ちのファイルから読み直すことがあり、
 *   どのモデルが作った案かを、後から確かめられない（ファイルに残っていない）
 * - **単話プロット**：機能別割当の鍵が無く、どのモデルで判定したかを
 *   決め打ちできない
 *
 * **矛盾（事実の照合）は矛盾検知に数える。** 取り出しは `factExtract` の
 * 割当だが、「矛盾か」を決めているのは `contradiction` の割当である
 * （`checkFactContradictions.ts`、設計書6.88.9）。
 */
const FEATURE_OF_CATEGORY: ReadonlyMap<string, VerdictFeature> = new Map<
  string,
  VerdictFeature
>([
  ["誤字脱字", "typo"],
  ["推敲", "proofread"],
  ["矛盾", "contradiction"],
  [FACT_CONTRADICTION_CATEGORY, "contradiction"],
  ["プロット逸脱", "deviation"],
  ["伏線の候補", "foreshadow"],
  ["伏線の回収", "foreshadow"],
]);

/** その分類を数えるか。**数えないなら `undefined`** */
export function verdictFeatureOf(category: string): VerdictFeature | undefined {
  return FEATURE_OF_CATEGORY.get(category);
}

/**
 * 判断の印。
 *
 * **`retracted` は「戻した」**（適用を元へ戻した）。追記しかしない記録
 * なので、取り消しも打ち消す行を足す形でしか書けない。前の行を書き換えると
 * 同期の衝突点になる（`findings.jsonl` と同じ理由）。
 */
export type VerdictStatus = "accepted" | "dismissed" | "retracted";

/** 1行1件の判断 */
export interface VerdictLine {
  /** いつ判断したか（ISO 8601） */
  time: string;
  /**
   * どの指摘への判断か。本文の指摘は置き場の番号（`findingIdOf`）、
   * 伏線の候補は中身から作った番号（`recordVerdictSubject`）。
   *
   * **同じ指摘への判断は、後のものだけを数える**ために要る。
   * 採ってから戻すと、1件を2回数えることになる。
   */
  subject: string;
  providerId: string;
  model: string;
  feature: VerdictFeature;
  status: VerdictStatus;
}

/** 採った・退けたの数（1つのモデル・1つの機能ぶん） */
export interface VerdictCount {
  providerId: string;
  model: string;
  feature: VerdictFeature;
  accepted: number;
  dismissed: number;
}

/**
 * **これだけ判断が集まるまで、率を出さない**（作者の判断、2026-09-26）。
 *
 * 3件中2件を採って「67%」と出すと、たまたまの偏りが一覧の数字として
 * 独り歩きする。少ないうちは件数だけを見せる。
 */
export const MIN_VERDICTS_FOR_RATE = 10;

const FEATURES: ReadonlySet<string> = new Set<VerdictFeature>([
  "typo",
  "proofread",
  "contradiction",
  "deviation",
  "foreshadow",
]);

/**
 * 機能別AI割当の鍵（`AssignableFeature`）のうち、採否を数える機能か。
 *
 * **鍵の名前は同じにしてある**ので、数える5つならそのまま返す。抽出・生成・
 * 相談などは指摘を出さない（採る・退けるが無い）ので `undefined`。
 */
export function asVerdictFeature(key: string): VerdictFeature | undefined {
  return FEATURES.has(key) ? (key as VerdictFeature) : undefined;
}

/**
 * 1行1件を読む。
 *
 * **読めない行は捨てて、読める行は残す。** 同期の競合で1行が壊れたときに、
 * 無事な記録まで見えなくしない。競合マーカーの行も落とす
 * （`parseFindingLines` と同じ作法）。
 */
export function parseVerdictLines(text: string): VerdictLine[] {
  const lines: VerdictLine[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(<<<<<<<|=======|>>>>>>>)/.test(line)) continue;
    try {
      const parsed = toVerdictLine(JSON.parse(line));
      if (parsed) lines.push(parsed);
    } catch {
      // 壊れた行は捨てる
    }
  }
  return lines;
}

function toVerdictLine(value: unknown): VerdictLine | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const subject = str(record.subject);
  const providerId = str(record.providerId);
  const model = str(record.model);
  const feature = record.feature;
  const status = record.status;
  if (!subject || !providerId || !model) return undefined;
  // **知らない値は読まない**（勝手に「退けた」ことにしない）
  if (typeof feature !== "string" || !FEATURES.has(feature)) return undefined;
  if (status !== "accepted" && status !== "dismissed" && status !== "retracted") {
    return undefined;
  }
  return {
    time: str(record.time),
    subject,
    providerId,
    model,
    feature: feature as VerdictFeature,
    status,
  };
}

/**
 * 数える。
 *
 * **1つの記録（＝1つの作品）ごとに渡す。** 同じ指摘を指す番号は作品の中で
 * しか一意でない（ファイル名から作るため）。作品をまたいで畳むと、
 * 別の作品の同じ名前の話の指摘が1件に潰れる。
 *
 * **同じ指摘・同じモデルへの判断は、最後の1つだけを数える。**
 * 採ってから戻したら数えない（`retracted`）。時刻が同じなら後から
 * 書かれた行が勝つ（追記しかしないので、ファイルの並びが起きた順である）。
 *
 * 並びは「AI → モデル → 機能」の順（表で同じモデルの行が固まるように）。
 */
export function tallyVerdicts(
  groups: readonly (readonly VerdictLine[])[]
): VerdictCount[] {
  const counts = new Map<string, VerdictCount>();
  for (const lines of groups) {
    const latest = new Map<string, VerdictLine>();
    for (const line of lines) {
      const key = [line.subject, line.providerId, line.model, line.feature].join(
        "\u0000"
      );
      const existing = latest.get(key);
      if (!existing || !isOlder(line.time, existing.time)) {
        latest.set(key, line);
      }
    }
    for (const line of latest.values()) {
      if (line.status === "retracted") continue;
      const key = countKey(line.providerId, line.model, line.feature);
      const count = counts.get(key) ?? {
        providerId: line.providerId,
        model: line.model,
        feature: line.feature,
        accepted: 0,
        dismissed: 0,
      };
      if (line.status === "accepted") count.accepted += 1;
      else count.dismissed += 1;
      counts.set(key, count);
    }
  }
  return [...counts.values()].sort(
    (a, b) =>
      a.providerId.localeCompare(b.providerId) ||
      a.model.localeCompare(b.model) ||
      a.feature.localeCompare(b.feature)
  );
}

/** 数えた結果から、1つのモデル・1つの機能ぶんを引く */
export function findVerdictCount(
  counts: readonly VerdictCount[],
  providerId: string,
  model: string,
  feature: VerdictFeature
): VerdictCount | undefined {
  return counts.find(
    (count) =>
      count.providerId === providerId &&
      count.model === model &&
      count.feature === feature
  );
}

/**
 * 採った率（0〜100の整数）。**判断が `MIN_VERDICTS_FOR_RATE` に満たなければ `undefined`**。
 */
export function acceptanceRate(count: {
  accepted: number;
  dismissed: number;
}): number | undefined {
  const total = count.accepted + count.dismissed;
  if (total < MIN_VERDICTS_FOR_RATE) return undefined;
  return Math.round((count.accepted / total) * 100);
}

/**
 * 1行の文にする（機能別AI割当の選択画面に出す）。
 *
 * 例：「作者が採った率 80%（25件中）」／「作者の判断は まだ3件（10件から率を出します）」
 */
export function describeVerdictCount(count: {
  accepted: number;
  dismissed: number;
}): string {
  const total = count.accepted + count.dismissed;
  const rate = acceptanceRate(count);
  if (rate === undefined) {
    return `作者の判断は まだ${total}件（${MIN_VERDICTS_FOR_RATE}件から率を出します）`;
  }
  return `作者が採った率 ${rate}%（${total}件中）`;
}

/**
 * 伏線の候補など、置き場の番号を持たない提案の番号を作る。
 *
 * **中身から決まる番号にする。** 画面の番号（`f:チャンク:並び`）は並びに
 * 依るので、同じ候補を2回検知すると別の番号になり、1件を2回数える。
 */
export function recordVerdictSubject(
  category: string,
  name: string,
  changes: readonly string[]
): string {
  const source = [category, name, ...changes].join("\u0000");
  // 短い決定的な番号。暗号用途ではないので簡単な畳み込みで足りる
  // （`findingId` と同じ作り）
  let hash = 0;
  for (const char of source) {
    hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  }
  return `r${hash.toString(36)}`;
}

/**
 * AIチューニングの記録（`novelai.showTuningStats`）に足す節を組む。
 *
 * @param providerLabel プロバイダIDを表示名へ直す（知らなければIDのまま）
 * @param featureLabel 機能の表示名（割当の画面と同じ名前にする）
 */
export function buildVerdictStatsMarkdown(
  counts: readonly VerdictCount[],
  providerLabel: (providerId: string) => string,
  featureLabel: (feature: VerdictFeature) => string
): string {
  const lines = [
    "## 作者が採った指摘の率",
    "",
    "提案パネルで作者が採った・退けた指摘を、指摘を出したモデルと機能ごとに数えています（書庫のすべての作品の合計）。" +
      `判断が${MIN_VERDICTS_FOR_RATE}件に満たないうちは、率を出さずに件数だけを出します。`,
    "",
    "- 採った：本文へ当てた指摘、手で直して再チェックで解消を確かめた指摘、登録・回収済みにした伏線の候補",
    "- 退けた：「無視」「見送る」「今後直さない」を押した指摘",
    "- 当てたあとで戻したもの、矛盾を「伏線として登録」したものは数えません",
    "",
  ];
  if (counts.length === 0) {
    lines.push(
      "まだ記録がありません。提案パネルで指摘を採る・退けると、ここに数が出ます。"
    );
    return lines.join("\n") + "\n";
  }
  lines.push(
    "| AI | モデル | 機能 | 採った | 退けた | 採った率 |",
    "|---|---|---|---:|---:|---:|"
  );
  for (const count of counts) {
    const rate = acceptanceRate(count);
    lines.push(
      `| ${cell(providerLabel(count.providerId))} | ${cell(count.model)} | ` +
        `${cell(featureLabel(count.feature))} | ${count.accepted} | ` +
        `${count.dismissed} | ${
          rate === undefined
            ? `—（${MIN_VERDICTS_FOR_RATE}件未満）`
            : `${rate}%`
        } |`
    );
  }
  return lines.join("\n") + "\n";
}

function countKey(providerId: string, model: string, feature: string): string {
  return [providerId, model, feature].join("\u0000");
}

/** 表の升目を壊す文字（`|`・改行）を逃がす */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** `candidate` が `current` より古いか。読めない時刻は古いとみなさない */
function isOlder(candidate: string, current: string): boolean {
  const left = Date.parse(candidate);
  const right = Date.parse(current);
  if (Number.isNaN(left) || Number.isNaN(right)) return false;
  return left < right;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
