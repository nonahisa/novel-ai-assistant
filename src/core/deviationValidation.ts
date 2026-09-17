import { normalizeForComparison } from "./groundedEvidence";
import {
  deviationBudget,
  DEVIATION_TYPES,
  type DeviationType,
} from "../prompts/deviationCheck";

/**
 * プロット逸脱・間延びの指摘の検証（設計書6.10.2）。
 *
 * **今日ここまでで2度同じ失敗をしている**（矛盾検知・推敲）。
 * どちらも「AIが材料側の文を引いて本文だと言う」「許した札に禁じた中身を
 * 入れる」だった。**最初から同じ手当てを入れる。**
 *
 * この機能に固有の危うさは、**照らし合わせた先が実在しないこと**である。
 * 「プロットの『主人公の成長』と照らして…」と言われても、プロットに
 * そんな項目が無ければ、その指摘は根拠を持たない。
 * `plotReference` がプロットに実在するかを確かめる。
 *
 * VS Code APIに依存しない。
 */

export interface AcceptedDeviation {
  lineStart: number;
  lineEnd: number;
  excerpt: string;
  type: DeviationType;
  reason: string;
  plotReference: string;
  severity: "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
}

export interface RejectedDeviation {
  raw: unknown;
  reason:
    | "shape"
    | "line_out_of_range"
    | "excerpt_not_found"
    | "unknown_type"
    /** 照らしたプロットの語句が、プロットに無い */
    | "plot_reference_not_found"
    /** 件数の上限を超えた */
    | "over_budget"
    /** 引用が長すぎる（段落をまるごと写している） */
    | "excerpt_too_long"
    /** 理由が「これは逸脱ではない」と言っている */
    | "self_denied";
}

const LEVELS = new Set(["high", "medium", "low"]);
const TYPE_SET = new Set<string>(DEVIATION_TYPES);

/**
 * 引用の長さの上限。
 *
 * プロンプトでは30字以内と言っているが、**実データで数百字の塊を
 * 返してきた**（第9話。段落をまるごと写していた）。
 * それは引用ではなく、どこを指しているのか分からない。
 *
 * **単話プロットの検証（`episodePlotValidation.ts`）も同じ値を使う。**
 * 以前は同名の定数を2つ持っていた（設計書6.77の第2段で寄せた）。
 * どちらもAIが本文から写した引用の長さで、同じ理由で同じ線を引いている。
 */
export const MAX_EXCERPT_CHARS = 80;

/**
 * 「これは逸脱ではない」と**言い切っている**言い回し。
 * 打ち消しの形そのものなので、後ろに「ない」が来ても打ち消しとは見ない。
 */
const DENIED_OUTRIGHT =
  /(逸脱で(は)?(あり)?(ませ|ない)|問題(は)?(あり)?(ませ|ない))/;

/**
 * 「プロットどおりだ」と**肯定で**書いている言い回し。
 * 「沿っていません」のように打ち消されていれば、それは逸脱の指摘である。
 */
const AGREES_WITH_PLOT = /(カバーして|網羅して|沿って(い|お)|一致して)/;

/**
 * 「逸脱ではない正当な狙い」として説明している言い回し。
 *
 * プロンプト（P-11）が「伏線・掘り下げ・テーマの補強・背景の説明は逸脱では
 * ない」と言っているので、AIはこの言葉をそのまま使って返してくる。
 *
 * **語が出たことだけでは落とさない。** 以前は「伏線」という語が理由文に
 * 現れただけで弾いており、**「意図的な伏線かどうかの確認が必要です」まで
 * 落としていた**（2026-09-18 の測定で gemma4:12b が 0/3 になった原因の1つ）。
 * AIは作者に確かめてほしいと言っただけで、自分では否定していない。
 * そこで**「〜として」「〜である」のように、その狙いだと決めつけている形**
 * のときだけ否定と読む。「伏線が回収されていません」は通る。
 */
