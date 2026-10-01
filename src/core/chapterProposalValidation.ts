import { isPlaceholderText } from "./placeholderText";
import {
  CHAPTER_NAME_MAX_CHARS,
  CHAPTER_PROPOSE_HINTS,
} from "../prompts/chapterPropose";

/**
 * 章立ての提案（P-31）の応答の検証（設計書6.66.4）。
 *
 * **AIの出力を信用しない。** ここで見るのは4つ。
 *
 *   1. **開始の話数が実在するか。** 一覧に無い番号を返してくる
 *      （伏線の回収で `id` を作ってきたのと同じ形）
 *   2. **話数の小さい順に並んでいるか。** 逆行する章は、どちらが先か
 *      決められない
 *   3. **同じ話から2つの章が始まっていないか。** 台帳は同じ開始話の章を
 *      2つ持てない（`models/chapter.ts` の `assertUniqueStarts`）ので、
 *      ここで落としておかないと、承認した瞬間に保存が止まる
 *   4. **名前が中身のある言葉か。** 空と、指示の言葉そのままを弾く
 *
 * **壊れた1件だけを捨てて、残りは通す。** 章分けは作品まるごとで1回しか
 * 呼ばない（有料AIでは1回ぶん課金される）ので、1件の不備で全部を捨てると、
 * 作者はもう一度払うことになる。捨てた件数と内訳は報告に出す
 * ——**黙って減らさない。**
 *
 * VS Code APIに依存しない。
 */

export interface ChapterProposalCandidate {
  name: string;
  /** 章が始まる話数。**実在する番号だけ** */
  startEpisode: number;
  /** なぜここで区切るか。中身が無ければ空（**書いてあることにしない**） */
  reason: string;
}

export type ChapterProposalRejectReason =
  /** 形が違う（項目が無い・話数が数字でない） */
  | "shape"
  /** 名前が空、または指示の言葉がそのまま返ってきた */
  | "placeholder"
  /** 一覧に無い話数 */
  | "unknown_episode"
  /** 同じ話から始まる章が二度出た */
  | "duplicate_start"
  /** 前の章より前の話へ戻っている */
  | "out_of_order";

export interface RejectedChapterProposal {
  raw: unknown;
  reason: ChapterProposalRejectReason;
}

/**
 * 構造化出力でも前後に説明やコードフェンスが付くモデルがあるため、
 * 生のJSON、コードフェンス除去、最外の波括弧抽出の順で解析する
 * （矛盾検知・伏線検知と同じ手順）。
 */
export function parseChapterProposeResult(
  text: string
): { chapters: unknown[] } | null {
  const parsed = parseObject(text);
  if (!parsed || !Array.isArray(parsed.chapters)) return null;
  return { chapters: parsed.chapters };
}

/**
 * 章分けの提案を検証する。
 *
 * @param episodeNumbers 作品に実在する話数（順不同でよい）
 */
export function validateChapterProposal(
  raw: unknown,
  episodeNumbers: readonly number[]
): {
  accepted: ChapterProposalCandidate[];
  rejected: RejectedChapterProposal[];
} {
  const accepted: ChapterProposalCandidate[] = [];
  const rejected: RejectedChapterProposal[] = [];

  const known = new Set(episodeNumbers);
  // 直前に通した章の開始話。**通ったものだけを基準にする**——捨てた章を
  // 基準にすると、そのあとの正しい章まで「逆行している」ことになる
  let lastStart: number | null = null;
  const seen = new Set<number>();

  for (const item of chaptersOf(raw)) {
    const candidate = readCandidate(item);
    if (!candidate) {
      rejected.push({ raw: item, reason: "shape" });
      continue;
    }
    if (isEmptyAnswer(candidate.name)) {
      rejected.push({ raw: item, reason: "placeholder" });
      continue;
    }
    if (!known.has(candidate.startEpisode)) {
      rejected.push({ raw: item, reason: "unknown_episode" });
      continue;
    }
    if (seen.has(candidate.startEpisode)) {
      rejected.push({ raw: item, reason: "duplicate_start" });
      continue;
    }
    if (lastStart !== null && candidate.startEpisode < lastStart) {
      rejected.push({ raw: item, reason: "out_of_order" });
      continue;
    }

    seen.add(candidate.startEpisode);
    lastStart = candidate.startEpisode;
    accepted.push({
      name: shortenName(candidate.name),
      startEpisode: candidate.startEpisode,
      reason: usableReason(candidate.reason),
    });
  }

  return { accepted, rejected };
}

/**
 * 章名だけの提案を検証する（章ノードの右クリック、設計書6.66.4）。
 *
 * **使うのは名前だけ**なので、区切り（`startEpisode`）は「その章の範囲を
 * 指しているか」だけを見る。範囲の外を指す案は、別の章に付ける名前を
 * 出してきたということなので捨てる。
 *
 * @param episodeNumbers その章に入る話の話数
 * @param limit 出す案の数。**多すぎる選択肢は選べない**
 */
