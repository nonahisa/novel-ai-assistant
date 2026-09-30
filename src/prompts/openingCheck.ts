import { isPlaceholderText } from "../core/placeholderText";
import {
  OPENING_DIRECTION_HINTS,
  OPENING_DIRECTION_NAME_MAX_CHARS,
  OPENING_DIRECTIONS_MAX,
  readOpeningDirections,
  type OpeningDirection,
} from "../core/openingDirections";
import {
  publicityReaderLabels,
  type PublicityReader,
} from "../core/publicityReader";
import { buildPublicityReaderPrompt } from "./publicityReader";
import {
  isNoAdviceFiller,
  readGroundedPraise,
  verbatimIn,
  type PraiseItem,
} from "../core/praise";

/**
 * P-24 冒頭診断（設計書6.30）
 *
 * 作者の創作論（note「WEB小説再入門」）より：WEB小説は**冒頭2,000〜3,000字で
 * 読み続けてもらえるかが決まる**。そこで要るのは、5W1H が高圧縮で伝わることと、
 * 続きへの期待感が生まれることの2つである。
 *
 * ## 作文をさせない
 *
 * この機能がAIにさせるのは「伝わっているか」の判定と、その根拠だけである。
 * 直し方や書き換え案まで書かせると、AIの文章が作者の冒頭を押し流す。
 * 推敲（P-10）が「作者は既に完成した文章として書いている」を前提に置いて
 * いるのと同じ理由で、ここでも**指摘までに留める**。
 *
 * ## 揃っていないことは、欠点ではない
 *
 * 冒頭で伏せるのは技法である。「誰が」を明かさない一人称も、「どこで」を
 * 終盤まで言わない導入もある。6要素すべてを埋めさせると、**意図した保留まで
 * 欠点として並び、作者は直さなくてよいものを直す。** そこで「意図的な保留」を
 * 判定の3つ目の状態として持たせている。
 *
 * ## 1回で終える
 *
 * 見るのは第1話の先頭3,000字だけなので、チャンクに割る必要が無い。
 * 割らないぶん、切れ目で「引きが無い」と誤判定されることもない。
 *
 * ## 無理に言わない・ほめる所は省かない（1.1、プロンプト設計書1.9）
 *
 * 作者の方針（2026-09-24）：「作品が高い水準でバランスをとっているとき、
 * 無理に助言を言わなくてもいいです。あと、ほめることができる場所は、
 * 省略せずきちんとほめてください。」
 *
 * 1.0 は総評に「いちばん効く直しどころを1点だけ」と頼んでいた。**1点を
 * 必ず書かせる形**なので、直す所の無い冒頭にも直しどころが作られていた。
 * 1.1 で「見当たらなければ空でよい」とし、効いている所（`strengths`）を
 * 本文の引用と「なぜ効いているか」つきで頼むようにした。**引用は本文と
 * 照合し、無いものは落とす**（規則3。`core/praise.ts`）。
 *
 * ## 読者に向けて直す方向（1.2）
 *
 * 作者の問い（2026-10-01）「冒頭のフックを強くできないか」に、1.1 の総評は
 * 診断で止まって答えられなかった。作者の裁定：**読者タイプを踏まえて、
 * 直す方向を数件並べる。例文・書き直し案は出さないまま。**
 *
 * - 読者は紹介文・キャッチコピーと**同じ材料・同じ優先順位**（ターゲットシートの
 *   狙い → 読者像。`core/publicityReader.ts`）。**読者が決まっていなければ
 *   方向を頼まない**——宛先の無い「読者に効く方向」はAIが読者を当て推量で
 *   決めることになる（紹介文が「読者層に合わせて」とだけ言わないのと同じ）
 * - 1件は「方向の短い名前・本文の根拠の引用・この読者になぜ効くか」。
 *   **最大4件、下限なし**（作者の言葉「無理してひねり出さなくても良いですよ」）。
 *   冒頭がすでに届いていれば0件が答え
 * - 例文・書き直した文・指示語のなぞりはコードで落とす（`core/openingDirections.ts`）
 * - 6要素と引きの判定は、読者によらず本文だけから行わせる（読者を渡したせいで
 *   判定が動くと、狙いを変えただけで「伝わる」が「伝わらない」に変わる）
 *
 * プロンプトを変更したら version を上げること。
 */