const LEGITIMATE_PURPOSE =
  /(伏線|掘り下げ|補強|背景(の)?説明|描写)(として|である|です|だと|と(考え|見な|思わ|判断|解釈|捉え))/;

/**
 * 作者に判断を預けている言い回し（問いかけ・保留）。
 *
 * **これが混じっていたら、AIは否定していない。** 「意図的な伏線かどうか」
 * 「確認が必要です」は、逸脱かどうかを作者に決めてほしいという意味であって、
 * 自分で「逸脱ではない」と言ったのではない。
 *
 * 「〜の可能性があります」は**入れていない**。「描写として追加された可能性が
 * あります」のように、柔らかく言っているだけで中身は否定、という形が
 * 実データで出ているため（2026-08-30 の測定）。
 */
const DEFERS_TO_AUTHOR =
  /(かどうか|か否か|かもしれ|確認が必要|確認をお|要確認|ご確認|確認して|確かめ|検討が必要|判断が(難し|つ)|判断(でき|し(かね|きれ))|判断を(委ね|お願い)|意図的か|不明で|(分|わ)かりませ)/;

/** 肯定の言い回しが、すぐ後ろで打ち消されているか */
const NEGATED_AFTER = /^.{0,12}?(ない|ませ|ぬ)/su;

/**
 * 「これは逸脱ではない」と自分で書いている指摘を見分ける。
 *
 * **実データで返ってきた。**「プロットの…事象自体は**カバーしています**」
 * と書きながら指摘として並べる。矛盾検知で「矛盾していません」を弾いたのと
 * 同じことが、ここでも起きる。
 *
 * **落としすぎるほうが害が大きい**（作者の裁定、2026-09-18）。誤検出は測って
 * 0だったのに、小さいモデルほどここで全部落ちていた。迷ったら通す。
 */
export function deniesDeviation(reason: string): boolean {
  // 作者へ預けている一言がどこかに在れば、その指摘は否定ではない。
  // 節ごとに見るより緩いが、「迷ったら通す」側へ倒すためにこうしている
  if (DEFERS_TO_AUTHOR.test(reason)) return false;

  // 「AはプロットB、しかしCは逸脱」のように向きが混ざるので、節ごとに見る
  for (const clause of reason.split(/[。、．，\n！？!?]+/u)) {
    if (DENIED_OUTRIGHT.test(clause)) return true;
    if (assertsWithout(clause, AGREES_WITH_PLOT)) return true;
    if (assertsWithout(clause, LEGITIMATE_PURPOSE)) return true;
  }
  return false;
}

/** その言い回しが節に在り、かつ打ち消されていないか */
function assertsWithout(clause: string, pattern: RegExp): boolean {
  const match = pattern.exec(clause);
  if (!match) return false;
  return !NEGATED_AFTER.test(clause.slice(match.index + match[0].length));
}

/**
 * 照合用の正規化。空白に加えて**約物も落とす**。
 *
 * 読点ひとつ、鉤括弧ひとつの違いで根拠が消えるのを防ぐ。
 */
