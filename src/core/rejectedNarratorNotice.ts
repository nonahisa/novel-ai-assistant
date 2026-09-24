import type {
  CharacterRejectionReason,
  RejectedCharacterCandidate,
  RejectedCharacterDetails,
} from "./characterExtractionValidation";

/**
 * 名前が決められずに捨てた人物を、作者へ知らせる文面を作る。
 *
 * **穴は塞がない。塞がずに、落としたことを言う**（設計書6.10.6 と同じ考え方）。
 * 一人称の作品では、語り手が自分の名前を名乗らない話がある。AIは外見や性格まで
 * 読み取っていても「僕」「語り手」としか呼べず、それが検算で捨てられる
 * （`characterExtractionValidation.ts`）。捨てる判定は正しいが、これまでは
 * **件数しか出ていなかった**ので、作者には「認識していそうなのに人物が増えない」
 * としか見えなかった（作者の報告、2026-09-24）。
 *
 * **原稿を直せとは言わない。** 名前を本文に出すかどうかは文章の都合であり、
 * こちらが決めることではない。言うのは「落とした」ことと「手で書き足せる」ことだけ。
 */

/**
 * 語り手の可能性がある落とし方。**名前を決められなかった2つだけ**である。
 * 「本文に根拠が無い」「人物ではない」は語り手ではないので、ここへ入れない。
 */
const NARRATOR_REASONS: ReadonlySet<CharacterRejectionReason> =
  new Set<CharacterRejectionReason>(["pronoun_name", "descriptive_name"]);

/** 出す順と見出し。作者が見当を付けやすい順に並べる */
const DETAIL_LABELS: ReadonlyArray<[keyof RejectedCharacterDetails, string]> = [
  ["summary", "紹介"],
  ["role", "役割"],
  ["appearance", "外見"],
  ["gender", "性別"],
];

/**
 * 画面に出すときだけ、1項目をこの長さで切る。
 * 全文は操作ログに残るので、ここで切っても手立ては失われない。
 */
const DETAIL_MAX_CHARS = 60;

/**
 * 画面に並べる人数の上限。**超えた分は操作ログへ回す**。
 * 実測では2〜3件だが、一人称の作品では呼び方が増えることがあり、
 * 並べきると肝心の案内（手で書き足せること）が読まれなくなる。
 */
const SHOWN_LIMIT = 3;

const CLOSING_LINES = [
  "一人称で書かれた作品では、語り手が自分の名前を名乗らないことがあります。",
  "人物一覧の誰かに当たるなら、その人の資料へ手で書き足してください。",
];

export interface RejectedNarrator {
  name: string;
  details: RejectedCharacterDetails;
}

/**
 * 捨てた候補から、語り手らしきものだけを名前ごとにまとめる。
 *
 * **同じ名前は1人に畳む。** 一人称の作品では「僕」が話の数だけ返ってくるので、
 * 畳まないと同じ行が何十行も並ぶ。中身は項目ごとに、最初に中身のあったものを
 * 採る——チャンクによって埋まっている欄が違うため、1件目だけを見ると取りこぼす。
 */
export function collectRejectedNarrators(
  rejected: readonly RejectedCharacterCandidate[]
): RejectedNarrator[] {
  const byName = new Map<string, RejectedCharacterDetails>();
  for (const candidate of rejected) {
    if (!NARRATOR_REASONS.has(candidate.reason)) continue;
    const name = candidate.name?.trim();
    if (!name) continue;
    const merged = byName.get(name) ?? {};
    for (const [key] of DETAIL_LABELS) {
      if (merged[key] !== undefined) continue;
      const value = candidate.details?.[key];
      if (value) merged[key] = value;
    }
    byName.set(name, merged);
  }
  return [...byName].map(([name, details]) => ({ name, details }));
}

/**
 * 完了報告へ添える文面。**捨てたものが無ければ空文字**を返す
 * （毎回出る断り書きは読まれなくなる）。
 *
 * 先頭を改行で始めるのは、`buildExtractionSummary` の他の明細と揃えるため。
 */
export function describeRejectedNarrators(
  rejected: readonly RejectedCharacterCandidate[]
): string {
  const narrators = collectRejectedNarrators(rejected);
  if (narrators.length === 0) return "";
  const shown = narrators.slice(0, SHOWN_LIMIT);
  const lines = shown.map(
    (narrator) =>
      `AIは「${narrator.name}」という名前で返しています${formatDetails(
        narrator.details,
        DETAIL_MAX_CHARS
      )}。`
  );
  const rest =
    narrators.length > shown.length
      ? [`ほか${narrators.length - shown.length}件は操作ログに残してあります。`]
      : [];
  return [
    "",
    `地の文の語り手らしき人物を${narrators.length}件、名前が決められないため登録しませんでした。`,
    ...lines,
    ...rest,
    ...CLOSING_LINES,
  ].join("\n");
}

/**
 * 操作ログへ残す文面。**全件を、中身を切らずに**書く。
 *
 * 画面は件数と代表だけなので、あとから「何を捨てたのか」を確かめる手立ては
 * ここにしか残らない（能力の指示文を外したときのログと同じ作法）。
 */
export function describeRejectedNarratorsForLog(
  rejected: readonly RejectedCharacterCandidate[]
): string {
  const narrators = collectRejectedNarrators(rejected);
  if (narrators.length === 0) return "";
  return (
    `地の文の語り手らしき人物 ${narrators.length}件を、名前が決められないため登録しませんでした:\n` +
    narrators
      .map((narrator) => `  「${narrator.name}」${formatDetails(narrator.details)}`)
      .join("\n")
  );
}

/** 中身が1つも無ければ空文字を返す（空の括弧を出さない） */
function formatDetails(
  details: RejectedCharacterDetails,
  maxChars?: number
): string {
  const parts: string[] = [];
  for (const [key, label] of DETAIL_LABELS) {
    const value = details[key];
    if (!value) continue;
    parts.push(`${label}：${maxChars === undefined ? value : trim(value, maxChars)}`);
  }
  return parts.length > 0 ? `（${parts.join(" / ")}）` : "";
}

function trim(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}
