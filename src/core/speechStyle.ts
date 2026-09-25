import type { Character, SpeechStyleFacet } from "../models/character";
import { addFacetTo, personalityAsOf, personalityRevealedAfter } from "./personalityFacets";
import { normalizeForComparison } from "./groundedEvidence";
import { quotedSpans } from "./quotedSpans";

/**
 * 人物の口調（作者の裁定、2026-09-25 昼。設計書6.5.10）。
 *
 * ## なぜ欄を足したか
 *
 * 矛盾検知は「一人称、口調、性格…が設定と食い違わないか」を見る
 * （P-12 の CHECK_ITEMS）のに、**照らし合わせる口調の資料がどこにも
 * 無かった**（縛りの洗い出し8番）。AIが読み取った語尾・方言・敬語は、
 * 性格の括弧に混ざるか捨てられていた。
 *
 * ## 積み方
 *
 * 性格と同じく**面ごとに積む**（`personalityFacets.ts` の `addFacetTo`）。
 * 口調も同時に成り立つ特徴を重ねて描かれるので、上書き型にすると後の話の
 * 一面が前の話の読みを押し流す。
 *
 * ## 根拠
 *
 * 口調は**本文の台詞に実在する引用**（`speechEvidence`）があるときだけ
 * 受け取る（CLAUDE.md 規則3）。性格は言動からのまとめを認めているが、
 * 口調は台詞そのものに出るもので、引用が示せないなら読み取れていない。
 * 地の文の引用・本文に無い引用・指示の言葉の写しは、検算
 * （`characterExtractionValidation.ts`）が口調だけ落とす（人物は残す）。
 *
 * VS Code APIに依存しない。
 */

/**
 * 口調の長さの上限。**短く**が作者の注文（一人称・語尾・口癖・話し方の特徴）。
 *
 * プロンプトへ埋め込んでいるので、変えたら `CHARACTER_EXTRACT_VERSION` も上げる。
 */
export const SPEECH_STYLE_MAX_CHARS = 60;

/**
 * プロンプトに載せる口調の例（架空の人物のもの）。
 *
 * **そのまま答えに返ってくる前提で置く**（CLAUDE.md「繰り返し起きた失敗」3番）。
 * 検算が、これと同じ値・これを含む値を落とす（`isSpeechStyleEcho`）。
 */
export const SPEECH_STYLE_EXAMPLE =
  "一人称は「あたし」。語尾に「〜だもん」を付け、目上にも砕けた話し方";

/**
 * 例の中の、作品側にはまず出てこない言葉。**本文に無いのに口調に入っていたら、
 * 例から持ってきたもの**と見る。
 *
 * 実測（gemma4:e4b、2026-09-25）：台詞が「おっにく～♪」の人物に
 * 「語尾に「〜だもん」「〜だよ」などを使い…」と返ってきた。例の文をそのまま
 * 写したのではなく、例の口癖だけを混ぜてくる。「あたし」は入れない——
 * 本当に「あたし」と言う人物は多く、本文にあるかどうかで見分けても、
 * 別の人物の台詞にあるだけで通ってしまい見張りにならない。
 */
export const SPEECH_STYLE_EXAMPLE_MARKERS = ["だもん"] as const;

/**
 * プロンプトで欄の中身を説明するときの言葉の並び。
 *
 * **中身の代わりにこの並びが返ってくる**ことがある（`"category": "人物|状態|時系列"`
 * と同じ形）。並びの2語以上が「・」か「、」でつながって現れたら、指示の写しと見る。
 * プロンプトはこの並びから説明文を組むので、ここを直せば両方が変わる。
 */
export const SPEECH_STYLE_ASPECTS = [
  "一人称",
  "語尾",
  "口癖",
  "敬語を使うかどうか",
  "方言",
] as const;

