import type { Character, SpeechStyleFacet } from "../models/character";
import { mergeChangeLists, type RecordChange } from "../models/jsonValidation";
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
  | "instruction_echo"
  /**
   * 口調に書いた一人称が、根拠の台詞のどれにも無い（3巡目の測定、2026-09-25）。
   * **一人称の部分だけを外す。** 残りが無ければ口調ごと外す
   * （`firstPersonsMissingFromQuote`）
   */
  | "first_person_unquoted";

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
 * 一人称として読む語（3巡目の測定、2026-09-25）。
 *
 * **口調の値が「一人称は俺で」のように括弧なしで書いたときだけ使う。**
 * 括弧でくくった語（「一人称は「ウチ」」）は、この一覧に無くても一人称として
 * 読む。長いものから順に照らす（「俺様」を「俺」と読まない）。
 */
const FIRST_PERSON_WORDS = [
  "わたくし", "それがし", "あたくし", "俺様", "吾輩", "我輩", "拙者", "小生",
  "わたし", "あたし", "あたい", "おいら", "オイラ", "わらわ", "ワタシ", "アタシ",
  "自分", "麻呂", "おれ", "オレ", "ぼく", "ボク", "うち", "ウチ", "わし", "ワシ",
  "われ", "ワレ", "わい", "ワイ", "わて", "俺", "僕", "私", "儂", "我", "妾",
  "某", "麿", "朕", "余",
] as const;

/**
 * 漢字の一人称の読み。台詞がかなで書かれていても同じ一人称とみなすために使う
 * （口調「一人称は「俺」」・台詞「おれが行く」）。
 *
 * **1字の読み（「余」→「よ」）は入れない。** 「よ」はどの台詞にもあるので、
 * 入れると確かめたことにならない。
 */
const FIRST_PERSON_READINGS: Readonly<Record<string, readonly string[]>> = {
  俺: ["おれ"],
  俺様: ["おれさま"],
  僕: ["ぼく"],
  私: ["わたし", "わたくし", "あたし"],
  儂: ["わし"],
  我: ["われ"],
  吾輩: ["わがはい"],
  我輩: ["わがはい"],
  自分: ["じぶん"],
  拙者: ["せっしゃ"],
  某: ["それがし"],
  妾: ["わらわ", "あたし"],
  小生: ["しょうせい"],
  麻呂: ["まろ"],
  麿: ["まろ"],
};

/** 比べる形：互換文字をそろえ、カタカナをひらがなへ（「ウチ」と「うち」を同じに） */
function kanaFolded(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[ァ-ヶ]/gu, (char) =>
      String.fromCharCode(char.charCodeAt(0) - 0x60)
    );
}

/** 括弧でくくった一人称の並び（「僕」「俺」／「僕」や「俺」） */
const QUOTED_TERMS = String.raw`(?:[「『][^」』「『]{1,8}[」』](?:[やと、・]|か|または)?)+`;
const WORD_ALTERNATION = [...FIRST_PERSON_WORDS]
  .sort((left, right) => right.length - left.length)
  .join("|");
/** 「一人称は「ウチ」」「一人称：『わし』」「一人称は俺で」 */
const CLAIM_AFTER_LABEL = new RegExp(
  String.raw`一人称(?:は|が)?[：:]?\s*(?:(${QUOTED_TERMS})|(${WORD_ALTERNATION})(?=[でをと、。，,\s（(]|$))`,
  "gu"
);
/** 「「拙者」という一人称」 */
const CLAIM_BEFORE_LABEL = new RegExp(
  String.raw`(${QUOTED_TERMS})という一人称`,
  "gu"
);

function termsIn(quoted: string): string[] {
  return [...quoted.matchAll(/[「『]([^」』「『]{1,8})[」』]/gu)]
    .map((match) => match[1].trim())
    .filter((term) => term.length > 0);
}

/**
 * 口調の値に書かれた一人称（書いていなければ空）。
 *
 * **「一人称」という語と一緒に書かれたものだけを読む。** 口調の中の括弧は
 * 語尾や口癖の例にも使われる（「語尾に「〜だよ」」）ので、括弧だけを
 * 見ると一人称でないものまで拾う。「一人称は不明」のような書き方は読まない。
 */
