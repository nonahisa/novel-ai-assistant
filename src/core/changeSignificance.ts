import type { Character } from "../models/character";
import type { RecordChange } from "../models/jsonValidation";
import { changedFields, changesOfField, sortChanges } from "./recordChanges";
import { splitDwellingChanges } from "./characterDwelling";

/**
 * 作中での変化が、物語の筋にどれだけ食い込んでいるかを数値にする（設計書6.18）。
 *
 * **なぜ数値が要るのか。** 紹介（`summary`）は一覧で名前の下に並ぶ短い1行で、
 * 80字しかない。変化の記録には「課長になった」も「髪を切った」も同じ形で並ぶので、
 * そのまま材料として渡すと、AIは書きやすいほう（外見）から埋める。
 * **紙幅を何に使うかを、AIに渡す前にコード側で決める。**
 *
 * **判定はコードで行い、AIにはさせない。** 変化の記録そのものが「AIには書かせない」
 * ものであり（`RecordChange` の注釈）、その重み付けまでAIに任せると、
 * 同じ人物でも呼ぶたびに紹介の中身が変わる。同じ入力なら同じ点になるようにしてある。
 *
 * **測っているのは「関与度」であって「重要度」ではない。** 作者にとって大事な変化を
 * 機械が決めることはできない。ここで測るのは「物語の筋（誰が何者で、どう変わったか）に
 * どれだけ食い込む項目か」だけである。**低いと判定した変化も、資料の「変化」欄には
 * 今までどおり全部載る。紹介に書かないだけである。**
 */

export type InvolvementLevel = "high" | "medium" | "low";

export const INVOLVEMENT_LABELS: Record<InvolvementLevel, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

/** これ以上なら紹介に必ず書く */
export const HIGH_INVOLVEMENT = 60;
/** これ以上なら、字数が余ったときに書く */
export const MEDIUM_INVOLVEMENT = 35;

export interface ChangeSignificance {
  /** どの項目の変化か（"appearance" など） */
  field: string;
  /** 0〜100。大きいほど物語の筋に関わる */
  score: number;
  level: InvolvementLevel;
  /** 点の内訳。作者に「なぜその点なのか」を示せるように残す */
  reasons: string[];
}

/**
 * 項目ごとの基礎点。
 *
 * **順番の根拠は「その項目が変わると、話の筋が動くか」である。**
 *   - 役割・所属・性別が変われば、その人物の立ち位置そのものが変わる。
 *     性別を高く置くのは、この作者の作品に転生・転性があるためで
 *     （`world_012_転生と転性`）、起きたときは筋の中心にある
 *   - 性格の変化は物語の芯だが、AIの言い換えでも動きやすい。中ほどに置く
 *   - 外見は「髪を切った」で動く。読者に見える変化だが、筋には関わらないことが多い
 *   - 紹介（summary）は紹介そのものなので0。紹介に「紹介が変わった」とは書けない
 *   - 読み仮名は作中で変わらない項目（`recordChanges.ts` の `UNCHANGING_FIELDS`）。
 *     違う値が出たらAIの読み違いなので、紹介へ持ち込まない
 */
const FIELD_WEIGHTS: Record<string, number> = {
  role: 55,
  gender: 50,
  affiliation: 50,
  personality: 35,
  appearance: 20,
  summary: 0,
  reading: 0,
};

/**
 * 表に無い項目の点。
 *
 * 作者が足した項目（`custom_fields.json`）が変化として記録されうる。
 * 何が来るか分からないので、真ん中より少し下に置く——
 * 高く置くと知らない項目が紹介を占め、0に置くと作者が足した項目だけが
 * 黙って無視される。
 */
const DEFAULT_WEIGHT = 30;