export const OPENING_CHECK_VERSION = "1.2";

/**
 * 版の文字列に読者の印を混ぜる（規則4。紹介文の `blurbPromptVersion` と同じ形）。
 *
 * 冒頭診断は答えを控えないが、**MCP で測った答えがどの読者に向けたものか**を
 * 版の文字列で区別できるようにする。
 *
 * @param readerMark `publicityReaderMark()` の返り値（無ければ "none"）
 */
export function openingCheckPromptVersion(readerMark: string): string {
  return `${OPENING_CHECK_VERSION}|reader:${readerMark}`;
}

/**
 * 送るときの温度。判定と根拠を出すだけなので揺らす理由が無い。0にしないのは、同じ言い回しが6要素に並ぶのを避けるため。
 *
 * **製品も測定台もここを見る**（プロンプトと温度は一対なので、版と同じ場所に置く）。
 */
export const OPENING_CHECK_TEMPERATURE = 0.2;

/**
 * AIへ渡す冒頭本文の上限。
 *
 * 作者の創作論でいう「冒頭2,000〜3,000字」の上限に合わせてある。
 * ここを増やすと、**冒頭で決まるかどうかを見る**という前提そのものが崩れる
 * （中盤まで読んだAIは、冒頭で伏せられている情報も知ってしまう）。
 */
export const OPENING_EXCERPT_MAX_CHARS = 3000;

/** 診断する6要素。表もこの順に出す */
export const OPENING_ELEMENTS = [
  "いつ",
  "どこで",
  "誰が",
  "何を",
  "なぜ",
  "どのように",
] as const;

export type OpeningElement = (typeof OPENING_ELEMENTS)[number];

/** 材料が無い項目に入れる文字。伏せずに「無い」と書いて渡す */
export const UNSET_MATERIAL = "（未設定）";

export const OPENING_CHECK_SYSTEM_PROMPT = `あなたは日本語の小説の冒頭を読み、読者に何が伝わるかを診断するアシスタントです。

【絶対に守る原則】
1. 文章を書き直さないこと。改善案・書き換え案・例文を一切出さないこと。
   あなたが出すのは「伝わっているか」の判定と、その根拠と、
   頼まれたときだけ「直す方向」の短い名前とその理由までです。
   文を書くのは作者です。
2. 判定の根拠は、本文に実際に書かれている記述から取ること。
   本文に書かれていないことを推測で補わないこと。
3. 作品世界の設定（造語、固有名詞、独自の言い回し）を誤りとして扱わないこと。
4. 出力は指定されたJSON形式のみとし、前置き・後書き・説明文・
   マークダウンのコードフェンスを一切含めないこと。`;

export interface OpeningCheckPromptInput {
  workTitle: string;
  /** プロットのジャンル。無ければ空文字 */
  genre: string;
  /** プロットのログライン。無ければ空文字 */
  logline: string;
  /** 第1話の冒頭（先頭 OPENING_EXCERPT_MAX_CHARS 字） */
  openingText: string;
  /**
   * この作品の読者（ターゲットシートの狙い → 読者像。`resolvePublicityReader`）。
   * **無ければ直す方向を頼まない**（1.2）
   */
  reader?: PublicityReader;
}

/**
 * 読者の塊のあとに添える、冒頭診断での使い方。
 *
 * 塊の前置き（紹介文と共用）は「言い方を選ぶ目安に」と書いてあるので、
 * ここでは**何に使い、何に使わないか**を言い直す。判定まで読者で動くと、
 * 狙いを変えただけで5W1Hの答えが変わる。
 */
const READER_USE_NOTE = `この冒頭診断では、上の読者を「5. 直す方向」で、この読者にとってなぜ効くかを言うためにだけ使ってください。
5W1Hと引きの判定は、読者によらず本文だけから行ってください。`;