function normalizeForPlotMatch(text: string): string {
  return normalizeForComparison(text).replace(
    /[、。，．・…「」『』（）()〈〉《》【】\[\]"'“”‘’!?！？:：;；]/gu,
    ""
  );
}

/**
 * 言い換えを許す下限。**引用の7割が、プロットの同じあたりに在れば通す。**
 *
 * 「町はずれの家を**訪れ**」と「町はずれの家を**訪ね**」で 0.91。
 * まったく別の文は 0.1 前後にしかならない（テストで固定してある）。
 */
export const PLOT_REFERENCE_MATCH_RATIO = 0.7;

/**
 * 言い換えとして扱う最短の長さ。
 *
 * 短い語は、たまたま重なっただけで通ってしまう。短いものは今までどおり
 * 逐語一致か見出し名でしか認めない。
 */
const MIN_PARAPHRASE_CHARS = 8;

/**
 * 照らした先が、プロットに実在するか。
 *
 * **無いものを引いて指摘してくる。** 矛盾検知では設定資料の文を、
 * 推敲では言い換えた「原文」を引いてきた。ここでも同じことが起きうる。
 *
 * ただし**語句そのままとは限らない**（プロットの「あらすじ」節を指して
 * 「あらすじ」と書くなど）。**見出しの名前も実在として認める。**
 *
 * さらに**一文字の言い換えも認める**（作者の裁定、2026-09-18）。
 * 「町はずれの家を**訪れ**」と書いたせいで、プロットの「**訪ね**」に届かず
 * 場所を当てていた指摘が2件とも消えた。丸写しを求めるのは厳しすぎる。
 * でっち上げは重なりが低いので、これでも落ちる。
 */
export function referencesPlot(plotReference: string, plot: string): boolean {
  const reference = normalizeForPlotMatch(plotReference);
  if (!reference) return false;
  const normalizedPlot = normalizeForPlotMatch(plot);
  if (normalizedPlot.includes(reference)) return true;

  // 「## あらすじ」のような見出しを指しているだけの場合も通す。
  // 引用ではないが、照らした先としては特定できている
  const headings = [...plot.matchAll(/^#{1,6}\s*(.+?)\s*$/gm)].map((match) =>
    normalizeForPlotMatch(match[1])
  );
  if (
    headings.some(
      (heading) =>
        heading && (reference.includes(heading) || heading === reference)
    )
  ) {
    return true;
  }

  if (reference.length < MIN_PARAPHRASE_CHARS) return false;
  return bestPlotOverlap(reference, plot) >= PLOT_REFERENCE_MATCH_RATIO;
}

/**
 * 引用とプロットの、いちばん重なっている場所の割合を返す。
 *
 * **プロット全体とまとめて比べない。** 全体と比べると、あちこちから2文字ずつ
 * 拾い集めただけの文が通ってしまう。プロットを文で切り、引用と同じくらいの
 * 長さの窓（引用の2倍まで）に区切って、その中での重なりを見る。
 */
function bestPlotOverlap(reference: string, plot: string): number {
  const bigrams = bigramsOf(reference);
  if (bigrams.length === 0) return 0;

  const pieces = plot
    .split(/[。\n]+/u)
    .map(normalizeForPlotMatch)
    .filter((piece) => piece.length > 0);
  const limit = reference.length * 2;

  let best = 0;
  for (let start = 0; start < pieces.length; start += 1) {
    let window = "";
    for (let end = start; end < pieces.length; end += 1) {
      window += pieces[end];
      const hits = bigrams.filter((bigram) => window.includes(bigram)).length;
      best = Math.max(best, hits / bigrams.length);
      if (window.length >= limit) break;
    }
  }
  return best;
}

/** 2文字ずつに切り出す（重複は除く） */
function bigramsOf(text: string): string[] {
  const found = new Set<string>();
  for (let index = 0; index + 1 < text.length; index += 1) {
    found.add(text.slice(index, index + 2));
  }
  return [...found];
}

export function parseDeviationResult(
  text: string
): { deviations: unknown[] } | null {
  const attempts = [
    text,
    text.replace(/^[\s\S]*?```(?:json)?\s*/i, "").replace(/```[\s\S]*$/, ""),
    extractBraces(text),
  ];

  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate.trim());
      if (isRecord(parsed) && Array.isArray(parsed.deviations)) {
        return { deviations: parsed.deviations };
      }
    } catch {
      // 次の候補を試す
    }
  }
  return null;
}

