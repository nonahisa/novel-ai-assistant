import { normalizeForComparison } from "./groundedEvidence";
import { isPlaceholderText } from "./placeholderText";
import { readGroundedPraise, type PraiseItem } from "./praise";
// 引用の長さの上限は**逸脱検知が持つものを借りる**（設計書6.77の第2段）。
// 以前は同名同値の定数を両方が持っており、片方だけ直す壊れ方ができた
import { MAX_EXCERPT_CHARS } from "./deviationValidation";
import type { EpisodePlotItem } from "./episodePlotDoc";
import {
  EPISODE_PLOT_CHECK_HINTS,
  EPISODE_PLOT_CHECK_KINDS,
  episodePlotCheckKindsFor,
  type EpisodePlotCheckKind,
} from "../prompts/episodePlotCheck";
import {
  EPISODE_PLOT_CONTRAST_HINTS,
  EPISODE_PLOT_CONTRAST_KIND_ALIASES,
  EPISODE_PLOT_CONTRAST_KINDS,
  type EpisodePlotContrastKind,
} from "../prompts/episodePlotContrast";

/**
 * 単話プロットのAI判定（P-27・P-28、設計書6.36.3）の応答の検証。
 *
 * **AIの出力を信用しない。** この2つに固有の危うさは、**指した先が
 * 実在しないこと**である。「『王都で剣を買う』は目標に繋がりません」と
 * 言われても、箇条書きにその行が無ければ読みようが無い。
 * 逸脱検知（`deviationValidation.ts`）で `plotReference` を照合したのと
 * 同じ手当てを、最初から入れる。
 *
 * **どちらも「指摘まで」**なので、修正案の検証は無い（そもそも
 * 修正案の欄をスキーマに持たせていない）。
 *
 * VS Code APIに依存しない。
 */

// ── 共通 ─────────────────────────────────────────

export type EpisodePlotRejectReason =
  /** 形が違う（項目が無い・型が違う） */
  | "shape"
  /** 3種のどれでもない */
  | "unknown_kind"
  /** 理由が空、または中身の無い言葉（指示の言い換え） */
  | "placeholder"
  /** 指した箇条書きの行が実在しない */
  | "item_not_found"
  /** 照らした箇条書きの行が実在しない（P-28） */
  | "plot_item_not_found"
  /** 引用が本文に実在しない（P-28） */
  | "excerpt_not_found"
  /** 引用が長すぎる（段落をまるごと写している。P-28） */
  | "excerpt_too_long"
  /** 箇条書きも本文も指していない（P-28）。何も指せない指摘は読めない */
  | "nothing_pointed"
  /** 同じ行への二重の指摘 */
  | "duplicate"
  /** 件数の上限を超えた */
  | "over_budget"
  /** 目標の節が空なのに、目標の観点で指摘した（P-27） */
  | "no_goal"
  /** 理由の中で、自分の指摘を打ち消している（P-28） */
  | "self_denied"
  /** 「主筋の改変」なのに、変わった元の箇条書きの行を指していない（P-28） */
  | "change_without_item"
  /** 「主筋の改変」の理由が、箇条書きの筋の言い直しで、逆の結果を言っていない（P-28） */
  | "restated_item";

export interface RejectedEpisodePlotFinding {
  raw: unknown;
  reason: EpisodePlotRejectReason;
}

/**
 * 指した箇条書きが実在するか。実在するならその行を返す。
 *
 * **写し方の揺れは許す。** 「- 」を落とす、末尾を省く、といった写し方は
 * 普通に起きる。実在の行に収まっている断片なら、その行を指したものとして
 * 扱う（ただし**短すぎる断片は見ない**――「朝」だけで当たっては、
 * どの行を指しているか決まらない）。
 *
 * 返すのは**実在の行そのもの**である。AIが写した断片をそのまま画面へ
 * 出すと、作者は自分が書いていない文を読むことになる。
 */
export function matchPlotItem(
  raw: string,
  items: readonly EpisodePlotItem[]
): EpisodePlotItem | undefined {
  const found = matchPlotItemAsWritten(raw, items);
  if (found) return found;
  // **番号ごと写してくる。** P-28 は順序を見るため箇条書きに番号を振って
  // 渡しており（「1. 〜」）、gemma4:e4b は「2. 受付嬢のメアリーが〜」と
  // 番号ごと返した（2026-09-25 の測定で18件がこれで落ちた）。
  // **写したまま当ててから**外す——行そのものが「3日後、〜」のように
  // 数字で始まることもあるので、先に外すと別の行に当たりうる
  const unnumbered = stripListNumber(raw);
  return unnumbered === raw
    ? undefined
    : matchPlotItemAsWritten(unnumbered, items);
}

function matchPlotItemAsWritten(
  raw: string,
  items: readonly EpisodePlotItem[]
): EpisodePlotItem | undefined {
  const needle = normalizeForComparison(raw);
  if (!needle) return undefined;

  const exact = items.find(
    (item) => normalizeForComparison(item.text) === needle
  );
  if (exact) return exact;

  // 短い断片での部分一致は当てにならない（4字は `groundedEvidence` と同じ線）
  if (needle.length < 4) return undefined;
  return items.find((item) =>
    normalizeForComparison(item.text).includes(needle)
  );
}

/**
 * 行の頭の番号（「2. 」「２．」「2) 」「2、」）を外す。
 *
 * 番号の後ろに区切りがあるものだけを番号と読む。「3日後、」のように
 * 数字の直後に字が続くものは行の中身なので外さない。
 */
function stripListNumber(raw: string): string {
  return raw.replace(/^\s*[0-9０-９]{1,3}\s*[.．、,，)）:：]\s*/u, "");
}