/** 読者があるときの「5.」。**下限を書かない**（1.9。0件も普通の答え） */
function directionsInstruction(): string {
  return `5. 直す方向：【この作品の読者】に、この冒頭がもっと届くようにする方向を、
   本文に根拠があって、出す理由のあるものだけ directions に入れてください。
   多くても${OPENING_DIRECTIONS_MAX}件までです。数を埋めるために作らないこと。
   この冒頭がすでにこの読者に届いていて、挙げる理由が無ければ、
   directions は空の配列にしてください。それも普通の答えです。
   - direction：${OPENING_DIRECTION_HINTS.direction}（${OPENING_DIRECTION_NAME_MAX_CHARS}字以内）
   - quote：${OPENING_DIRECTION_HINTS.quote}を、40字以内で逐語で引用する（言い換えない）
   - why：${OPENING_DIRECTION_HINTS.why}
   方向は「何をどちらへ動かすか」までに留め、文そのものは書かないこと。
   例文・書き換えた文・台詞の案を書かないこと。本文に無い文をかぎ括弧で書かないこと。`;
}

/** 読者が無いときの「5.」。欄は required なので、空で返すことだけを頼む */
const NO_DIRECTIONS_INSTRUCTION = `5. directions は空の配列にしてください（この作品の読者が決まっていないため、今回は頼みません）。`;

export function buildOpeningCheckPrompt(input: OpeningCheckPromptInput): string {
  const readerBlock = buildPublicityReaderPrompt(input.reader);
  const readerSection = readerBlock
    ? `\n${readerBlock}\n\n${READER_USE_NOTE}\n`
    : "";
  return `次の小説の冒頭を読み、読者に何が伝わるかを診断してください。

【作品タイトル】
${input.workTitle}

【ジャンル】
${input.genre.trim() || UNSET_MATERIAL}

【ログライン】
${input.logline.trim() || UNSET_MATERIAL}
${readerSection}
【冒頭本文】（第1話の先頭${OPENING_EXCERPT_MAX_CHARS}字まで）
${input.openingText}

【診断すること】
1. 5W1Hの6要素（${OPENING_ELEMENTS.join("・")}）それぞれについて、
   この冒頭を読んだ読者に伝わるかを判定してください。
   - 伝わるなら conveyed を true にし、本文のどの記述から伝わるのかを
     note に書いてください。そのとき本文を20字以内で逐語で引用すること
     （言い換えない）。
   - 伝わらないなら conveyed を false にし、何が分からないままかを
     note に書いてください。
2. 期待感：続きを読みたくなる引き（謎・目標・異常事態など）が
   どこにあるかを判定してください。あるなら hook.present を true にして、
   どの箇所がそれにあたるかを note に書いてください。
   無ければ false にして、無いとだけ書いてください。探して作り出さないこと。
3. 効いている所：この冒頭で読者を引き込むのに効いている箇所を、
   見つかったぶんだけ strengths に入れてください。数を絞る必要はありません。
   quote には本文を40字以内で逐語で引用し（言い換えない）、
   why にはなぜ効いているのかを具体的に書いてください。
   「全体的に良い」のような、箇所を指さないほめ方はしないこと。
   本文から引いて示せる所が無ければ、strengths は空の配列にしてください。
4. 総評：直すべき所があれば、この冒頭でいちばん効く直しどころを advice に書いてください。
   2文以内で、2点以上は書かないこと。
   直すべき所が見当たらなければ、advice は空にしてください。
   直す所を無理に探して作らないこと。
${readerBlock ? directionsInstruction() : NO_DIRECTIONS_INSTRUCTION}

【注意】
- 6要素がすべて揃っている必要はありません。冒頭で伏せるのは技法です。
  作者が意図して伏せていると読めるものは、欠点として扱わず、
  conveyed を false にしたうえで note の先頭に「意図的な保留」と書いてください。
- どの欄にも、書き換え案・例文を書かないこと。
  総評は「〜が伝わっていない」という指摘までに留めること。
- 造語・固有名詞・独自の言い回しを誤りとして扱わないこと。
  読者が知らない名前が出てくること自体は欠点ではありません。
- 6要素と引きの note には、「なし」「特になし」とだけ書かないこと。
  何が無いのか、何が分からないままなのかを書いてください。`;
}

/**
 * 構造化出力のスキーマ。
 *
 * **すべて required にする。** 任意にすると、地力の足りないモデルは
 * 埋めずに落とす（この作品では抽出・推敲・逸脱のすべてで踏んだ）。
 * 「材料が無い」ことも、空欄ではなく言葉で書かせる。
 */