export function validateDeviations(
  raw: unknown,
  episode: { text: string; plot: string }
): { accepted: AcceptedDeviation[]; rejected: RejectedDeviation[] } {
  const accepted: AcceptedDeviation[] = [];
  const rejected: RejectedDeviation[] = [];

  const list =
    isRecord(raw) && Array.isArray(raw.deviations) ? raw.deviations : [];
  const normalizedText = normalizeForComparison(episode.text);
  const lastLine = episode.text.split("\n").length;

  const passed: AcceptedDeviation[] = [];
  for (const item of list) {
    if (!isRecord(item)) {
      rejected.push({ raw: item, reason: "shape" });
      continue;
    }

    const excerpt = asString(item.excerpt);
    const reason = asString(item.reason);
    const plotReference = asString(item.plotReference);
    const type = normalizeType(asString(item.type));
    const lineStart =
      typeof item.lineStart === "number" ? Math.round(item.lineStart) : NaN;
    const lineEndRaw =
      typeof item.lineEnd === "number" ? Math.round(item.lineEnd) : NaN;

    if (!excerpt || !reason || !Number.isFinite(lineStart)) {
      rejected.push({ raw: item, reason: "shape" });
      continue;
    }
    if (!type) {
      rejected.push({ raw: item, reason: "unknown_type" });
      continue;
    }
    // **段落をまるごと写してくる。** それは引用ではなく、
    // どこを指しているのか分からない
    if (excerpt.length > MAX_EXCERPT_CHARS) {
      rejected.push({ raw: item, reason: "excerpt_too_long" });
      continue;
    }
    // **「これは逸脱ではない」と自分で書いているものを通さない**
    if (deniesDeviation(reason)) {
      rejected.push({ raw: item, reason: "self_denied" });
      continue;
    }
    if (lineStart < 1 || lineStart > lastLine) {
      rejected.push({ raw: item, reason: "line_out_of_range" });
      continue;
    }
    // **引用が本文に実在するかを見る。** プロットの文をそのまま引いて
    // 「本文にこうある」と言うことがある（矛盾検知で実際に起きた）
    if (!normalizedText.includes(normalizeForComparison(excerpt))) {
      rejected.push({ raw: item, reason: "excerpt_not_found" });
      continue;
    }
    // **照らした先がプロットに無ければ、その指摘は根拠を持たない**
    if (!referencesPlot(plotReference, episode.plot)) {
      rejected.push({ raw: item, reason: "plot_reference_not_found" });
      continue;
    }

    // 終わりの行が読めない・逆さまなら、始まりの行だけを指す
    const lineEnd =
      Number.isFinite(lineEndRaw) && lineEndRaw >= lineStart
        ? Math.min(lineEndRaw, lastLine)
        : lineStart;

    passed.push({
      lineStart,
      lineEnd,
      excerpt,
      type,
      reason,
      plotReference,
      severity: level(item.severity),
      confidence: level(item.confidence),
    });
  }

  // **件数を切る。** 1つの話に何件も逸脱があるなら、それは
  // プロットのほうが古いか、AIが探しすぎている
  const budget = deviationBudget(episode.text.length);
  const ordered = sortDeviations(passed);
  accepted.push(...ordered.slice(0, budget));
  for (const extra of ordered.slice(budget)) {
    rejected.push({ raw: extra, reason: "over_budget" });
  }

  return { accepted, rejected };
}

/** 確信度の高いものを上に。切るときに迷っているものだけが残らないように */
export function sortDeviations(items: AcceptedDeviation[]): AcceptedDeviation[] {
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return [...items].sort((left, right) => {
    if (left.confidence !== right.confidence) {
      return rank[left.confidence] - rank[right.confidence];
    }
    if (left.severity !== right.severity) {
      return rank[left.severity] - rank[right.severity];
    }
    return left.lineStart - right.lineStart;
  });
}

/** 選択肢を写して返されても拾う（矛盾検知・推敲と同じ） */
export function normalizeType(raw: string): DeviationType | undefined {
  const trimmed = raw.trim();
  if (TYPE_SET.has(trimmed)) return trimmed as DeviationType;
  for (const candidate of DEVIATION_TYPES) {
    if (trimmed.startsWith(candidate)) return candidate;
  }
  for (const candidate of DEVIATION_TYPES) {
    if (trimmed.includes(candidate)) return candidate;
  }
  return undefined;
}

function level(raw: unknown): "high" | "medium" | "low" {
  const value = asString(raw);
  return LEVELS.has(value) ? (value as "high" | "medium" | "low") : "low";
}

function asString(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractBraces(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}