export function claimedFirstPersons(value: string): string[] {
  const found: string[] = [];
  const add = (term: string): void => {
    if (!found.includes(term)) found.push(term);
  };
  for (const match of value.matchAll(CLAIM_AFTER_LABEL)) {
    if (match[1]) termsIn(match[1]).forEach(add);
    else if (match[2]) add(match[2]);
  }
  for (const match of value.matchAll(CLAIM_BEFORE_LABEL)) {
    termsIn(match[1]).forEach(add);
  }
  return found;
}

/**
 * 口調に書いた一人称のうち、根拠の台詞のどこにも無いもの。
 *
 * **根拠の台詞だけを見る**（本文全体は見ない）。実測（gemma4:26b、3巡目）で、
 * エルシーの口調に同じ作品のプラムの一人称「ウチ」が書かれた。本文全体を
 * 見ると、プラムの台詞にあるので通ってしまう——別人の一人称の取り違えは
 * まさにそういう形で起きる。
 *
 * 台詞がかなで書かれていても、漢字の一人称の読みと同じなら通す
 * （`FIRST_PERSON_READINGS`）。ひらがなとカタカナの違いも同じとみなす。
 */
export function firstPersonsMissingFromQuote(
  value: string,
  quote: string | null | undefined
): string[] {
  const claimed = claimedFirstPersons(value);
  if (claimed.length === 0) return [];
  const spoken = kanaFolded(quote ?? "");
  return claimed.filter((term) => {
    const folded = kanaFolded(term);
    const forms = new Set<string>([folded]);
    for (const reading of FIRST_PERSON_READINGS[term] ?? []) forms.add(reading);
    for (const [kanji, readings] of Object.entries(FIRST_PERSON_READINGS)) {
      if (readings.includes(folded)) forms.add(kanji);
    }
    return ![...forms].some((form) => spoken.includes(form));
  });
}

/** 一人称の書き方を、後ろに続く「で、」「を使い、」ごと外すための形 */
const CLAIM_CLAUSE_AFTER_LABEL = new RegExp(
  String.raw`一人称(?:は|が)?[：:]?\s*(?:${QUOTED_TERMS}|(?:${WORD_ALTERNATION})(?=[でをと、。，,\s（(]|$))(?:を使い分け(?:る|て)|を使(?:う|い)|で)?[。、，,]?`,
  "gu"
);
const CLAIM_CLAUSE_BEFORE_LABEL = new RegExp(
  String.raw`${QUOTED_TERMS}という一人称(?:を使(?:う|い)|で)?[。、，,]?`,
  "gu"
);

/**
 * 口調の値から、一人称を書いた部分だけを外す（残りの読みは残す）。
 *
 * 一人称は台詞で確かめられる数少ない中身だが、語尾・敬語・話し方の読みは
 * 別の読みである。**一人称が確かめられなかっただけで、口調ごと捨てない**
 * （捨てると、台詞の検算を通った読みまで失う）。
 */