export const OPENING_CHECK_SCHEMA = {
  type: "object",
  properties: {
    elements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          element: { type: "string", enum: OPENING_ELEMENTS },
          conveyed: { type: "boolean" },
          note: { type: "string" },
        },
        required: ["element", "conveyed", "note"],
        additionalProperties: false,
      },
    },
    hook: {
      type: "object",
      properties: {
        present: { type: "boolean" },
        note: { type: "string" },
      },
      required: ["present", "note"],
      additionalProperties: false,
    },
    // **ほめる欄も required にする**（1.9）。任意にすると、小さいモデルは
    // 助言だけ書いて落とす——ほめる欄が後回しになる形そのものである
    strengths: {
      type: "array",
      items: {
        type: "object",
        properties: {
          quote: { type: "string" },
          why: { type: "string" },
        },
        required: ["quote", "why"],
        additionalProperties: false,
      },
    },
    advice: { type: "string" },
    // **読者が無い回も欄は持つ（required）。** 回ごとにスキーマを変えると、
    // 製品と MCP で形が揃っているかを確かめる手間が倍になる。読者が無い回は
    // プロンプトで空を頼み、返ってきても読み取り側が捨てる（`directionsRequested`）
    directions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          direction: { type: "string" },
          quote: { type: "string" },
          why: { type: "string" },
        },
        required: ["direction", "quote", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["elements", "hook", "strengths", "advice", "directions"],
  additionalProperties: false,
} as const;

export interface OpeningElementJudgement {
  element: OpeningElement;
  conveyed: boolean;
  /** 判定の根拠。指示語のなぞりは空にしてある */
  note: string;
}

export interface OpeningHookJudgement {
  present: boolean;
  note: string;
}

export interface OpeningCheckResult {
  elements: OpeningElementJudgement[];
  /**
   * 期待感の判定。読み取れなければ null。
   *
   * **読めなかったことを「引きが無い」に落とさない。** false は
   * 「AIが探して見つからなかった」であり、null は「AIが答えなかった」である。
   * 混ぜると、答えが返らなかっただけの冒頭に「引きがありません」と出る。
   */
  hook: OpeningHookJudgement | null;
  /**
   * 総評（直しどころ）。**直すべき所が無ければ空文字。**
   * 「特になし」のような埋め草も空へ落とす（1.9の5）
   */
  advice: string;
  /**
   * 総評の欄が応答に在ったか。
   *
   * **空の総評を「返らなかった」と取り違えない**（1.9の1）。欄が在って
   * 空なら「直すべき所は見当たりません」、欄ごと無ければ「返りませんでした」
   */
  adviceAnswered: boolean;
  /** 効いている所。**本文との照合を通ったものだけ**（規則3） */
  strengths: PraiseItem[];
  /** 引用が本文に見つからず落としたほめ言葉の数。**黙って減らさない** */
  strengthsDropped: number;
  /**
   * 直す方向を頼んだ回か（読者が決まっていた回）。
   *
   * **頼んでいない回の方向は捨てる**——宛先の読者が無いまま書かれた方向を、
   * 読者に向けたものと同じ顔で出さない。画面は「読者を決めると出せます」と案内する
   */
  directionsRequested: boolean;
  /**
   * 読者に向けて直す方向。**照合と例文の検査を通ったものだけ**（規則3）。
   * **0件は普通の答え**（1.9）
   */
  directions: OpeningDirection[];
  /** 方向の欄が応答に在ったか。0件の答えと、欄ごと返らなかったことを分ける */
  directionsAnswered: boolean;
  /** 落とした方向の数。**黙って減らさない** */
  directionsDropped: {
    notFound: number;
    exampleLike: number;
    overLimit: number;
  };
}

export interface ParseOpeningCheckOptions {
  /**
   * 直す方向を頼んだか（プロンプトへ読者を渡したか）。
   * **既定は頼んでいない**——渡し忘れたときに、宛先の無い方向を出さない側へ倒す
   */
  directionsRequested?: boolean;
}