/** 口調の検算で落とした理由 */
export type SpeechStyleRejectionReason =
  /** 根拠の引用が無い */
  | "no_quote"
  /** 引用が本文に無い */
  | "quote_not_found"
  /** 引用は本文にあるが、台詞（「」『』）の中ではない */
  | "not_dialogue"
  /** 指示の言葉・例の写し */
  | "instruction_echo";

/**
 * 口調の値が、指示の言葉か例の写しか。
 *
 * 見るのは2つだけにする（本物の口調を落とさないため）。
 * 1. 例の文そのもの（空白を無視して同じか、例を丸ごと含む）
 * 2. 欄の説明の語が「・」か「、」で2つ以上つながった形（「一人称・語尾・口癖」）。
 *    本物の口調は「一人称は俺。語尾に〜」のように中身を書くので、
 *    ラベルだけを点で並べた形にはならない
 * 3. 本文を渡されたときは、例の口癖（`SPEECH_STYLE_EXAMPLE_MARKERS`）が
 *    口調にあるのに本文のどこにも無いもの
 */
export function isSpeechStyleEcho(value: string, chunkText?: string): boolean {
  const text = normalizeForComparison(value);
  if (!text) return false;
  const example = normalizeForComparison(SPEECH_STYLE_EXAMPLE);
  if (text === example || text.includes(example)) return true;
  // 例の核の言い回し（架空の口癖）がそのまま入っていれば写しと見る
  if (text.includes("だもん」を付け")) return true;
  if (chunkText !== undefined) {
    const body = normalizeForComparison(chunkText);
    if (
      SPEECH_STYLE_EXAMPLE_MARKERS.some(
        (marker) => text.includes(marker) && !body.includes(marker)
      )
    ) {
      return true;
    }
  }
  // プロンプトは語を「、」でつないで書いている。写しは「・」に変わって
  // 返ることもあるので両方を見る
  for (const left of SPEECH_STYLE_ASPECTS) {
    for (const right of SPEECH_STYLE_ASPECTS) {
      if (left === right) continue;
      if (
        text.includes(`${left}・${right}`) ||
        text.includes(`${left}、${right}`)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 根拠の引用を、照合に使う断片へ分ける。
 *
 * AIは台詞を「」ごと写すことも、2つの台詞をつないで写すこともある。
 * 括弧と改行で割り、前後の括弧・三点リーダーを落とす。
 * **3字未満の断片は使わない。** 「うん」のような短い台詞は、本文の
 * どこかの台詞にたまたま含まれるので、照合の裏付けにならない。
 */
function quoteFragments(quote: string): string[] {
  return quote
    .split(/[\r\n」』）)]+|[「『（(]/u)
    .map((fragment) =>
      normalizeForComparison(
        fragment.replace(/^[\s…―ー、。]+|[\s…―、。]+$/gu, "")
      )
    )
    .filter((fragment) => [...fragment].length >= 3);
}

/** 丸括弧でくくった範囲（入れ子は見ない。心の声・念話の台詞に使う作品がある） */
const PARENTHESIZED = /[（(][^（）()]*[）)]/gu;

/**
 * 口調の根拠の引用が、本文の**台詞の中に**実在するか。
 * 通れば null、通らなければ落とす理由を返す。
 *
 * 引用の断片のどれか1つが、本文のどれか1つの台詞（「」『』の中、および
 * 心の声・念話に使われる（）の中）に含まれていれば通す。台詞の外（地の文）にしか無ければ `not_dialogue`、
 * 本文のどこにも無ければ `quote_not_found`。
 *
 * **その台詞を誰が言ったかまでは確かめない。** 話者の決定はコードでは
 * できない（呼称の抽出と同じ限界）。捏造と地の文の取り違えを落とすまでに留める。
 */
export function speechQuoteProblem(
  quote: string | null | undefined,
  chunkText: string
): SpeechStyleRejectionReason | null {
  const fragments = quoteFragments(quote ?? "");
  if (fragments.length === 0) return "no_quote";

  const dialogue = [
    ...quotedSpans(chunkText).map((span) =>
      normalizeForComparison(chunkText.slice(span.start, span.end))
    ),
    // **丸括弧の中も台詞として見る。** 心の声や霊・念話の声を（）で書く作品が
    // ある（実データ：幽霊の少女の台詞がすべて（…）だった）。その人物の
    // 話し方がいちばんよく出る所なので、ここを地の文と見ると口調が全部落ちる
    ...(chunkText.match(PARENTHESIZED) ?? []).map(normalizeForComparison),
  ];
  if (fragments.some((fragment) => dialogue.some((line) => line.includes(fragment)))) {
    return null;
  }
  const whole = normalizeForComparison(chunkText);
  return fragments.some((fragment) => whole.includes(fragment))
    ? "not_dialogue"
    : "quote_not_found";
}

/**
 * 口調を長さの上限で切る。捨てずに切るのは紹介と同じ考え
 * （`clampSummary`。途中まででも資料に残るほうが作者の役に立つ）。
 * 句点・読点の切れ目まで戻す。上限の6割より前には戻さない。
 */
export function clampSpeechStyle(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  const characters = [...text];
  if (characters.length <= SPEECH_STYLE_MAX_CHARS) return text;
  const head = characters.slice(0, SPEECH_STYLE_MAX_CHARS).join("");
  const floor = Math.floor(SPEECH_STYLE_MAX_CHARS * 0.6);
  for (const mark of ["。", "、", "．", "，"]) {
    const at = head.lastIndexOf(mark);
    if (at >= floor) return head.slice(0, at + 1);
  }
  return head;
}

/**
 * 抽出した口調を、面として人物へ足す。**渡したレコードを書き換える**
 * （マージの `applyExtracted` と同じ作法）。何か変わったら true。
 *
 * 規則は性格と同じ（`addPersonalityFacet`）：同じ面なら話数だけ足す、
 * 詳しく書き直したものなら1つにまとめる、それ以外は新しい面として末尾へ。
 *
 * 値と引用の検算は呼び出し側（抽出の検算）で済ませてから渡す。
 * 作者が確定させた人物（`autoGenerated: false`）には、マージが呼ばない。
 */
export function addSpeechStyleFacet(
  target: Character,
  value: string,
  chapters: readonly number[],
  evidence: string | null
): boolean {
  if (!target.speechStyleFacets) target.speechStyleFacets = [];
  const holder = {
    facets: target.speechStyleFacets,
    body: target.speechStyle ?? null,
  };
  const changed = addFacetTo(holder, value, chapters, evidence);
  target.speechStyle = holder.body;
  return changed;
}

/** 巻き戻しに使う形（性格の面の関数へそのまま渡せる形）へ写す */
function asFacetRecord(record: {
  speechStyle?: string | null;
  speechStyleFacets?: readonly SpeechStyleFacet[];
}): { personality: string | null; personalityFacets: readonly SpeechStyleFacet[] } {
  return {
    personality: record.speechStyle ?? null,
    personalityFacets: record.speechStyleFacets ?? [],
  };
}

/**
 * 第N話の時点で見えていた口調（設計書6.10.3の巻き戻しを、面で行う）。
 * 面で巻き戻せない（面が無い・本体が手で書き換えられている）なら undefined。
 */
export function speechStyleAsOf(
  record: {
    speechStyle?: string | null;
    speechStyleFacets?: readonly SpeechStyleFacet[];
  },
  chapter: number
): string | null | undefined {
  return personalityAsOf(asFacetRecord(record), chapter);
}

/** 第N話より**あと**で見えた口調の面（設計書6.10.4）。面で扱えないなら undefined */
export function speechStyleRevealedAfter(
  record: {
    speechStyle?: string | null;
    speechStyleFacets?: readonly SpeechStyleFacet[];
  },
  chapter: number
): Array<{ value: string; chapter: number }> | undefined {
  return personalityRevealedAfter(asFacetRecord(record), chapter);
}