export function withoutFirstPersonClaims(value: string): string {
  return value
    .replace(CLAIM_CLAUSE_AFTER_LABEL, "")
    .replace(CLAIM_CLAUSE_BEFORE_LABEL, "")
    .replace(/^[\s、。，,]+/u, "")
    .trim();
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

/** 口調の変化の記録に使う項目名（`changes` の `field`） */
const SPEECH_STYLE_FIELD = "speechStyle";

/** 作者が「第N話から」と記録した口調の変化か（話数を持つ作者の記録だけ） */
export function isAuthorSpeechStyleChange(change: RecordChange): boolean {
  return (
    change.field === SPEECH_STYLE_FIELD &&
    change.source === "author" &&
    change.chapters.some((chapter) => Number.isSafeInteger(chapter))
  );
}

function startOf(change: RecordChange): number {
  return Math.min(
    ...change.chapters.filter((chapter) => Number.isSafeInteger(chapter))
  );
}

/**
 * 第N話の時点で、**作者が記録した口調**（作者の裁定、2026-09-26 夕。J9）。
 * その話までに記録が無ければ undefined（呼び出し側は面で巻き戻す）。
 *
 * 見るのは**話数を持つ作者の記録だけ**。話数の無い記録（手で書いたもの）を
 * 「それ以前」として使うと、最初の話まで1つの値で塗られ、第2話に第5話で
 * 初めて見えた面が載る（面で巻き戻す意味が無くなる）。
 */
export function authorSpeechStyleAsOf(
  changes: readonly RecordChange[],
  chapter: number
): string | undefined {
  let best: { value: string; at: number } | undefined;
  for (const change of changes) {
    if (!isAuthorSpeechStyleChange(change)) continue;
    const at = startOf(change);
    if (at > chapter) continue;
    if (!best || at >= best.at) best = { value: change.value, at };
  }
  return best?.value;
}

/**
 * 作者が「第N話から口調が変わった」と記録する（作者の裁定、2026-09-26 夕。
 * 残課題 J9。設計書 6.5.11）。受け取れないときは undefined（何もしない）。
 *
 * ## 記録の置き場
 *
 * **`changes` に、作者の値（`source: "author"`・`confirmed: true`）として
 * 置く。** 変化の記録はもともと「どの値が何話からか」の置き場で、矛盾検知の
 * 巻き戻し（6.10.3）・資料の「変化」の行・「誤りを落とす」がそのまま効く。
 * `authorNotes` には書かない（自由記述で、機械が話数を読めない）。
 *
 * - 変わった先：`chapters: [N]`
 * - 変わる前：第N-1話の時点で材料に載る口調を `chapters: [N-1]` で。
 *   第N話からの材料に「A（第N-1話）→ B（第N話）」と前後が並び、AIが
 *   「作者が決めた変化」と読める（変化の行は値が2つ以上で初めて出る）
 *
 * 変わる前を「それ以前」（話数なし）で置かないのは、その値（第N-1話までの
 * 面をつないだもの）が変化の行に載ったまま第2話の材料にも渡り、第2話に
 * まだ見えていない面が混ざるため（2026-09-25 精査 F1 と同じ漏れ）。
 * 第N-1話で置けば、それより前の話では変化の記録ごと切り詰められる。
 *
 * **本体（`speechStyle`）と面は変えない。** 本体を書き換えると「面の外で
 * 書き換えられた本体」になり、第N話より前の巻き戻しが面で行えなくなる。
 * `autoGenerated` も変えない（性格の「作中の変化にする」と同じ考え方）。
 *
 * ## 受け取らないもの
 *
 * - 話数が正の整数でない・口調が空
 * - **同じ話に、別の値の記録が既にある**——どちらが正しいか決められない。
 *   作者に「誤りを落とす」で先に落としてもらう（勝手に消さない。規則2）
 */
export function recordSpeechStyleChange(
  character: Character,
  fromChapter: number,
  value: string
): Character | undefined {
  const after = value.trim();
  if (!after) return undefined;
  if (!Number.isSafeInteger(fromChapter) || fromChapter < 1) return undefined;

  const changes = character.changes ?? [];
  const clash = changes.some(
    (change) =>
      isAuthorSpeechStyleChange(change) &&
      startOf(change) === fromChapter &&
      change.value.trim() !== after
  );
  if (clash) return undefined;

  const toChange = (text: string, chapter: number): RecordChange => ({
    field: SPEECH_STYLE_FIELD,
    value: text,
    chapters: [chapter],
    timepointId: null,
    note: null,
    evidence: null,
    source: "author",
    confirmed: true,
  });
  const added: RecordChange[] = [];
  if (fromChapter > 1) {
    // 第N-1話の時点で材料に載る口調（作者の記録 → 面の巻き戻し → 本体）。
    // 既に同じ値の記録があれば話数だけ足される（`mergeChangeLists`）
    const before = (
      authorSpeechStyleAsOf(changes, fromChapter - 1) ??
      speechStyleAsOf(character, fromChapter - 1) ??
      character.speechStyle
    )?.trim();
    if (before && before !== after) added.push(toChange(before, fromChapter - 1));
  }
  added.push(toChange(after, fromChapter));
  return { ...character, changes: mergeChangeLists(changes, added) };
}