/**
 * 応答を読み取る。
 *
 * **6要素が1つも読めなければ諦める**（undefined）。診断の本体がそこなので、
 * 表が空の報告を見せても作者の役に立たない。一方、期待感と総評は
 * 欠けても残りを見せる——1項目のために全部を捨てるほうが損である。
 *
 * @param openingText AIへ渡した冒頭本文。**ほめる欄の引用の照合に使う。**
 *   渡されなければ照合できないので、ほめる欄は1件も通さない
 *   （照合していない引用を、照合したものと同じ顔で出さない）
 */
export function parseOpeningCheck(
  text: string,
  openingText = "",
  options: ParseOpeningCheckOptions = {}
): OpeningCheckResult | undefined {
  const source = extractJson(text);
  if (!source) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  const elements = readElements(parsed.elements);
  if (elements.length === 0) return undefined;

  const praise = readGroundedPraise(parsed.strengths, verbatimIn(openingText));
  const advice = cleanNote(parsed.advice);
  const requested = options.directionsRequested === true;
  // 頼んでいない回は読まない（照合もしない）。欄が在っても捨てる
  const directions = requested
    ? readOpeningDirections(parsed.directions, openingText)
    : undefined;
  return {
    elements,
    hook: readHook(parsed.hook),
    advice: advice && isNoAdviceFiller(advice) ? "" : advice,
    adviceAnswered: typeof parsed.advice === "string",
    strengths: praise.items,
    strengthsDropped: praise.notFound,
    directionsRequested: requested,
    directions: directions?.items ?? [],
    directionsAnswered: requested && Array.isArray(parsed.directions),
    directionsDropped: {
      notFound: directions?.notFound ?? 0,
      exampleLike: directions?.exampleLike ?? 0,
      overLimit: directions?.overLimit ?? 0,
    },
  };
}

/**
 * 画面・ログ・MCP の返り値で使う、見た読者の言い方。
 *
 * 狙い（作者が選んだ）と読者像（診断の結果）は重みが違うので、どちらかを添える。
 * 読者が無ければ `undefined`。
 */
export function openingReaderLabel(
  reader: PublicityReader | undefined
): string | undefined {
  if (!reader) return undefined;
  const labels = publicityReaderLabels(reader);
  return reader.source === "aim"
    ? `狙いの読者（${labels}）`
    : `読者像（${labels}）`;
}

function readElements(value: unknown): OpeningElementJudgement[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<OpeningElement>();
  const judgements: OpeningElementJudgement[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    if (typeof entry.conveyed !== "boolean") continue;

    const named = typeof entry.element === "string" ? entry.element : "";
    const element = OPENING_ELEMENTS.find((name) => name === named);
    // 同じ要素を2回返してくることがある。**先に来たものを残す**——
    // 後勝ちにすると、言い直しのたびに判定が入れ替わって再現しない
    if (!element || seen.has(element)) continue;
    seen.add(element);

    judgements.push({
      element,
      conveyed: entry.conveyed,
      note: cleanNote(entry.note),
    });
  }
  return judgements;
}

function readHook(value: unknown): OpeningHookJudgement | null {
  if (!isRecord(value)) return null;
  if (typeof value.present !== "boolean") return null;
  return { present: value.present, note: cleanNote(value.note) };
}

/**
 * 根拠・総評の文字列を整える。
 *
 * **指示語のなぞりは空へ落とす**（`isPlaceholderText`）。「なし」「特になし」
 * だけの根拠は根拠ではなく、表に並べると判定の裏づけがあるように見える。
 *
 * 広いほうの一覧（`wholeReplacement`）を使う。あれは「一文まるごとを
 * 置き換える場面でだけ足す」ものだが、**ここは本文へ書き戻さない**ので、
 * 取りこぼすより落とすほうが害が小さい（「なし」は誤字の直しにはなりうるが、
 * 診断の根拠には決してならない）。
 */
function cleanNote(value: unknown): string {
  if (typeof value !== "string") return "";
  // 改行を含むと表の行が壊れる。整形側で潰すより、読んだ時点で揃えておく
  const body = value.trim().replace(/\s+/g, " ");
  if (!body) return "";
  return isPlaceholderText(body, true) ? "" : body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 応答からJSONの本体を切り出す。
 *
 * 構造化出力に対応していないモデルは、前置きやコードフェンスを付けてくる。
 * `searchTerms.ts` と同じ手で、最初の `{` から最後の `}` までを取る。
 */
function extractJson(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  return body.slice(start, end + 1);
}
