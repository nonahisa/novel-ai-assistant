import { normalizeForComparison } from "./groundedEvidence";

/**
 * 場所の位置関係「中にある」（within）の**向き**を、引用の文の形から確かめる
 * （作者の裁定 2026-10-15 の7。設計書6.93.3）。
 *
 * 発端は測定（2026-10-15、行24）——gemma4:26b が「死の谷の奥にあるという温泉」を
 * 5回とも「死の谷が温泉の中にある」と逆に読んだ。検算は引用が本文にあるかしか
 * 見ないので、逆向きのまま通っていた。31b は同じ頼み方で正しく読むので、
 * 頼み方ではなくコードで向きを確かめる（実装ルール3「AIの出力を信用しない」）。
 *
 * **向きが文の形から読み取れるときだけ判定する。** 読めるのは次の形だけ：
 *
 * - 「XのY」「Xの中のY」「Xの奥にあるY」「Xの外れにY」「XにあるY」——Y が X の中
 * - 「YはXの中にある」「YはXにある」——Y が X の中
 *
 * それ以外（「帝都には街を囲む城壁があり」「港の北に建っている」）は**分からない**と
 * 返し、触らない。ここを欲張ると、正しい関係まで落とす。
 */

export type WithinDirection =
  /** 引用の形が、関係の向き（自分が相手の中）と一致する */
  | "consistent"
  /** 引用の形では、相手が自分の中にある（向きが逆） */
  | "reversed"
  /** 形から向きが読めない（両方の形がある・どちらも無い） */
  | "unknown";

/**
 * X と Y の間に挟まる語が、これだけなら「Y は X の中」と読む。
 *
 * 位置の語（奥・中・外れ…）は**中にあることを言う語だけ**に絞る。「北」「そば」は
 * 方角・隣接なので入れない（「港の北の学校」を「港の中」と読まないため）
 */
const PLACE_WORDS =
  "中|奥|内|内部|中心|中央|一角|片隅|奥地|最奥|地下|外れ|はずれ";
const EXIST_WORDS = "ある|あった|建つ|建っている|位置する|そびえる";

const CONTAINER_THEN_CONTAINED = new RegExp(
  `^(?:の(?:(?:${PLACE_WORDS})(?:に(?:${EXIST_WORDS})?(?:という)?の?|の)?)?` +
    `|に(?:${EXIST_WORDS})(?:という)?` +
    `|内の)$`,
  "u"
);

/** 「Y は X …にある」の、X の直後に続く形 */
const AFTER_CONTAINER = new RegExp(
  `^(?:の(?:${PLACE_WORDS}))?に(?:${EXIST_WORDS})`,
  "u"
);
/** 「Y は X」の間（主語の印だけ） */
const SUBJECT_MARK = /^[はがも]$/u;

interface Span {
  start: number;
  end: number;
}

/** 名前の出る位置。長い名前を先に見て、短い名前が長い名前の一部として出たものは数えない */
function spansOf(quote: string, names: readonly string[]): Span[] {
  const spans: Span[] = [];
  const sorted = [...new Set(names.map(normalizeForComparison).filter(Boolean))].sort(
    (a, b) => b.length - a.length
  );
  for (const name of sorted) {
    let from = 0;
    for (;;) {
      const at = quote.indexOf(name, from);
      if (at < 0) break;
      const span = { start: at, end: at + name.length };
      if (!spans.some((other) => overlaps(other, span))) spans.push(span);
      from = at + 1;
    }
  }
  return spans;
}

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * 引用の形から、「自分（selfNames）が相手（targetNames）の中にある」という
 * 関係の向きを確かめる。
 *
 * 名前は別名も含めて渡す。片方の名前がもう片方の名前の一部（「港」と「港町」、
 * 「庭園」と「庭園のあずまや」）のとき、長いほうの中に出た短い名前は数えない。
 */
export function withinDirectionFromQuote(
  evidence: string,
  selfNames: readonly string[],
  targetNames: readonly string[]
): WithinDirection {
  const quote = normalizeForComparison(evidence);
  const longFirst = [...selfNames, ...targetNames]
    .map(normalizeForComparison)
    .filter(Boolean);
  // 自分と相手の名前を1つの並びで探す（重なったら長いほうが勝つ）
  const all = spansOf(quote, longFirst);
  const selfSet = new Set(selfNames.map(normalizeForComparison));
  const tagged = all.map((span) => ({
    ...span,
    self: selfSet.has(quote.slice(span.start, span.end)),
  }));

  let selfInside = false;
  let targetInside = false;
  for (const first of tagged) {
    for (const second of tagged) {
      if (first.self === second.self || first.end > second.start) continue;
      const between = quote.slice(first.end, second.start);
      // 「X…Y」で、Y が X の中
      if (CONTAINER_THEN_CONTAINED.test(between)) {
        if (second.self) selfInside = true;
        else targetInside = true;
      }
      // 「Y は X …にある」で、Y が X の中
      if (
        SUBJECT_MARK.test(between) &&
        AFTER_CONTAINER.test(quote.slice(second.end))
      ) {
        if (first.self) selfInside = true;
        else targetInside = true;
      }
    }
  }
  if (selfInside === targetInside) return "unknown";
  return selfInside ? "consistent" : "reversed";
}