export function validateChapterNames(
  raw: unknown,
  episodeNumbers: readonly number[],
  limit: number
): { names: string[]; rejected: RejectedChapterProposal[] } {
  const names: string[] = [];
  const rejected: RejectedChapterProposal[] = [];
  const known = new Set(episodeNumbers);
  const seen = new Set<string>();

  for (const item of chaptersOf(raw)) {
    if (names.length >= limit) break;

    const candidate = readCandidate(item);
    if (!candidate) {
      rejected.push({ raw: item, reason: "shape" });
      continue;
    }
    if (isEmptyAnswer(candidate.name)) {
      rejected.push({ raw: item, reason: "placeholder" });
      continue;
    }
    if (!known.has(candidate.startEpisode)) {
      rejected.push({ raw: item, reason: "unknown_episode" });
      continue;
    }

    const name = shortenName(candidate.name);
    // 同じ名前を2つ並べても選びようがない。**捨てた扱いにはしない**
    // ——不備ではなく、案が重なっただけである
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }

  return { names, rejected };
}

/**
 * 提案の区切りが、いまの章立てとどう関わるか（作者の裁定 2026-10-01、判断 i）。
 *
 *   - `same`：既存の区切りと同じ話から始まる（承認すると改名になる）
 *   - `moved`：既存の区切りを別の話へ動かす（`fromEpisode` がいまの開始）
 *   - `new`：まだ区切りの無いところに置く
 *
 * **作者が決めた区切りを動かす提案も、落とさずに残す。** ただし動かすことが
 * 分かるように印を付ける——印が無いと、作者は「新しい章が足される」と
 * 思って承認し、自分の決めた区切りが変わったことに気づけない
 * （測定記録 2026-10-01 の不具合14）。
 */
export type ChapterBoundary =
  | { kind: "same"; existingName: string }
  | { kind: "moved"; fromEpisode: number; fromName: string }
  | { kind: "new" };

/** いまの章立ての1件。開始の話が分からない章は `startEpisode: null` */
export interface CurrentChapterStart {
  name: string;
  startEpisode: number | null;
}

/**
 * 提案の各区切りを、いまの章立てと照らして分類する。
 *
 * **判定はコードが行う**（規則3）。AIに「動かしたか」を答えさせると、
 * 動かしていても「同じ」と書いてくる余地が残る。
 *
 * 「動かした」と見なすのは、次の両方を満たす組だけである。
 *
 *   1. 既存の開始が提案に無く、提案の開始が既存に無い（どちらも相手が居ない）
 *   2. **2つの間に、残る区切り（`same`）が挟まっていない**——挟まっていれば、
 *      間の章を飛び越えて動かしたことになり、それはもう「同じ区切りの移動」
 *      ではない（新しい区切りと、消える区切りである）
 *
 * 組は**近いものから**決める。1つの既存の区切りは1つの提案の元にしかしない
 * （第100話の区切りを、第99話と第101話の2つへ同時に動かすことは無い）。
 *
 * @returns 提案と同じ順に並べた分類
 */
export function classifyChapterBoundaries(
  candidates: ReadonlyArray<{ startEpisode: number }>,
  current: readonly CurrentChapterStart[]
): ChapterBoundary[] {
  const existing = new Map<number, string>();
  for (const chapter of current) {
    // 開始の話が分からない章は、どの提案とも比べようがない
    if (chapter.startEpisode === null) continue;
    if (!existing.has(chapter.startEpisode)) {
      existing.set(chapter.startEpisode, chapter.name);
    }
  }

  const proposed = new Set(candidates.map((entry) => entry.startEpisode));
  const anchors = [...proposed].filter((start) => existing.has(start));
  const looseExisting = [...existing.keys()].filter(
    (start) => !proposed.has(start)
  );
  const looseProposed = [...proposed].filter((start) => !existing.has(start));

  const pairs: Array<{ from: number; to: number; distance: number }> = [];
  for (const from of looseExisting) {
    for (const to of looseProposed) {
      const low = Math.min(from, to);
      const high = Math.max(from, to);
      if (anchors.some((anchor) => anchor > low && anchor < high)) continue;
      pairs.push({ from, to, distance: high - low });
    }
  }
  // 近い組から決める。並びが同じなら若い話数から（結果を毎回同じにする）
  pairs.sort(
    (left, right) =>
      left.distance - right.distance ||
      left.to - right.to ||
      left.from - right.from
  );

  const movedTo = new Map<number, number>();
  const usedFrom = new Set<number>();
  for (const pair of pairs) {
    if (usedFrom.has(pair.from) || movedTo.has(pair.to)) continue;
    usedFrom.add(pair.from);
    movedTo.set(pair.to, pair.from);
  }

  return candidates.map((entry): ChapterBoundary => {
    const sameName = existing.get(entry.startEpisode);
    if (sameName !== undefined) {
      return { kind: "same", existingName: sameName };
    }
    const from = movedTo.get(entry.startEpisode);
    if (from !== undefined) {
      return {
        kind: "moved",
        fromEpisode: from,
        fromName: existing.get(from) ?? "",
      };
    }
    return { kind: "new" };
  });
}