/** その項目の変化が、物語にどれだけ関わるか */
export function scoreFieldChange(
  changes: readonly RecordChange[],
  field: string,
  appearedChapters: readonly number[] = [],
  /** 人物の側の加点（`characterCentrality`）。重み0の項目には足さない */
  centrality?: CharacterCentrality
): ChangeSignificance {
  const entries = changesOfField([...changes], field);
  const weight = FIELD_WEIGHTS[field] ?? DEFAULT_WEIGHT;

  // 0の項目は、何段変わっていても紹介には書かない。
  // 加点で押し上げられないよう、ここで打ち切る
  if (weight === 0) {
    return {
      field,
      score: 0,
      level: "low",
      reasons: [
        field === "summary"
          ? "紹介そのものの変化なので、紹介には書かない"
          : "作中で変わらない項目なので、紹介には書かない",
      ],
    };
  }

  const reasons = [`項目「${field}」の基礎点 ${weight}`];
  let score = weight;

  // **作者が手をかけた変化は上げる。** 食い違いを自分で昇格させた、
  // あるいは補足を書いたということは、作者がその変化を見て
  // 「これは作中で起きたことだ」と判断している
  if (hasAuthorTouch(entries)) {
    score += 20;
    reasons.push("作者が確定させた、または補足を書いている +20");
  }

  // **段は件数でなく「新しい語を足した話」で数える**（作者の裁定、2026-10-17）。
  // 件数で数えると、AIが同じ話の中で同じことを違う言葉で書いた跡が段に化け、
  // 言い換えの多い人物ほど点が上がっていた。
  const groups = changeGroups(entries);
  const steps = groups.filter((group) => group.novel).length;
  // 4段から足す。3段からにすると、出来事と細部が足されただけの人物
  // （立場は変わっていない）が「高」に残った
  const stepPoints = Math.min((steps - STEP_BONUS_FROM + 1) * 5, 10);
  if (stepPoints > 0) {
    score += stepPoints;
    reasons.push(`新しい内容を足した話が${steps}つある +${stepPoints}`);
  }

  // 定着の加点は、最後の群が新しいときだけ。言い換えで終わっている項目は、
  // 最後に書かれた値が「変化した後の姿」とは言えない。
  // **群が1つしか無い項目にも付けない**——話をまたぐ変化が無く、
  // 測るべき「変化した後の姿」がそもそも無い
  const last = groups.at(-1);
  if (groups.length >= 2 && last?.novel) {
    const settlement = settlementPoints(entries, appearedChapters);
    if (settlement.points > 0) {
      score += settlement.points;
      reasons.push(`${settlement.reason} +${settlement.points}`);
    }
  }

  // 人物の側の加点（物語の中心にいる人物）。項目ごとの点ではないので、
  // 呼び出し側で1回だけ求めて渡す（`characterCentrality`）
  if (centrality && centrality.points > 0) {
    score += centrality.points;
    reasons.push(`${centrality.reason} +${centrality.points}`);
  }

  const capped = Math.min(score, 100);
  return { field, score: capped, level: levelOf(capped), reasons };
}

/**
 * 段の加点を付け始める段数。
 * 4段で +5、5段以上で +10（上限）。
 */
const STEP_BONUS_FROM = 4;

/**
 * 群を「新しい」と見る境目。それまでの群に無い2字の組が、この割合以上あれば新しい。
 * **前の話までの語を半分以上くり返している話は、段に数えない。**
 *
 * 0.4 から 0.5 へ上げた（作者の裁定、2026-10-18）。ウィズの最新の話の役割が、
 * 前の話の「メアリーの父」「行方不明」をつなぎ直して「一ヶ月前から」を足しただけ
 * （新しさ 0.47）なのに段に数えられ、段の +5 と「変わったばかり」の +5 で「高」に
 * 出ていた。作者の判断例（10-17・10-18）がすべて合うのは 0.48〜0.65。
 * その下の端に近い 0.5 に置いたのは、単体テストの作り物の値（圭織型の 0.5）が
 * 0.5 ちょうどを「新しい」と見る前提で作ってあるため。
 */
export const NOVELTY_THRESHOLD = 0.5;

/** 変化の記録を、初出の話ごとにまとめた1群 */
export interface ChangeGroup {
  /** その群の初出の話。話数の無い記録（「それ以前」）は -1 */
  chapter: number;
  entries: RecordChange[];
  /** それまでのすべての群に無い2字の組の割合（0〜1）。最初の群は 1 */
  novelty: number;
  /** 段に数えるか（最初の群は常に数える） */
  novel: boolean;
}

/**
 * 変化の記録を、初出の話ごとにまとめ、群ごとに新しさを出す。
 *
 * **同じ話の値は1つの群にする。** 同じ話の中で役割が3回変わることはまず無く、
 * AIが同じことを違う言葉で書いた跡と見てよい。
 *
 * **比べる相手は直前の群でなく、それまでの全部である。** Aと言い、Bを挟んで
 * Aへ戻った値を新しいと数えないため。
 *
 * 判定は字面だけで行う（AIに判断させない）。同じ意味の別の語（「生徒」と
 * 「学生」）は新しいと出るが、辞書は作品ごとに語が違うので持たない。
 */