/**
 * 引用が本文の何行目にあるか（1始まり）。実在しなければ null。
 *
 * **AIに行番号を言わせない。** 本文から機械的に求まる値なので、
 * 言わせるとずれた番号で「ここが違う」と言うことになる
 * （`groundedEvidence.ts` が話数をAIに言わせない理由と同じ）。
 *
 * 照合は正規化した文字列で行うため、**正規化後の位置から元の行へ
 * 戻せるように**、1文字ずつ行番号を控えながら組み立てる。
 */
export function lineOfExcerpt(text: string, excerpt: string): number | null {
  const needle = normalizeForComparison(excerpt);
  if (!needle) return null;

  let normalized = "";
  const lineAt: number[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  lines.forEach((line, index) => {
    const body = normalizeForComparison(line);
    for (let i = 0; i < body.length; i++) lineAt.push(index + 1);
    normalized += body;
  });

  const at = normalized.indexOf(needle);
  return at < 0 ? null : (lineAt[at] ?? 1);
}

/**
 * 構造化出力でも前後に説明やコードフェンスが付くモデルがあるため、
 * 生のJSON、コードフェンス除去、最外の波括弧抽出の順で解析する
 * （矛盾検知・伏線検知・章立てと同じ手順）。
 */
export function parseEpisodePlotFindings(
  text: string
): { findings: unknown[]; strengths?: unknown[] } | null {
  const attempts = [
    text,
    text.replace(/^[\s\S]*?```(?:json)?\s*/i, "").replace(/```[\s\S]*$/, ""),
    extractBraces(text),
  ];

  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate.trim());
      if (isRecord(parsed) && Array.isArray(parsed.findings)) {
        /*
          **良いところの欄も残す**（P-27 の 1.1、プロンプト設計書1.9）。
          この戻り値がそのままキャッシュへ入るので、ここで捨てると
          2回目以降は良いところが1件も出なくなる。欄が無い応答（P-28・
          1.0 の古い答え）では足さない——無いものを空配列で作らない
        */
        return Array.isArray(parsed.strengths)
          ? { findings: parsed.findings, strengths: parsed.strengths }
          : { findings: parsed.findings };
      }
    } catch {
      // 次の候補を試す
    }
  }
  return null;
}

/** 却下の理由を、作者が読める日本語にする */
const REJECT_REASON_LABELS: Record<EpisodePlotRejectReason, string> = {
  shape: "形が違う",
  unknown_kind: "知らない種別",
  placeholder: "理由が空",
  item_not_found: "箇条書きに無い行を指した",
  plot_item_not_found: "箇条書きに無い行を指した",
  excerpt_not_found: "本文に無い引用",
  excerpt_too_long: "引用が長すぎる",
  nothing_pointed: "どこも指していない",
  duplicate: "同じ行への重なり",
  over_budget: "件数の上限超え",
  no_goal: "目標が書かれていないのに目標で判断",
  self_denied: "理由で自分の指摘を打ち消している",
  change_without_item: "改変の元の行を指していない",
  restated_item: "改変の理由が筋の言い直し（逆の結果を言っていない）",
};

/**
 * 却下の内訳を、ログ・通知向けの1行にする。
 *
 * **数だけでは次の一手が決まらない**（章立ての提案と同じ考え方）。
 * `item_not_found` が多ければAIが箇条書きを写せていない（プロンプトの
 * 問題）、`shape` が多ければスキーマの与え方（プロバイダの方言）の問題である。
 */