/**
 * 分類を短い1行にする（提案パネル・MCPの返り値で同じ文言を使う）。
 *
 * **短く言う**——提案パネルの1件は数行しか無く、長い断りは読み飛ばされる。
 */
export function describeChapterBoundary(
  boundary: ChapterBoundary,
  labelOf: (episode: number) => string
): string {
  switch (boundary.kind) {
    case "same":
      return "既存の区切りと同じ";
    case "moved":
      return movedBoundaryText(labelOf(boundary.fromEpisode));
    case "new":
      return "新しい区切り";
  }
}

/**
 * 「動かす」の印の文言。提案パネルとMCPで**同じ言い方にする**
 * （言い回しが2つあると、作者が同じことだと気づきにくい）。
 *
 * @param fromLabel いまの開始の話の見出し（「第102話」）
 */
export function movedBoundaryText(fromLabel: string): string {
  return `既存の区切りを動かします（いま${fromLabel}から）`;
}

/** 却下の理由を、作者が読める日本語にする */
const REJECT_REASON_LABELS: Record<ChapterProposalRejectReason, string> = {
  shape: "形が違う",
  placeholder: "名前が無い",
  unknown_episode: "実在しない話数",
  duplicate_start: "同じ話から始まる章の重なり",
  out_of_order: "話数の順が逆",
};

/**
 * 却下の内訳を、ログ・通知向けの1行にする。
 *
 * **数だけでは次の一手が決まらない**（設計書6.35.7と同じ考え方）。
 * `unknown_episode` が多ければAIが番号を作っている（プロンプトの問題）、
 * `shape` が多ければスキーマの与え方（プロバイダの方言）の問題である。
 */
export function describeChapterRejectReasons(
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
          REJECT_REASON_LABELS[reason as ChapterProposalRejectReason] ?? reason
        } ${count}件`
    )
    .join("、");
}

/** 応答から章の配列を取り出す。無ければ空（**提案0件として扱う**） */
function chaptersOf(raw: unknown): unknown[] {
  return isRecord(raw) && Array.isArray(raw.chapters) ? raw.chapters : [];
}

/** 1件を読む。**話数が整数でなければ形が違う**（「第1話」は読み取らない） */
function readCandidate(
  item: unknown
): { name: string; startEpisode: number; reason: string } | null {
  if (!isRecord(item)) return null;
  const name = typeof item.name === "string" ? item.name.trim() : "";
  const reason = typeof item.reason === "string" ? item.reason.trim() : "";
  const startEpisode = item.startEpisode;
  if (typeof startEpisode !== "number" || !Number.isSafeInteger(startEpisode)) {
    return null;
  }
  return { name, startEpisode, reason };
}

/**
 * 長すぎる名前を切り詰める。
 *
 * **候補ごと捨てない。** 名前が長いだけで落とすと、開始の話数と理由まで
 * 一緒に消える（伏線の短い名と同じ扱い）。
 */
function shortenName(name: string): string {
  return name.length > CHAPTER_NAME_MAX_CHARS
    ? `${name.slice(0, CHAPTER_NAME_MAX_CHARS)}…`
    : name;
}

/**
 * 中身のつもりで書かれた「中身が無い」言葉か。
 *
 * 2種類ある。**どちらも実データで返ってきた形である。**
 *
 *   1. 「該当なし」「空文字」のような、中身が無いことを表す言葉
 *   2. **プロンプトの出力例に書いた言い換えそのもの**（「章の名前」）
 *
 * **2は「丸ごと同じ」ときだけ弾く**（P-25と同じ）。部分一致で見ると、
 * 「章の名前を継ぐ者」のような正当な名前まで空扱いになる。
 *
 * **「第一章」のような番号だけの名前は通す。** 中身は薄いが、作者が
 * 一覧で見て直せる実在の章名であり、弾く害（良い区切りの提案ごと消える）
 * のほうが大きい。
 */
function isEmptyAnswer(text: string): boolean {
  if (!text.trim()) return true;
  if (isPlaceholderText(text)) return true;
  const body = normalizeForHintMatch(text);
  if (!body) return true;
  return CHAPTER_PROPOSE_HINTS.some(
    (hint) => body === normalizeForHintMatch(hint)
  );
}

/** 中身の無い言葉が来たら、空にする（書いてあることにしない） */
function usableReason(reason: string): string {
  return isEmptyAnswer(reason) ? "" : reason;
}

/**
 * 句読点・かっこ・空白を落とす（ヒント語との照合用）。
 *
 * AIは指示の言葉を返すとき、かっこや読点を添えてくる（`（章の名前）`）。
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(text: string): Record<string, unknown> | null {
  const attempts = [
    text,
    text.replace(/^[\s\S]*?```(?:json)?\s*/i, "").replace(/```[\s\S]*$/, ""),
    extractBraces(text),
  ];

  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate.trim());
      if (isRecord(parsed)) return parsed;
    } catch {
      // 次の候補を試す
    }
  }
  return null;
}

function extractBraces(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}