export function changeGroups(entries: readonly RecordChange[]): ChangeGroup[] {
  const byChapter = new Map<number, RecordChange[]>();
  for (const entry of sortChanges([...entries])) {
    const chapter = entry.chapters.length > 0 ? Math.min(...entry.chapters) : -1;
    const bucket = byChapter.get(chapter);
    if (bucket) bucket.push(entry);
    else byChapter.set(chapter, [entry]);
  }

  const seen = new Set<string>();
  const groups: ChangeGroup[] = [];
  for (const [chapter, members] of [...byChapter].sort((a, b) => a[0] - b[0])) {
    const grams = new Set(members.flatMap((entry) => bigramsOf(entry.value)));
    const isFirst = groups.length === 0;
    const fresh = [...grams].filter((gram) => !seen.has(gram)).length;
    const novelty = isFirst ? 1 : grams.size > 0 ? fresh / grams.size : 0;
    groups.push({
      chapter,
      entries: members,
      novelty,
      novel: isFirst || novelty >= NOVELTY_THRESHOLD,
    });
    for (const gram of grams) seen.add(gram);
  }
  return groups;
}

/**
 * 比べる前に揃える。片仮名を平仮名に寄せ（イジメ／いじめ）、
 * 句読点・括弧・空白を除く。値どうしはつなげない（「／」をまたいだ組を作らない）
 */
function bigramsOf(value: string): string[] {
  const text = value
    .replace(/[ァ-ヶ]/gu, (char) =>
      String.fromCharCode(char.charCodeAt(0) - 0x60)
    )
    .replace(/[\p{P}\s]/gu, "");
  const chars = [...text];
  // 1字の値は組が作れないので、その字そのものを1つの組として扱う
  if (chars.length === 1) return chars;
  const grams: string[] = [];
  for (let index = 0; index + 1 < chars.length; index += 1) {
    grams.push(chars[index] + chars[index + 1]);
  }
  return grams;
}

/** 人物の側の加点（`characterCentrality`） */
export interface CharacterCentrality {
  points: number;
  reason: string;
}

/** 人物の関与度を出すときに、人物の外から渡すもの */
export interface CharacterInvolvementContext {
  /**
   * 各話あらすじの本文（`設定/chapter_synopses.json`）。
   * 渡さなければ、あらすじによる加点は付けない
   */
  synopses?: readonly string[];
  /**
   * 同じ作品の人物（2026-10-18）。宿り（設計書6.5.13）で心が宿っている体の記録から、
   * 心の側の記述（「前世は男子小学生」）を外して測るのに使う。渡さなければ外さない。
   * **外すのは点の材料からだけで、記録は書き換えない**
   */
  characters?: readonly Character[];
}

/** あらすじの、この割合以上に名前が出る人物を物語の中心と見る */
export const SYNOPSIS_PRESENCE_THRESHOLD = 0.5;

/** 人物の側の加点の大きさ。主人公の印とあらすじが重なっても1回だけ */
const CENTRALITY_POINTS = 5;

/**
 * 物語の中心にいる人物か（作者の裁定、2026-10-17）。
 *
 * 主人公の変化は、AIが話ごとに言い換えて書くので、段で数えると言い換えとして
 * 落ちる。けれど筋の本線に乗っている人物の変化は、それだけで筋に食い込む。
 * **測っているのは「関与度」のままである**——人物の格付けではなく、
 * 「その人物の変化が筋にどれだけ食い込むか」の一部として足す。
 *
 * - **作者が付けた主人公の印**（`isProtagonist`）。機械でなく作者が決める
 * - **各話あらすじの半分以上に名前が出る**。名前に含まれる別名（「三浦太一」の
 *   「太一」）も数える。あらすじでは下の名前だけで書かれることが多い。
 *   名前に含まれない別名（あだ名・呼び名）は他人にも当たるので数えない
 *
 * どちらか、または両方で +5（重ねない）。
 */
export function characterCentrality(
  character: Pick<Character, "name" | "aliases" | "isProtagonist">,
  context: CharacterInvolvementContext = {}
): CharacterCentrality | undefined {
  const presence = synopsisPresence(character, context.synopses ?? []);
  const inSynopses =
    presence !== undefined &&
    presence.total > 0 &&
    presence.hits / presence.total >= SYNOPSIS_PRESENCE_THRESHOLD;
  const synopsisNote = presence
    ? `各話あらすじの${presence.total}話中${presence.hits}話に名前が出る`
    : "";

  if (character.isProtagonist) {
    return {
      points: CENTRALITY_POINTS,
      reason: inSynopses
        ? `作者が主人公（中心人物）の印を付けている（${synopsisNote}。加点は1回だけ）`
        : "作者が主人公（中心人物）の印を付けている",
    };
  }
  if (inSynopses) {
    return { points: CENTRALITY_POINTS, reason: synopsisNote };
  }
  return undefined;
}