export function describeEpisodePlotRejects(
  rejected: ReadonlyArray<{ reason: string }>
): string {
  if (rejected.length === 0) return "";
  const counts = new Map<string, number>();
  for (const entry of rejected) {
    counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(
      ([reason, count]) =>
        `${
          REJECT_REASON_LABELS[reason as EpisodePlotRejectReason] ?? reason
        } ${count}件`
    )
    .join("、");
}

// ── P-27 展開の検査 ───────────────────────────────

export interface EpisodePlotFinding {
  /** 対象の箇条書き。**実在の行そのもの**（AIが写した断片ではない） */
  item: string;
  /** その行が単話プロットの何行目か（1始まり） */
  line: number;
  kind: EpisodePlotCheckKind;
  reason: string;
}

/**
 * @param input.goal 単話プロットの「この話の目標」の節（空なら空文字）。
 *   **空のときは、目標を物差しにする観点の指摘を落とす**
 *   （`episodePlotCheckKindsFor`。プロンプトもその観点を尋ねない）
 */
export function validateEpisodePlotCheck(
  raw: unknown,
  input: { items: readonly EpisodePlotItem[]; goal: string; maxFindings: number }
): {
  accepted: EpisodePlotFinding[];
  rejected: RejectedEpisodePlotFinding[];
  /**
   * 効いている展開（プロンプト設計書1.9）。`quote` は**実在の行そのもの**。
   * 件数の上限（`maxFindings`）は掛けない——上限は「作り直しの要求に
   * ならないため」の歯止めで、ほめる所には当たらない
   */
  strengths: PraiseItem[];
  /** 箇条書きに無い行をほめていたので落とした数。**黙って減らさない** */
  strengthsDropped: number;
} {
  const praise = readGroundedPraise(
    isRecord(raw) ? raw.strengths : undefined,
    (quote) => matchPlotItem(quote, input.items)?.text,
    { quote: "item", why: "why" }
  );
  // 出力例の言い換え（「効いている理由」）がそのまま返ったものは、理由ではない
  const strengths = praise.items.filter(
    (item) => !isEmptyAnswer(item.why, EPISODE_PLOT_CHECK_HINTS)
  );
  const findingsResult = validateEpisodePlotFindings(raw, input);
  return {
    ...findingsResult,
    strengths,
    strengthsDropped: praise.notFound,
  };
}

function validateEpisodePlotFindings(
  raw: unknown,
  input: { items: readonly EpisodePlotItem[]; goal: string; maxFindings: number }
): {
  accepted: EpisodePlotFinding[];
  rejected: RejectedEpisodePlotFinding[];
} {
  const accepted: EpisodePlotFinding[] = [];
  const rejected: RejectedEpisodePlotFinding[] = [];
  const seen = new Set<number>();
  // 尋ねた観点だけを受け取る。**目標が空なら「目標に向かっていない」
  // 「目標と矛盾」は成り立たない**——照らす目標が無い。実機確認
  // （2026-09-25 深夜、gemma4:e4b）で、目標の空な19話に11件これが付き、
  // 理由は「目標が不明なため判断できません」だった。プロンプトからも外したが、
  // 小さいモデルは尋ねていない観点でも見本を覚えて返すので、ここでも落とす
  const askedKinds = episodePlotCheckKindsFor(input.goal);

  for (const entry of findingsOf(raw)) {
    if (!isRecord(entry)) {
      rejected.push({ raw: entry, reason: "shape" });
      continue;
    }
    const item = asString(entry.item);
    const reason = asString(entry.reason);
    if (!item) {
      rejected.push({ raw: entry, reason: "shape" });
      continue;
    }

    const kind = normalizeKind(asString(entry.kind), EPISODE_PLOT_CHECK_KINDS);
    if (!kind) {
      rejected.push({ raw: entry, reason: "unknown_kind" });
      continue;
    }
    if (!askedKinds.includes(kind)) {
      rejected.push({ raw: entry, reason: "no_goal" });
      continue;
    }
    const matched = matchPlotItem(item, input.items);
    if (!matched) {
      rejected.push({ raw: entry, reason: "item_not_found" });
      continue;
    }
    if (isEmptyAnswer(reason, EPISODE_PLOT_CHECK_HINTS)) {
      rejected.push({ raw: entry, reason: "placeholder" });
      continue;
    }
    // **同じ行を二度指してくる。** 種別を変えて同じことを言うだけなので、
    // 並べても作者の判断は増えない
    if (seen.has(matched.line)) {
      rejected.push({ raw: entry, reason: "duplicate" });
      continue;
    }

    if (accepted.length >= input.maxFindings) {
      rejected.push({ raw: entry, reason: "over_budget" });
      continue;
    }
    seen.add(matched.line);
    accepted.push({
      item: matched.text,
      line: matched.line,
      kind,
      reason,
    });
  }

  return { accepted, rejected };
}

// ── P-28 本文との照合 ─────────────────────────────

export interface EpisodePlotContrastFinding {
  kind: EpisodePlotContrastKind;
  /** 照らした箇条書きの行。指していなければ null */
  plotItem: string | null;
  /** その行が単話プロットの何行目か。指していなければ null */
  plotLine: number | null;
  /** 本文の引用。指していなければ null */
  excerpt: string | null;
  /** 本文の何行目か（引用から機械的に求める）。引用が無ければ null */
  line: number | null;
  /**
   * 入れ替わった相手の箇条書きの行（「順序の食い違い」だけ。ほかは null）。
   * **実在の行そのもの**（AIが写した断片ではない）
   */
  swappedItem: string | null;
  /** 相手の行が単話プロットの何行目か */
  swappedPlotLine: number | null;
  /** 相手の行に当たる本文の引用 */
  swappedExcerpt: string | null;
  /** 相手の引用が本文の何行目か */
  swappedLine: number | null;
  reason: string;
}

/** 指していない、を表す相手の欄（「順序の食い違い」以外の種別） */
const NO_PARTNER = {
  swappedItem: null,
  swappedPlotLine: null,
  swappedExcerpt: null,
  swappedLine: null,
} as const;

export function validateEpisodePlotContrast(
  raw: unknown,
  input: {
    items: readonly EpisodePlotItem[];
    text: string;
    maxFindings: number;
  }
): {
  accepted: EpisodePlotContrastFinding[];
  rejected: RejectedEpisodePlotFinding[];
} {
  const accepted: EpisodePlotContrastFinding[] = [];
  const rejected: RejectedEpisodePlotFinding[] = [];
  const seen = new Set<string>();

  for (const entry of findingsOf(raw)) {
    if (!isRecord(entry)) {
      rejected.push({ raw: entry, reason: "shape" });
      continue;
    }

    const labeledKind = normalizeContrastKind(asString(entry.kind));
    if (!labeledKind) {
      rejected.push({ raw: entry, reason: "unknown_kind" });
      continue;
    }
    const reason = asString(entry.reason);
    if (isEmptyAnswer(reason, EPISODE_PLOT_CONTRAST_HINTS)) {
      rejected.push({ raw: entry, reason: "placeholder" });
      continue;
    }

    // 「無い」を言葉で書いてくることがある（`null` ではなく「該当なし」）。
    // 中身の無い言葉は、指していないものとして扱う
    let rawItem = usableOrEmpty(asString(entry.plotItem));
    let rawExcerpt = usableOrEmpty(asString(entry.excerpt));

    // **箇条書きの行を引用の欄に写してきたら、箇条書きの欄へ移す**
    // （`bulletCopiedAsExcerpt`）。移したあとは下の札の付け替えが
    // 「出来事の欠落」へ直す（引用は空、行を指す、理由は「無い」）
    const copied = bulletCopiedAsExcerpt(
      rawItem,
      rawExcerpt,
      reason,
      input
    );
    if (copied) {
      rawItem = copied;
      rawExcerpt = "";
    }
    // **箇条書きの欄と引用の欄に、同じ行を写してきたら引用だけ外す**
    // （2026-09-26、さくら Kimi-K2.6。`sameBulletInBoth`）
    if (sameBulletInBoth(rawItem, rawExcerpt, input)) rawExcerpt = "";

    // **札の貼り違いを直す**（`isMislabeledAbsence`）。付け替えてから
    // 打ち消しの網を当てる——網は種別ごとに違うので、先に当てると
    // 「出来事の欠落」の指摘を順序の網で見ることになる
    const kind: EpisodePlotContrastKind = isMislabeledAbsence(
      labeledKind,
      rawItem,
      rawExcerpt,
      reason
    )
      ? "出来事の欠落"
      : labeledKind;

    // **理由の中で、自分の指摘を打ち消している答えを通さない**（`deniesOwnContrast`）
    if (deniesOwnContrast(kind, reason)) {
      rejected.push({ raw: entry, reason: "self_denied" });
      continue;
    }
    if (!rawItem && !rawExcerpt) {
      rejected.push({ raw: entry, reason: "nothing_pointed" });
      continue;
    }
    // **「主筋の改変」は、変わった元の行が要る。** 本文の場面だけでは、
    // 箇条書きのどの筋と違う方向なのかを作者が読めない（それは
    // 「箇条書きに無い」の形）。どちらと読むかをコードが推し量らずに捨てる
    if (kind === "主筋の改変" && !rawItem) {
      rejected.push({ raw: entry, reason: "change_without_item" });
      continue;
    }

    let excerpt: string | null = null;
    let line: number | null = null;
    if (rawExcerpt) {
      const located = locateGroundedExcerpt(input.text, rawExcerpt);
      if (typeof located === "string") {
        rejected.push({ raw: entry, reason: located });
        continue;
      }
      line = located.line;
      excerpt = located.excerpt;
    }

    let plotItem: string | null = null;
    let plotLine: number | null = null;
    if (rawItem) {
      const matched = matchPlotItem(rawItem, input.items);
      if (!matched) {
        rejected.push({ raw: entry, reason: "plot_item_not_found" });
        continue;
      }
      plotItem = matched.text;
      plotLine = matched.line;
    }

    // **「主筋の改変」の理由が、箇条書きの筋を言い直しただけの答えを通さない**
    // （`restatesPlotWithoutReversal`）。箇条書きの行は写し方が揺れる（途中を
    // 省いて返してくる）ので、照合で当てた**箇条書きの側の文**で打ち消しを見る
    if (
      kind === "主筋の改変" &&
      plotItem !== null &&
      restatesPlotWithoutReversal(reason, plotItem, input.items)
    ) {
      rejected.push({ raw: entry, reason: "restated_item" });
      continue;
    }

    // 入れ替わった相手は**書かれていれば添えるだけ**（`readOrderPartner`）。
    // 落とす判定には使わない（作者の判断、2026-09-25「拾う方」）
    const partner =
      kind === "順序の食い違い"
        ? readOrderPartner(entry, input, plotLine)
        : NO_PARTNER;
    // 同じ組み合わせを二度並べても、作者の判断は増えない。
    // **相手が分かっていれば、同じ2行の組は向きを問わず1件**——
    // 「AがBより前」と「BがAより後」は同じ入れ替わりを言っている
    const key =
      partner.swappedPlotLine !== null && plotLine !== null
        ? `順序:${[plotLine, partner.swappedPlotLine]
            .sort((a, b) => a - b)
            .join("-")}`
        : `${plotLine ?? ""}:${line ?? ""}:${kind}`;

    if (seen.has(key)) {
      rejected.push({ raw: entry, reason: "duplicate" });
      continue;
    }
    if (accepted.length >= input.maxFindings) {
      rejected.push({ raw: entry, reason: "over_budget" });
      continue;
    }
    seen.add(key);
    accepted.push({
      kind,
      plotItem,
      plotLine,
      excerpt,
      line,
      ...partner,
      reason,
    });
  }

  return { accepted, rejected };
}

/**
 * 引用を本文の中に見つける。見つからなければ捨てる理由を返す。
 *
 * 照合の本体の引用と、順序の相手の引用とで**同じ物差しを当てる**ために
 * 1か所にまとめてある（片方だけ長さの上限を忘れる、ということを起こさない）。
 */
function locateGroundedExcerpt(
  text: string,
  excerpt: string
):
  | { line: number; excerpt: string }
  | "excerpt_too_long"
  | "excerpt_not_found" {
  // **段落をまるごと写してくる。** それは引用ではない（P-11と同じ）
  if (excerpt.length > MAX_EXCERPT_CHARS) return "excerpt_too_long";
  // **本文に無い文を引いてくる。** 箇条書きの側の文をそのまま
  // 「本文にこうある」と言うことがある（矛盾検知で実際に起きた）
  const line = lineOfExcerpt(text, excerpt);
  if (line !== null) return { line, excerpt };
  // **台詞の途中から引いて、頭に「「」を足してくる**（1.2 の答えで e4b の
  // 「本文に無い引用」7件中7件、26b の8件中4件）。かっこの内側が本文に
  // そのままあれば、外した形を引用として残す（作者に本文に無い字を読ませない）
  const unquoted = excerpt.replace(/^[「『]+|[」』]+$/gu, "");
  if (unquoted === excerpt || normalizeForComparison(unquoted).length < 4) {
    return "excerpt_not_found";
  }
  const unquotedLine = lineOfExcerpt(text, unquoted);
  return unquotedLine === null
    ? "excerpt_not_found"
    : { line: unquotedLine, excerpt: unquoted };
}

/**
 * 「順序の食い違い」の、入れ替わった相手（任意の欄）を読む。
 *
 * **書かれていれば添えるだけで、落とす判定には使わない**（作者の判断、
 * 2026-09-25「拾う方」）。1.1 では相手を必須にして前後が本当に逆のときだけ
 * 通したが、対照の誤検出が消えた代わりに、本物の入れ替えを拾う数が落ちた
 * （26b 15/19 → 12/19、e4b 7/19 → 1/19）。誤検出は残ってよいから、拾う方を取る。
 *
 * プロンプト（1.2＝1.0 の文面）は相手の欄を尋ねない。別のモデルや MCP の道で
 * 書かれてきたときに、提案パネルへ「入れ替わった相手」を出せるように読む。
 * 相手の行が箇条書きに無い・自分の行と同じ・引用が本文に無いときは、
 * **相手が無いものとして扱う**（指摘そのものは残す）。
 */
function readOrderPartner(
  entry: Record<string, unknown>,
  input: { items: readonly EpisodePlotItem[]; text: string },
  selfPlotLine: number | null
): Pick<
  EpisodePlotContrastFinding,
  "swappedItem" | "swappedPlotLine" | "swappedExcerpt" | "swappedLine"
> {
  const rawPartner = usableOrEmpty(asString(entry.swappedItem));
  if (!rawPartner) return NO_PARTNER;
  const partner = matchPlotItem(rawPartner, input.items);
  // 自分自身を相手にしたものは、行の前後ではない（1つの行の中の順番）
  if (!partner || partner.line === selfPlotLine) return NO_PARTNER;

  const rawPartnerExcerpt = usableOrEmpty(asString(entry.swappedExcerpt));
  const located = rawPartnerExcerpt
    ? locateGroundedExcerpt(input.text, rawPartnerExcerpt)
    : null;
  const grounded = located !== null && typeof located !== "string";
  return {
    swappedItem: partner.text,
    swappedPlotLine: partner.line,
    // 本文に無い引用は添えない（作者に存在しない文を読ませない）
    swappedExcerpt: grounded ? located.excerpt : null,
    swappedLine: grounded ? located.line : null,
  };
}

/**
 * 「起きていない」出来事に、別の種別の札を付けた答えか。
 *
 * 実機確認（2026-09-25 深夜、gemma4:e4b）で、仕込んだ「起きない出来事」に
 * 「順序の食い違い」を付け、**引用は null、理由は「記述は見当たらない」**と
 * 書いてきた（第1・4・7・14話）。1.1 の測定では gemma4:26b が同じ出来事に
 * **「箇条書きに無い」**を付けて同じ形で返した（第3・14話。plotItem に足した行、
 * 理由は「記述が本文にないため」）。どちらも中身は「起きていない」の指摘である。
 * 相手が無いと落とす・札のまま出すと、**仕込みの見逃しが増える**ので付け替える。
 * （1.3 で「起きていない」は「出来事の欠落」へ名前を替えた。付け替え先もそちら。
 * 1.3 で足した「主筋の改変」も、引用が空で「無い」と言い切っていれば付け替える
 * ——場面が無いなら、違う方向へ進んだのではなく起きていない）
 *
 * 付け替えるのは、**箇条書きの行を指し、引用が空で、理由が「無い」と
 * 言い切っている**ときだけ。
 *   - 引用があるときは付け替えない。本文に場面を指しておきながら
 *     「起きていない」とは言えない
 *   - 行を指していなければ付け替えない。何が起きていないのか分からない
 *   - 理由が「無い」と言っていなければ付け替えない（前後の話をして
 *     引用を書き忘れただけかもしれない）
 */
function isMislabeledAbsence(
  kind: EpisodePlotContrastKind,
  plotItem: string,
  excerpt: string,
  reason: string
): boolean {
  return (
    kind !== "出来事の欠落" &&
    Boolean(plotItem) &&
    !excerpt &&
    ABSENCE_PATTERN.test(reason)
  );
}

/**
 * 箇条書きの行を、箇条書きの欄ではなく**引用の欄**に写してきた「無い」の指摘か。
 * そうなら、写してきた文を返す（箇条書きの欄へ移すため）。
 *
 * 2026-09-25 の測定（gemma4:26b・仕込みの第1話。1.0 から毎回同じ形）で、
 * 足した出来事「ギルド長が突然辞任を発表し、ホンゴーが後任に指名される」を
 * `excerpt` に写し、`plotItem` は null、kind は「箇条書きに無い」、理由は
 * 「〜場面が本文に存在しないため」と返した。引用が本文に無いので落ち、
 * 仕込みを見逃していた。
 *
 * 移すのは、次の4つが揃うときだけ。
 *   - 箇条書きの欄が空（両方埋まっていれば、どちらかを推し量らない）
 *   - 引用が箇条書きの行に当たる（`matchPlotItem`。写し方の揺れは許す）
 *   - 引用が本文には無い（本文にもあるなら、本当に本文の引用である）
 *   - 理由が「無い」と言い切っている（`ABSENCE_PATTERN`。言っていなければ、
 *     行を写し間違えただけかもしれない）
 *
 * 札は問わない（「箇条書きに無い」でも「出来事の欠落」でも中身は同じ）。
 * 付け替えそのものは `isMislabeledAbsence` が行う。
 */
function bulletCopiedAsExcerpt(
  plotItem: string,
  excerpt: string,
  reason: string,
  input: { items: readonly EpisodePlotItem[]; text: string }
): string | undefined {
  if (plotItem || !excerpt) return undefined;
  if (!ABSENCE_PATTERN.test(reason)) return undefined;
  if (!matchPlotItem(excerpt, input.items)) return undefined;
  if (lineOfExcerpt(input.text, excerpt) !== null) return undefined;
  return excerpt;
}

/**
 * 箇条書きの欄に行を書き、**引用の欄にも同じ行を写してきた**答えか。
 *
 * 2026-09-26 の逸脱の測り直し（さくら Kimi-K2.6、教科書チートの写しの第3話）で、
 * 助ける人を入れ替えた行に「主筋の改変」を付け、理由も正しく言い当てていたのに、
 * 引用の欄にその行を写したせいで「本文に無い引用」として落ちた。**行は指せている**
 * ので、写しただけの引用を外して指摘は残す（作者に本文に無い字は読ませない）。
 *
 * 外すのは、引用が本文に無く、**箇条書きの欄と同じ行に当たる**ときだけ。
 * 別の行に当たる引用は、どちらを言いたいのか推し量れないのでこれまでどおり捨てる。
 */
function sameBulletInBoth(
  plotItem: string,
  excerpt: string,
  input: { items: readonly EpisodePlotItem[]; text: string }
): boolean {
  if (!plotItem || !excerpt) return false;
  if (lineOfExcerpt(input.text, excerpt) !== null) return false;
  const item = matchPlotItem(plotItem, input.items);
  const copied = matchPlotItem(excerpt, input.items);
  return item !== undefined && copied !== undefined && item.line === copied.line;
}

/**
 * 本文に「無い」と言い切った形。
 *
 * 実物の言い回し：「記述は見当たらない」「確認できない」「記述がない」
 * 「記述が本文にないため」。疑問の形（「見当たらないか」）は言い切りではないので外す。
 */
const ABSENCE_PATTERN =
  /(見当たら(ない|ず|ぬ|ません)|確認でき(ない|ず|ません)|(記述|描写|言及|場面)(は|が|も)?(本文中?(に|では)(は|も)?)?(ない|無い|なく|無く|ありません|存在しない)|(描かれ|書かれ|触れられ)て(いない|おらず|いません))(?!の?か)/;

/**
 * 「順序（流れ）は箇条書きと一致している」と**言い切った**形。
 *
 * 実機確認（2026-09-25 深夜、gemma4:e4b・ギルドの19話）で、箇条書きどおりに
 * 書いた話に「順序の食い違い」を挙げ、理由に「**順序は合致しているが**、本文の
 * 描写がより詳細」「メアリーからの誘いと断りの**流れは本文の描写と一致している**」
 * と書いてきた。配列があると何か埋めようとする型である（矛盾検知の
 * `self_denied` と同じ）。
 *
 * **網は絞る。** 矛盾検知では「一致して**いるか**確認が必要」（疑問）や
 * 「文体が一致して**いるため**、誤記の可能性が高い」（理由）まで打ち消しと読み、
 * 仕込みの正解を落とした（0.86.1 で直した。縛りの洗い出し1番）。
 * ここでも疑問・理由の形（か・ため・ので・から）は打ち消しと読まない。
 * 主語も「順序・順番・並び・流れ」に限る——「描写が一致している」だけでは、
 * 何が一致しているのか分からない。
 *
 * **「順序の食い違い」の指摘にだけ当てる。** 「箇条書きに無い」の理由で
 * 「順序は合っているが、この場面は箇条書きに無い」と書くのは、打ち消しではない。
 */
const ORDER_DENIAL_PATTERN =
  /(順序|順番|並び|流れ)(は|も|が)?[^。．！!？?\n]{0,30}?((合致|一致)して(いる|います|おり)|(とおり|通り|どおり)(だ|です|で(ある|あり)|に(進|描かれ|な)))(?!の?か|ため|ので|から)/;

/**
 * 「食い違いはない」と言い切った形。どの種別でも、自分の指摘の打ち消しである。
 *
 * 「ずれ」「入れ替わり」は入れない——「起きていない」の理由で「本文では
 * 二人の入れ替わりはない」と書けば、それは本物の指摘（箇条書きの出来事が
 * 起きていない）になる。
 */
const CONTRAST_DENIAL_PATTERN =
  /食い違い(は|が)?(特に)?(ない|なく|ありませ|見られ(ない|ませ|ず)|見当たら(ない|ず))/;

/**
 * 入れ替わっていると**言い切っている**部分。打ち消しの言葉が混ざっていても、
 * これがあれば本物の指摘として残す（矛盾検知の `AFFIRMATION_PATTERN` と同じ歯止め。
 * 「前半の順序は合致しているが、後半は箇条書きと逆になっている」を落とさない）。
 */
const ORDER_AFFIRMATION_PATTERN =
  /(逆|反対)(に|の順|の並び)|入れ替わって(いる|います|おり)(?!の?か)|(順序|順番|並び)(が|は)?[^。．！!？?\n]{0,20}?(異な(る|り|って)|違って|違う)(?!の?か)|食い違って(いる|います|おり)(?!の?か)|より(も)?(前|先)に(描かれ|起き|来|置かれ)/;

/**
 * 「結果（結末・決断・筋）は箇条書きどおり」と**言い切った**形（「主筋の改変」の打ち消し）。
 *
 * 順序の網（`ORDER_DENIAL_PATTERN`）と同じ作り。箇条書きどおりの話に順序の
 * 指摘を挙げて「順序は合致しているが」と書いてきた型が、1.3 で足した
 * 「主筋の改変」でも起きる前提で置く（配列があると何か埋めようとする）。
 * 疑問・理由の形（か・ため・ので・から）は打ち消しと読まない（0.86.1 の教訓）。
 * **「主筋の改変」の指摘にだけ当てる。**
 */
const CHANGE_DENIAL_PATTERN =
  /(結果|結末|決断|結論|筋|方向)(は|も|が)?[^。．！!？?\n]{0,30}?((合致|一致)して(いる|います|おり)|(とおり|通り|どおり)(だ|です|で(ある|あり)|に(進|描かれ|な))|同じ(だ|です|で(ある|あり)))(?!の?か|ため|ので|から)/;

/**
 * 違う方向へ進んでいると**言い切っている**部分。打ち消しの言葉が混ざっていても
 * 残す（「前半の結果は箇条書きどおりだが、最後の決断は逆になっている」を落とさない）。
 */
const CHANGE_AFFIRMATION_PATTERN =
  /(逆|反対)(に|の|だ|で|と)|異な(る|り|って)(?!の?か)|違(う|って)(方向|結果|結末|決断|いる|います|おり)(?!の?か)|食い違って(いる|います|おり)(?!の?か)/;

/**
 * 理由の中で、自分の指摘を打ち消しているか（P-28）。
 *
 * 種別ごとに見る。順序の網は「順序の食い違い」にだけ、結果の網は
 * 「主筋の改変」にだけ当て、「食い違いはない」の網はどの種別にも当てる。
 */
export function deniesOwnContrast(
  kind: EpisodePlotContrastKind,
  reason: string
): boolean {
  if (ORDER_AFFIRMATION_PATTERN.test(reason)) return false;
  if (kind === "主筋の改変" && CHANGE_AFFIRMATION_PATTERN.test(reason)) {
    return false;
  }
  if (CONTRAST_DENIAL_PATTERN.test(reason)) return true;
  if (kind === "順序の食い違い") return ORDER_DENIAL_PATTERN.test(reason);
  if (kind === "主筋の改変") return CHANGE_DENIAL_PATTERN.test(reason);
  return false;
}

/**
 * 「主筋の改変」の理由が、**箇条書きの筋を言い直しただけ**か（P-28）。
 *
 * 実機確認 3巡目（2026-09-25 午後、gemma4:e4b・ハイエルフ未亡人の写し）で、
 * あらすじどおりの第14話に「主筋の改変」を2件挙げ、理由は「本文では、子供たちから
 * 金を貸してほしいと懇願され、アジャーノが突き放す流れになっている」——箇条書きの
 * 次の行を言い直しただけで、**逆になった結果・決断を一言も言っていない**。
 * 打ち消しの網（`CHANGE_DENIAL_PATTERN`）は「箇条書きどおり」と言い切った形だけを
 * 落とすので、この形はすり抜ける。
 *
 * **逆を言っている手がかりが1つも無く、箇条書きと言葉が重なる**ときだけ落とす。
 * 手がかりは、本物の改変（結果を逆にした仕込み）で当たった答えの実物から集めた：
 *   - 「逆」「異なる」などの言い切り（`CHANGE_AFFIRMATION_PATTERN`）
 *   - 「〜ではなく」「〜でなく」
 *   - 「箇条書きでは〜が、本文では〜」の対比（26b の大半がこの形）
 *   - 「無い」の言い切り（`ABSENCE_PATTERN`。欠落の札の貼り違いで、言い直しではない）
 *   - 理由か箇条書きの行のどちらかに打ち消し（「断らずに引き受けている」
 *     「戦わずに逃げ出し」）。行の側を見るのは、e4b が「本文では、アジャーノは
 *     沼ワニと戦い」とだけ書いて、逆であることを言葉にしないため
 *   - 決断の語の対（行に「断る」・理由に「同意」、行に「受ける」・理由に「断り」）。
 *     行に同じ側の語もあるときは効かせない（「拒否して」の言い直しを拾わない）
 *
 * **拾う方に倒してある**（作者の判断、2026-09-25「本物を落とさないのが優先」）。
 * 手がかりの網は広めで、言い直しでも「〜ではなく」を含めば残る。測った数
 * （同じ網を実物の答えに当てた）：3巡目は仕込みの当たり 12/12 を残して言い直し
 * 4/6 を落とし、ギルドの 1.3 は 24/24 を残して 4/12、捨てた 1.3a の文面の答え
 * では 32/32 を残して 40/87。
 *
 * かぎかっこの中は本文の写しなので、手がかりを探す前に外す（台詞の「〜ねぇだろ」の
 * 打ち消しを、理由の打ち消しと読まない）。
 */
function restatesPlotWithoutReversal(
  reason: string,
  plotItem: string,
  items: readonly EpisodePlotItem[]
): boolean {
  const said = withoutQuotations(reason);
  const item = withoutQuotations(plotItem);
  if (CHANGE_AFFIRMATION_PATTERN.test(said)) return false;
  if (NOT_BUT_PATTERN.test(said)) return false;
  if (PLOT_VERSUS_TEXT_PATTERN.test(said)) return false;
  if (ABSENCE_PATTERN.test(said)) return false;
  if (NEGATION_PATTERN.test(said) || NEGATION_PATTERN.test(item)) return false;
  if (opposesDecision(said, item)) return false;
  // 箇条書きと言葉が1つも重ならない理由は、言い直しではない（何か別のことを
  // 言っている）。「結果が箇条書きどおりか、確かめる必要がある」のような疑問の形が
  // これに当たり、打ち消しの網でも疑問の形は落とさない（0.86.1 の教訓）
  return sharesPlotWords(said, items);
}

/** 「〜ではなく」「〜でなく」。対比の言い切り */
const NOT_BUT_PATTERN = /(で|に)は?なく/;

/**
 * 「箇条書きでは〜が、本文では〜」の対比。
 * 「箇条書きでは対峙するだけで、本文では〜が深まっている」（e4b の実物）は、
 * 逆接（が・のに・けど・ものの）が無いので対比と読まない——細部が詳しいと
 * 言っているだけで、結果は逆になっていない。
 */
const PLOT_VERSUS_TEXT_PATTERN =
  /(箇条書き|プロット)[^。．\n]*?(が|のに|けど|けれど|ものの|一方|に対し(て)?)[、，,]?\s*(本文|実際)/;

/**
 * 打ち消し（〜ず・〜ない・〜なかった・〜ません）。
 * 「まず」「必ず」「わずか」「ずっと」は打ち消しではないので外す。
 */
const NEGATION_PATTERN = /(?<![ま必わ])ず(?![っかつ])|ない|なかっ|ません/;

/** 決断の語のうち、断る側 */
const REFUSAL_PATTERN = /断|拒|見送|諦|あきらめ|取り逃/;
/** 決断の語のうち、受ける側 */
const ACCEPTANCE_PATTERN = /引き受|受け入|承諾|認め|応じ|同意|サイン|署名|快諾|誘いを受/;

/**
 * 箇条書きの行と理由とで、決断が逆の側にあるか。
 * 行に同じ側の語もあるときは逆と読まない（「拒否して〜促すと」の行に「拒否し」の理由）。
 */
function opposesDecision(said: string, item: string): boolean {
  const saysRefuse = REFUSAL_PATTERN.test(said);
  const saysAccept = ACCEPTANCE_PATTERN.test(said);
  const itemRefuse = REFUSAL_PATTERN.test(item);
  const itemAccept = ACCEPTANCE_PATTERN.test(item);
  return (
    (saysRefuse && itemAccept && !itemRefuse) ||
    (saysAccept && itemRefuse && !itemAccept)
  );
}

/** かぎかっこの中（本文や箇条書きの写し）を外す */
function withoutQuotations(text: string): string {
  return text.replace(/「[^」]*」|『[^』]*』/gu, "");
}

/**
 * 理由の漢字・カタカナの2字が、箇条書きのどれかの行に現れるか。
 * 言い直しは箇条書きのどの行でもあり得る（第14話は、指した行の**次の行**を言い直した）
 * ので、全部の行と比べる。
 */
function sharesPlotWords(
  said: string,
  items: readonly EpisodePlotItem[]
): boolean {
  const plan = items.map((item) => item.text).join("\n");
  for (const run of said.match(/[一-龥々ァ-ヶー]{2,}/gu) ?? []) {
    for (let i = 0; i + 2 <= run.length; i++) {
      if (plan.includes(run.slice(i, i + 2))) return true;
    }
  }
  return false;
}

// ── 共通の小物 ───────────────────────────────────

function findingsOf(raw: unknown): unknown[] {
  return isRecord(raw) && Array.isArray(raw.findings) ? raw.findings : [];
}

/**
 * 選択肢を写して返されても拾う（矛盾検知・推敲・逸脱と同じ）。
 *
 * 「停滞・重複（同じ場面が続く）」のように、説明を添えて返してくる。
 */
function normalizeKind<T extends string>(
  raw: string,
  kinds: readonly T[]
): T | undefined {
  const trimmed = raw.trim();
  const exact = kinds.find((kind) => kind === trimmed);
  if (exact) return exact;
  const starts = kinds.find((kind) => trimmed.startsWith(kind));
  if (starts) return starts;
  return kinds.find((kind) => trimmed.includes(kind));
}

/**
 * P-28 の種別を読む。**1.2 までの名前（「起きていない」）も今の種別として読む。**
 *
 * 1.3 で「起きていない」を「出来事の欠落」へ名前を替えた（同じ観点。
 * プロンプト設計書 P-28）。指示文から消しても前の言い方で返ってくることがあり、
 * 知らない種別として捨てると、本物の欠落を見逃す。
 */
function normalizeContrastKind(
  raw: string
): EpisodePlotContrastKind | undefined {
  const current = normalizeKind(raw, EPISODE_PLOT_CONTRAST_KINDS);
  if (current) return current;
  const trimmed = raw.trim();
  const alias = Object.keys(EPISODE_PLOT_CONTRAST_KIND_ALIASES).find((old) =>
    trimmed.includes(old)
  );
  return alias ? EPISODE_PLOT_CONTRAST_KIND_ALIASES[alias] : undefined;
}

/**
 * 中身のつもりで書かれた「中身が無い」言葉か。
 *
 * 2種類ある。**どちらも実データで返ってきた形である**（章立ての提案の
 * `isEmptyAnswer` と同じ作り）。
 *
 *   1. 「該当なし」「空文字」のような、中身が無いことを表す言葉
 *   2. **プロンプトの出力例に書いた言い換えそのもの**
 *
 * **2は「丸ごと同じ」ときだけ弾く。** 部分一致で見ると、正当な理由文まで
 * 空扱いになる。
 */
function isEmptyAnswer(text: string, hints: readonly string[]): boolean {
  if (!text.trim()) return true;
  if (isPlaceholderText(text)) return true;
  const body = normalizeForHintMatch(text);
  if (!body) return true;
  return hints.some((hint) => body === normalizeForHintMatch(hint));
}

/** 中身の無い言葉なら空にする（「該当なし」を指し先として扱わない） */
function usableOrEmpty(text: string): string {
  return !text || isPlaceholderText(text) ? "" : text;
}

/**
 * 句読点・かっこ・空白を落とす（ヒント語との照合用）。
 *
 * AIは指示の言葉を返すとき、かっこや読点を添えてくる（`（そう言える理由）`）。
 * **言葉そのものは同じ**なので、これらを落としてから比べる。
 */
function normalizeForHintMatch(text: string): string {
  return text
    .replace(/\s+/gu, "")
    .replace(
      /[、。，．,.:：;；!！?？「」『』（）()〔〕【】《》〈〉[\]{}｛｝“”"'’‘]/gu,
      ""
    );
}

function asString(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractBraces(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}