/** あらすじの何話に名前が出るか。あらすじが1つも無ければ undefined */
export function synopsisPresence(
  character: Pick<Character, "name" | "aliases">,
  synopses: readonly string[]
): { hits: number; total: number } | undefined {
  const texts = synopses.map(withoutSpaces).filter((text) => text.length > 0);
  if (texts.length === 0) return undefined;
  const name = withoutSpaces(character.name);
  // 空白の有無だけが違う書き方（「密倉 文佳」と「密倉文佳」）は同じ名前として探す
  const terms = [
    name,
    ...character.aliases
      .map(withoutSpaces)
      .filter((alias) => alias.length > 0 && name.includes(alias)),
  ].filter((term) => term.length > 0);
  const hits = texts.filter((text) => terms.some((term) => text.includes(term))).length;
  return { hits, total: texts.length };
}

function withoutSpaces(text: string): string {
  return text.replace(/\s/gu, "");
}

/**
 * 変化のある項目を、関与度の高い順に並べて返す。
 *
 * **並べ替えるのは、AIが先に読んだものを重く扱うためである。**
 * 材料の順番がそのまま紹介の書き出しに出る。
 */
export function scoreChanges(
  changes: readonly RecordChange[],
  appearedChapters: readonly number[] = [],
  centrality?: CharacterCentrality
): ChangeSignificance[] {
  return changedFields([...changes])
    .map((field) => scoreFieldChange(changes, field, appearedChapters, centrality))
    .sort((left, right) => right.score - left.score || left.field.localeCompare(right.field));
}

/** 人物の変化を関与度の高い順に返す */
export function scoreCharacterChanges(
  character: Character,
  context: CharacterInvolvementContext = {}
): ChangeSignificance[] {
  // 体の記録に混ざった心の側の記述は、体の持ち主の変化ではない。段にも定着にも数えない
  const changes = context.characters
    ? splitDwellingChanges(character, context.characters).own
    : character.changes;
  return scoreChanges(
    changes,
    character.appearedChapters,
    characterCentrality(character, context)
  );
}

/** 「関与度 65（高）」。画面にもAIへの材料にも、同じ書き方で出す */
export function describeInvolvement(significance: ChangeSignificance): string {
  return `関与度 ${significance.score}（${INVOLVEMENT_LABELS[significance.level]}）`;
}

function levelOf(score: number): InvolvementLevel {
  if (score >= HIGH_INVOLVEMENT) return "high";
  if (score >= MEDIUM_INVOLVEMENT) return "medium";
  return "low";
}

function hasAuthorTouch(entries: readonly RecordChange[]): boolean {
  return entries.some(
    (entry) => entry.source === "author" || Boolean(entry.note?.trim())
  );
}

/**
 * 変化した後の姿が、作中に根を張っているか。
 *
 * **1話だけの変化は、その場限りかもしれない**（変装、一時的な立場）。
 * 2話以上に渡って書かれていれば、それがその人物の「今」である。
 *
 * 最新の登場話で変わったばかりのものは、まだ2話ぶん書かれていない。
 * これを0にすると、いま起きたばかりの変化が紹介から落ちるので、半分だけ足す。
 */
function settlementPoints(
  entries: readonly RecordChange[],
  appearedChapters: readonly number[]
): { points: number; reason: string } {
  const latest = sortChanges([...entries]).at(-1);
  if (!latest) return { points: 0, reason: "" };

  if (latest.chapters.length >= 2) {
    return { points: 10, reason: "変化した後の姿が2話以上続いている" };
  }

  const lastAppeared =
    appearedChapters.length > 0 ? Math.max(...appearedChapters) : undefined;
  if (
    lastAppeared !== undefined &&
    latest.chapters.length === 1 &&
    latest.chapters[0] === lastAppeared
  ) {
    return { points: 5, reason: "いちばん新しい登場話で変わったばかり" };
  }

  return { points: 0, reason: "" };
}

/**
 * AIが材料の注釈を、そのまま値として書き写してきたときに落とす。
 *
 * **この作品で繰り返し起きている失敗である。** プロンプトに書いた指示語が
 * そのまま答えの中身として返ってくる（`"suggestion": "空文字"`、
 * `"category": "人物|状態|時系列"`。`placeholderText.ts`）。
 * 関与度は材料の側に［関与度 65（高）］の形で書いてあるので、
 * 紹介の末尾に付いて返る可能性がある。**紹介は資料にそのまま載るので、
 * 書き込む手前で必ず落とす。**
 */
export function stripInvolvementNote(value: string): string {
  return value
    .replace(/[［[]\s*関与度[^］\]]*[］\]]/gu, "")
    .replace(/（?\s*関与度\s*\d+\s*(?:[（(][高中低][）)])?\s*）?/gu, "")
    // 段の印「（高）」だけが末尾に付いて返ることもある（2026-10-15、26b の
    // 再読込で3回中3回）。文の途中は本文の言葉かもしれないので、末尾だけ落とす
    .replace(/\s*[（(][高中低][）)]\s*$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}
