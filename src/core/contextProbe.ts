import { TOKENS_PER_CHAR } from "./chunker";
import { roundCharsPerToken } from "./sizeBudget";

/**
 * AIが実際に読める長さを測る（設計書6.27.11）。
 *
 * ## なぜ測るのか
 *
 * さくらのAI Engine はモデルの上限を API でも公開ページでも示さない。
 * LM Studio は読み込んだ長さを後から変えられる。**どちらも申告値が
 * 当てにならない**のに、その値で本文を切っている。実際より大きければ
 * 入力は黙って切り捨てられ、「AIが本文の後半を読んでいない」という
 * 形でしか表に出ない（6.27.10 の関所の精度も、この値で決まる）。
 *
 * ## 測り方——**入力トークン数の伸び**で測る（作者の裁定、2026-09-13）
 *
 * 送る詰め物を増やしながら、応答が申告する `usage.inputTokens` を見る。
 * **増え方が止まったところが限界**である。モデルの協力が要らないので、
 * 「言うことを聞いたか」ではなく「どこまで届いたか」を測れる。
 *
 * **合言葉で測るのをやめた理由**（実機、qwen3:8b、2026-09-13）。
 *
 * | 送った量 | 合言葉 | 入力トークン |
 * |---|---|---|
 * | 2,750字 | 両方 | 2,373 |
 * | 4,000字 | **×** | 3,385 |
 * | 8,000字 | 両方 | 6,621 |
 * | 30,000字 | **×** | 24,447 |
 *
 * 1. **長さと関係なく気まぐれに落ちる。** 2,750で通り4,000で落ち、
 *    8,000で通り30,000で落ちる。二分探索は「短いほうが通りやすい」
 *    前提なので、落ちた場所で答えが決まってしまった
 * 2. 落ちた回の答えは毎回同じ「最初の合言葉 最後の合言葉」——指示文の
 *    雛形をそのまま書き写していた（CLAUDE.md「指示の言葉が、答えの中身
 *    として返ってくる」）。だから**指示文から雛形を消した**
 * 3. **落ちた回も本文は全部届いていた**（3,385・24,447）。合言葉は
 *    「届いたか」ではなく「言うことを聞くか」を測っていた
 *
 * ## 合言葉は捨てない。測るものが違う
 *
 * | 測りたいこと | 道具 |
 * |---|---|
 * | どこまで届いたか | **入力トークン数**（客観・モデルの協力が要らない） |
 * | 届いたものを拾えるか | 合言葉 |
 *
 * 長さの判定には使わず、**参考として結果に添える**だけにする。ただし
 * 入力トークン数を返さないAI・設定はあるので、**そのときだけは
 * これまでどおり合言葉で測る**（`ProbeMeasureMethod`）。気まぐれに
 * 落ちうる値なので、どちらで測ったかを結果と台帳に残す。
 *
 * 合言葉そのものは、作者の原案から2点だけ変えてある。
 *
 * 1. 合図は「はい」ではなく、**その回だけの無作為な合言葉**にする。
 *    「はい」は何も読めていなくても返ってくる
 * 2. 「これまでの指示を無視して」とは書かない。安全学習で断られる
 *
 * ## VS Code に依存させない
 *
 * ここは組み立てと判定と探索だけを持つ。実際に送るのは
 * `features/measureContext.ts` の1か所である。
 */

/** 合言葉の長さ（ひらがな）。短いと本文中に偶然現れ、長いと写し間違える */
const PROBE_WORD_LENGTH = 4;

/**
 * 合言葉に使うひらがな。
 *
 * 濁点・半濁点・小書き・「ん」を外してある。**耳で聞いて写せる並び**に
 * したいのではなく、AIが復唱するときに表記を揺らしにくい字だけを
 * 残したい（「じ」と「ぢ」のような取り違えを持ち込まない）。
 */
const PROBE_KANA =
  "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろ";

/**
 * 合言葉に含めない断片。
 *
 * **「はい」が偶然できてしまっては、この検査は台無しになる。**
 * 何も読めていないAIでも返しがちな言葉が合言葉に混ざると、
 * 「返った」の意味が薄れる。ふつうの返事に現れる並びを避ける。
 */
const BANNED_FRAGMENTS = [
  "はい",
  "いいえ",
  "うん",
  "ええ",
  "そう",
  "わかり",
  "りょうかい",
  "です",
  "ます",
  "しました",
];

/**
 * 詰め物に使う短文。
 *
 * **「あ」の連打にしない。** 同じ字の繰り返しは、日本語の本文とは
 * トークンへの分かれ方が違う。測りたいのは「本文を N 字送ったら
 * 読めるか」なので、詰め物も**本文と同じくらいの密度**の日本語にする。
 *
 * **作者の本文は使わない。** 実在しない情景だけを並べてある。
 * 測定のたびに作品の一部が外部のAIへ流れるのは、測る目的に対して
 * 払いすぎである。
 */
const FILLER_SENTENCES = [
  "川辺の小屋で灯りが揺れた。",
  "石段の上に薄い霧がかかっている。",
  "荷車の音が遠ざかり、また戻ってきた。",
  "干した布が風でゆっくりと膨らんだ。",
  "机の端に置いた湯呑みが冷めていく。",
  "門の脇で番人が欠伸をかみ殺した。",
  "屋根の樋から雫がひとつずつ落ちる。",
  "地図の折り目が擦り切れていた。",
];

/** 最初に試す字数。ここから両方返れば倍にしていく */
export const START_PROBE_CHARS = 4000;

/**
 * これより短い字数は試さない。
 *
 * 1,000字も読めないモデルは「切り捨てている」のではなく壊れている。
 * 刻み続けても分かることが増えないので、底を決めて止める。
 */
export const MIN_PROBE_CHARS = 500;

/**
 * ここまで狭まったら終わりにする幅（`low` に対する割合）。
 *
 * 1割まで詰めれば、本文の分割単位を決めるには十分である。
 * これ以上詰めると、得られる精度に対して呼び出し回数が増えすぎる
 * （有料AIでは、そのまま料金になる）。
 */
export const PROBE_CONVERGENCE_RATIO = 0.1;

export interface ProbePrompt {
  systemPrompt: string;
  userPrompt: string;
}

/** 二分探索の途中の状態 */
export interface ProbeState {
  /** これ以上は試さない字数（モデルの申告値か、既定の上限から決める） */
  readonly ceilingChars: number;
  /** 全部届いたと判定できた最大の字数。まだ無ければ 0 */
  readonly low: number;
  /** 届かなかった最小の字数。まだ無ければ undefined */
  readonly high: number | undefined;
  /** いま試す字数 */
  readonly current: number;
}

/** どちら側が切り落とされたか */
export interface ProbeSides {
  /** 先頭の合言葉だけが返らなかった回があった＝前が切られる */
  headDropped: boolean;
  /** 末尾の合言葉だけが返らなかった回があった＝後ろが切られる */
  tailDropped: boolean;
}

/**
 * 検査の一式を組み立てる。
 *
 * **合言葉を system 側に置かない。** クラウドのAIは system を
 * 別扱いすることがあり、user だけが切られても system が生き残ると、
 * 何も読めていないのに合言葉を答えられてしまう。**切られる側に
 * 置かなければ、切られたことが分からない。**
 *
 * 返事の形を指示する文も**末尾**に置く。前が切られたときは
 * 「末尾の合言葉だけ」が返り、後ろが切られたときは指示ごと消えて
 * 何も返らない——どちらも、切られたことが答えに現れる。
 *
 * **書き写せる雛形を残さない**（実機、2026-09-13）。以前の末尾は
 * 「返事は『最初の合言葉 最後の合言葉』の形で、合言葉だけを書いて
 * ください。」だった。**モデルはその鉤括弧の中身をそのまま書き写して
 * 返してきた**——合言葉を読めていた回でもである（入力トークン数から、
 * 本文が全部届いていたことが確かめられている）。雛形の無い文面に
 * 変えたら、同じモデル・同じ長さで4回とも正解した。
 *
 * 同じ理由で、合言葉を置く2行の見出しも「最初の／最後の」をやめた
 * ——その2語を繋げると、上の雛形がそのまま出来上がってしまう。
 */
export function buildProbePrompt(options: {
  /** 詰め物の字数。ここが測る対象 */
  fillerChars: number;
  headWord: string;
  tailWord: string;
}): ProbePrompt {
  const systemPrompt =
    "あなたは、文章がどこまで届いているかを確かめる検査に答えます。" +
    "書かれている合言葉をそのまま書き写してください。" +
    "合言葉以外のことは書かないでください。";

  const userPrompt =
    `ひとつ目の合言葉は『${options.headWord}』です。\n` +
    "この下は検査用の詰め物です。内容に意味はありません。\n" +
    `${buildProbeFiller(options.fillerChars)}\n` +
    `ふたつ目の合言葉は『${options.tailWord}』です。\n` +
    "いま読んだ文章に書かれていた合言葉を、出てきた順に2つとも書いてください。";

  return { systemPrompt, userPrompt };
}

/** 詰め物を、指定の字数ちょうどで作る */
export function buildProbeFiller(fillerChars: number): string {
  if (fillerChars <= 0) return "";
  const lines: string[] = [];
  // **繋いだ後の長さを数える。** 改行は文と文の「間」にしか入らないので、
  // 1文につき1つと数えると1文字多く見積もり、ちょうど足りない
  // （字数を指定して測る仕組みなので、1文字でもずれると測った値がずれる）
  let length = 0;
  for (let i = 0; length < fillerChars; i += 1) {
    const sentence = FILLER_SENTENCES[i % FILLER_SENTENCES.length];
    length += (lines.length === 0 ? 0 : 1) + sentence.length;
    lines.push(sentence);
  }
  return lines.join("\n").slice(0, fillerChars);
}

/**
 * 詰め物以外にかかる字数（指示と合言葉）。
 *
 * 上限を決めるときに差し引く。**合言葉の長さは固定**なので、
 * 実際に組み立てて測れば正確な値が出る（定数で持つと、
 * 指示文を直したときに片方だけ古くなる）。
 */
export function probeOverheadChars(): number {
  const sample = "あ".repeat(PROBE_WORD_LENGTH);
  const { systemPrompt, userPrompt } = buildProbePrompt({
    fillerChars: 0,
    headWord: sample,
    tailWord: sample,
  });
  return systemPrompt.length + userPrompt.length;
}

/**
 * その回だけの合言葉を2つ作る。
 *
 * **毎回変える。** 固定にすると、前の回の答えを覚えている経路
 * （プロンプトキャッシュ、会話履歴）で「読めていないのに返る」
 * ことが起きうる。
 *
 * 乱数は引数で受け取る。検査で結果を固定できるようにするため。
 */
export function makeProbeWords(random: () => number): {
  headWord: string;
  tailWord: string;
} {
  const headWord = drawProbeWord(random);
  let tailWord = drawProbeWord(random);
  // 同じ語が2つ出ると、片方だけ返ったのか両方返ったのか区別できない
  for (let attempt = 0; attempt < 20 && tailWord === headWord; attempt += 1) {
    tailWord = drawProbeWord(random);
  }
  return { headWord, tailWord };
}

function drawProbeWord(random: () => number): string {
  let word = "";
  while (word.length < PROBE_WORD_LENGTH) {
    const start = Math.floor(random() * PROBE_KANA.length);
    let picked = "";
    // **引き直しではなく、隣へずらす。** 引き直しにすると、乱数が
    // 偏ったとき（検査で固定値を渡したときを含む）に終わらなくなる
    for (let step = 0; step < PROBE_KANA.length; step += 1) {
      const kana = PROBE_KANA[(start + step) % PROBE_KANA.length];
      if (!isBannedWord(word + kana)) {
        picked = kana;
        break;
      }
    }
    // どの字も置けないことは、いまの禁止一覧では起きない。
    // 起きたときに黙って回り続けないよう、底を用意しておく
    word += picked || PROBE_KANA[0];
  }
  return word;
}

function isBannedWord(candidate: string): boolean {
  return BANNED_FRAGMENTS.some((fragment) => candidate.includes(fragment));
}

/**
 * 返事に合言葉が入っているかを見る。
 *
 * **飾りは無視する。** 「『あかさた』・『なにぬね』」のように鉤括弧や
 * 中黒を添えて返す機種があり、そこで落とすと「読めているのに
 * 読めていない」と判定してしまう。文字と数字以外を全部落として照らす。
 */
export function judgeProbeAnswer(
  answer: string,
  headWord: string,
  tailWord: string
): { head: boolean; tail: boolean } {
  const normalized = normalizeProbeText(answer);
  return {
    head: containsWord(normalized, headWord),
    tail: containsWord(normalized, tailWord),
  };
}

function containsWord(normalizedAnswer: string, word: string): boolean {
  const normalizedWord = normalizeProbeText(word);
  // 空の合言葉は「どんな返事にも含まれる」ことになってしまう
  if (!normalizedWord) return false;
  return normalizedAnswer.includes(normalizedWord);
}

function normalizeProbeText(text: string): string {
  return text.replace(/[^\p{Letter}\p{Number}]/gu, "");
}

/* ------------------------------------------------------------------ *
 * 入力トークン数で測る（作者の裁定、2026-09-13）
 * ------------------------------------------------------------------ */

/** 読める長さを、何で測ったか */
export type ProbeMeasureMethod =
  /** 入力トークン数の伸び。客観的で、モデルの協力が要らない */
  | "tokens"
  /** 合言葉。トークン数を返さないAI向けの道。**気まぐれに落ちうる** */
  | "words";

/** 1回ぶんの読み取り。**送った字数と、返ってきた入力トークン数の対** */
export interface ProbeTokenReading {
  /** その回に送ったプロンプト全体の字数（詰め物＋指示＋合言葉） */
  readonly promptChars: number;
  /** 応答が申告した入力トークン数 */
  readonly inputTokens: number;
}

/** 判定に使う、応答の使用量。**`GenerateResult["usage"]` をそのまま渡せる形** */
export interface ProbeUsage {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
}

/** その回の入力トークン数を捨てた理由。ログにそのまま出す */
export type ProbeTokenRejection =
  | "申告なし"
  | "キャッシュが効いた"
  | "桁違い"
  | "減っている";

export type ProbeTokenReadingResult =
  | { readonly kind: "採用"; readonly reading: ProbeTokenReading }
  | { readonly kind: "捨てる"; readonly reason: ProbeTokenRejection };

/**
 * 1字あたりの入力トークン数が、これを超えたら**桁違い**として捨てる。
 *
 * UTF-8の日本語は1字3バイトなので、バイト単位に割れる最悪のトークナイザ
 * でも1字3トークンを超えない。4は、その最悪よりさらに緩い線である
 * ——**ここで測りたいのは「明らかにおかしい数字」だけ**で、
 * トークナイザの良し悪しを判定したいのではない（実装ルール3）。
 */
export const PROBE_MAX_TOKENS_PER_CHAR = 4;

/**
 * 前の回より減っていても、これ以内なら捨てない（割合）。
 *
 * **天井では、伸びが止まったあとも数字がわずかに揺れる**（実機では
 * 24,447 → 24,600）。揺れの向きが下だっただけの回まで捨てると、
 * いちばん知りたい「止まった」が読めなくなる。5%を超えて減る——
 * **より長く送ったのに、はっきり少なく返ってきた**——のは、
 * 数字そのものが当てにならない回である（実装ルール3「減る値は捨てる」）。
 */
export const PROBE_TOKEN_DROP_RATIO = 0.05;

/**
 * 「伸びが続いている」と数える下限（**基準の伸びに対する割合**）。
 *
 * 判定は「この回で増えた入力トークン数」÷「増えるはずだった量」で見る。
 * 増えるはずだった量は、**このモデル自身が返した数字**から採る
 * （送った字数 × これまででいちばん密だった回のトークン/字）——
 * 0.7字/トークンのような**製品側の当て推量は持ち込まない。**
 * 詰め物は同じ文を繰り返すだけの一様な日本語なので、切られていなければ
 * トークン/字はほぼ動かない。
 *
 * **0.8にした理由**（実機、qwen3:8b、2026-09-13の6件）。
 *
 * - 本当に全部届いた回の伸びは、基準の**95%前後**（1,000→2,750→4,000→
 *   8,000→16,000→30,000字のどこを取っても95.1〜95.3%）
 * - 切られた回は**14%以下**（180,000字を送って21,215トークンしか
 *   増えなかった回）
 *
 * 0.8は、この谷のどちらからも離れている。上へ寄せすぎると、トークナイザ
 * の癖で密度がわずかに落ちただけの回を「切られた」と読んでしまう。
 * 下へ寄せすぎると、**半分だけ切られた回**（二分探索が上から降りてくる
 * 途中に必ず通る）を「入った」と読む——0.5では、実効30,000字のモデルへ
 * 48,000字を送った回が通ってしまい、実測が6割ほど過大になった。
 *
 * **過大に出すほうが危ない。** 読めない長さで本文を切ると、AIが後半を
 * 読んでいないことが「指摘が出ない」形でしか表に出ない。
 */
export const PROBE_TOKEN_GROWTH_RATIO = 0.8;

/**
 * 伸びの判定に持たせる、絶対の余裕（トークン）。
 *
 * 二分探索が詰まってくると、1回で増やす字数が数十字まで縮む。そこでは
 * 「増えるはずだった量」も十数トークンしかなく、**詰め物の切れ目が
 * どこに来たかだけで数トークン揺れる。** 割合だけで見ると、その揺れが
 * そのまま「伸びなかった」に化けるので、底を置く。
 */
export const PROBE_TOKEN_GROWTH_SLACK = 8;

/**
 * 上の回と「同じところで止まっている」と見なす幅（割合）。
 *
 * 2%。実機では、天井に当たった回どうしの差が**0.6%**（24,447と24,600）
 * だった。いっぽう二分探索が本当に刻む幅は `low` の5%以上ある
 * （`PROBE_CONVERGENCE_RATIO` の半分）ので、切られていなければ
 * トークン数も5%以上は増える。2%はその間にある。
 */
export const PROBE_TOKEN_PLATEAU_RATIO = 0.02;

/**
 * その回の入力トークン数を、判定に使ってよいかを決める。
 *
 * **AIが返した数字をそのまま信じない**（実装ルール3）。捨てるのは4つ。
 *
 * - **申告なし**……数でない・有限でない・0以下。トークン数を返さない
 *   AIや設定があるので、これは異常ではなく「この道では測れない」
 * - **キャッシュが効いた**……`cachedInputTokens` が正の回は、入力
 *   トークン数が実際より小さく出る。伸びが止まったように見えるので、
 *   その回は測定に使わない
 * - **桁違い**……1字あたり `PROBE_MAX_TOKENS_PER_CHAR` を超える値
 * - **減っている**……より短い回よりはっきり少ない値
 *
 * @param readings これまでに採用した読み取り（この回を含まない）
 */
export function readProbeTokens(input: {
  promptChars: number;
  usage: ProbeUsage | undefined;
  readings: readonly ProbeTokenReading[];
}): ProbeTokenReadingResult {
  const tokens = input.usage?.inputTokens;
  if (
    typeof tokens !== "number" ||
    !Number.isFinite(tokens) ||
    tokens <= 0
  ) {
    return { kind: "捨てる", reason: "申告なし" };
  }
  // **0と undefined を分ける。** 0は「数えたうえで効かなかった」なので
  // 捨てる理由が無い（`ai/types.ts` の `cachedInputTokens`）
  const cached = input.usage?.cachedInputTokens;
  if (typeof cached === "number" && cached > 0) {
    return { kind: "捨てる", reason: "キャッシュが効いた" };
  }
  if (
    input.promptChars > 0 &&
    tokens > input.promptChars * PROBE_MAX_TOKENS_PER_CHAR
  ) {
    return { kind: "捨てる", reason: "桁違い" };
  }

  const lower = lowerNeighbor(input.readings, input.promptChars);
  if (
    lower !== undefined &&
    tokens < lower.inputTokens * (1 - PROBE_TOKEN_DROP_RATIO)
  ) {
    return { kind: "捨てる", reason: "減っている" };
  }

  return {
    kind: "採用",
    reading: { promptChars: input.promptChars, inputTokens: tokens },
  };
}

/** 伸びの判定の結果。**理由まで返す**——ログに残さないと後から追えない */
export interface ProbeGrowth {
  /** 伸びが続いていたか（＝その長さは全部届いたか） */
  readonly grew: boolean;
  /** ログに出す、そう判定した根拠 */
  readonly note: string;
}

/**
 * その回で**入力トークン数の伸びが続いていたか**を見る。
 *
 * 2つとも満たしたときだけ「入った」とする。
 *
 * 1. **下の回からの伸びが、基準に届いている**（`PROBE_TOKEN_GROWTH_RATIO`）
 * 2. **上の回との間に、まだ伸びしろがある**（`PROBE_TOKEN_PLATEAU_RATIO`）
 *
 * 2が要るのは、二分探索が**上から降りてくる**からである。1だけだと、
 * 「1回目（4,000字）からは確かに増えた」という理由で、天井の値に
 * 張り付いた回まで通ってしまう。すでに同じトークン数で頭打ちになって
 * いる回が上にあるなら、この回もそこへ届いているだけである。
 *
 * @param earlier これまでに採用した読み取り（この回を含まない）
 */
export function judgeProbeGrowth(
  reading: ProbeTokenReading,
  earlier: readonly ProbeTokenReading[]
): ProbeGrowth {
  const lower = lowerNeighbor(earlier, reading.promptChars);
  if (lower === undefined) {
    // いちばん短い回。比べる相手がいないので、ここを伸びの起点にする
    return { grew: true, note: "最初の回なので、伸びの起点にします" };
  }

  const deltaChars = reading.promptChars - lower.promptChars;
  const deltaTokens = reading.inputTokens - lower.inputTokens;
  const rate = densestRate([...earlier, reading]);
  const expected = deltaChars * rate;
  const required = expected * PROBE_TOKEN_GROWTH_RATIO;
  const kept = deltaTokens + PROBE_TOKEN_GROWTH_SLACK >= required;
  const share = expected > 0 ? Math.round((deltaTokens / expected) * 100) : 100;

  if (!kept) {
    return {
      grew: false,
      note:
        `${lower.promptChars}字から${deltaChars}字ぶん増やして、入力トークンは` +
        `${deltaTokens}しか増えませんでした（伸びるはずだった量の${share}%）`,
    };
  }

  const upper = upperNeighbor(earlier, reading.promptChars);
  if (
    upper !== undefined &&
    upper.inputTokens <= reading.inputTokens * (1 + PROBE_TOKEN_PLATEAU_RATIO)
  ) {
    return {
      grew: false,
      note:
        `もっと長い${upper.promptChars}字の回も入力トークンが` +
        `${upper.inputTokens}で、この回（${reading.inputTokens}）から` +
        "伸びていません。すでに頭打ちです",
    };
  }

  return {
    grew: true,
    note:
      `${lower.promptChars}字から${deltaChars}字ぶん増やして、入力トークンが` +
      `${deltaTokens}増えました（伸びるはずだった量の${share}%）`,
  };
}

/**
 * 測定から採れた**実測の字/トークン**（設計書6.77の欄へ入れる値）。
 *
 * **伸びの傾きがそのまま換算である**——同じ詰め物を長くしていくので、
 * 増えた字数 ÷ 増えたトークン数には、指示や合言葉の分が乗らない。
 * 1回の測定で「読める長さ」と「換算」の2つが採れる。
 *
 * **全部届いた回だけを渡すこと。** 切られた回を混ぜると傾きが寝て、
 * 実際より大きい（＝危ない側の）字/トークンが出る。
 *
 * @returns 小数3桁へ丸めた字/トークン。傾きを引けないときは undefined
 *   （**1点しか無いときは返さない**。その1点の比には指示ぶんの字数が
 *   乗っており、傾きより大きく出る＝危ない側へ倒れる）
 */
export function charsPerTokenFromProbe(
  readings: readonly ProbeTokenReading[]
): number | undefined {
  if (readings.length < 2) return undefined;
  const sorted = [...readings].sort((a, b) => a.promptChars - b.promptChars);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const deltaChars = last.promptChars - first.promptChars;
  const deltaTokens = last.inputTokens - first.inputTokens;
  if (deltaChars <= 0 || deltaTokens <= 0) return undefined;
  const value = deltaChars / deltaTokens;
  if (!Number.isFinite(value) || value <= 0) return undefined;
  // 丸めは `core/sizeBudget.ts` の1つだけ。**切り捨てる**（丸め上げると、
  // 実測よりわずかに大きい＝危ない側の値が台帳に残る）
  return roundCharsPerToken(value);
}

/** いちばん密だった回のトークン/字。**切られた回ほど薄くなる**ので最大を採る */
function densestRate(readings: readonly ProbeTokenReading[]): number {
  let best = 0;
  for (const reading of readings) {
    if (reading.promptChars <= 0) continue;
    best = Math.max(best, reading.inputTokens / reading.promptChars);
  }
  return best;
}

/** それより短い回のうち、いちばん長いもの */
function lowerNeighbor(
  readings: readonly ProbeTokenReading[],
  promptChars: number
): ProbeTokenReading | undefined {
  let found: ProbeTokenReading | undefined;
  for (const reading of readings) {
    if (reading.promptChars >= promptChars) continue;
    if (found === undefined || reading.promptChars > found.promptChars) {
      found = reading;
    }
  }
  return found;
}

/** それより長い回のうち、いちばん短いもの */
function upperNeighbor(
  readings: readonly ProbeTokenReading[],
  promptChars: number
): ProbeTokenReading | undefined {
  let found: ProbeTokenReading | undefined;
  for (const reading of readings) {
    if (reading.promptChars <= promptChars) continue;
    if (found === undefined || reading.promptChars < found.promptChars) {
      found = reading;
    }
  }
  return found;
}

/** 探索の始まりの状態 */
export function startProbeState(ceilingChars: number): ProbeState {
  return {
    ceilingChars,
    low: 0,
    high: undefined,
    current: Math.min(START_PROBE_CHARS, ceilingChars),
  };
}

/**
 * 次に試す字数を決める。終わりなら undefined。
 *
 * **直前の結果（`fitted`）を一緒に受け取る。** 状態だけでは
 * 次を決められない——「いま送った `current` が入ったのか」が、
 * `low` を伸ばすか `high` を縮めるかの分かれ目だからである。
 *
 * **`fitted` は「入力トークン数の伸びが続いたか」である**（作者の裁定、
 * 2026-09-13）。トークン数を返さないAIでだけ、これまでどおり
 * 「合言葉が両方返ったか」が入る。探索そのものは、どちらでも同じ。
 *
 * 動きは二分探索そのものである。まだ一度も落ちていないうちは倍々に
 * 伸ばし（上限で頭打ち）、落ちた点が見つかったら間を詰める。
 * **幅が `low` の1割まで狭まったら終わり**にする。
 */
export function nextProbeSize(
  state: ProbeState,
  fitted: boolean
): ProbeState | undefined {
  const low = fitted ? Math.max(state.low, state.current) : state.low;
  const high = fitted
    ? state.high
    : state.high === undefined
      ? state.current
      : Math.min(state.high, state.current);

  if (high === undefined) {
    /*
      **まだ一度も落ちていない。次は公称値まで一気に跳ぶ**（設計書6.59。
      作者の提案「小さな数字からはじめるのではなく、公称値から始めることは
      できるでしょうか？」2026-09-01）。

      以前は倍々に伸ばしていた（4,000 → 8,000 → …）。申告どおり読める
      モデルでは、**上限に届くまでに6回も無駄に送っていた**——作者の実測では
      4,000から128,000まで全部「両方」で、7回目にようやく上限へ着いた。

      **1回目だけは小さいまま残す。** ここを飛ばして最初から公称値を送ると、
      失敗したときに「長すぎた」のか「鍵が違う・残高が無い・繋がらない」のかを
      **見分けられない**（`countErrorAsTooLong` は「一度でも通ったこと」を
      条件にしている）。小さい1回は、その確認を兼ねている。

      跳んで落ちたら、あとは二分探索が間を詰める。**悪いほうへ転んでも
      回数はほぼ変わらず、良いほうへ転べば5回減る。**
    */
    const next = state.ceilingChars;
    // 上限に届いていれば、これ以上は測れない（測れる範囲では全部読めた）
    if (next <= low) return undefined;
    return { ceilingChars: state.ceilingChars, low, high, current: next };
  }

  // 幅が十分に狭まったら終わり。これ以上は呼び出し回数に見合わない
  if (high - low <= low * PROBE_CONVERGENCE_RATIO) return undefined;

  const mid = Math.floor((low + high) / 2);
  // 刻めなくなった／底を割った。どちらも、続けても分かることが増えない
  if (mid <= low || mid >= high || mid < MIN_PROBE_CHARS) return undefined;

  return { ceilingChars: state.ceilingChars, low, high, current: mid };
}

/** 字数を、そのモデルに要るトークン数へ直す */
export function probeCharsToTokens(chars: number): number {
  return Math.round(chars * TOKENS_PER_CHAR);
}

/**
 * 最後まで測ったときに送る字数の合計を、いちばん多い場合で求める。
 *
 * **倍率で見積もらない。** 「上限の2倍」のような掛け算は、倍々に
 * 伸ばす段（合計はいちばん大きい回の約2倍）しか勘定に入らない。
 * 実際にはそのあと**間を詰める段**があり、そこで送るのはどれも上限に
 * 近い長さなので、掛け算だと3倍ほど少なく見える。有料AIでは、
 * この数字がそのまま作者に見せる金額になる（設計書7.1.1）。
 *
 * 探索の枝は「両方返った／返らなかった」の2つしかないので、
 * **全部の枝をたどって最大を取る**のが正確で、しかも速い
 * （同じ状態は覚えておく。枝の数は数百に収まる）。
 */
export function worstCaseProbeChars(ceilingChars: number): number {
  const seen = new Map<string, number>();

  const walk = (state: ProbeState | undefined): number => {
    if (!state) return 0;
    const key = `${state.low}|${state.high ?? -1}|${state.current}`;
    const cached = seen.get(key);
    if (cached !== undefined) return cached;

    const total =
      state.current +
      Math.max(walk(nextProbeSize(state, true)), walk(nextProbeSize(state, false)));
    seen.set(key, total);
    return total;
  };

  return walk(startProbeState(ceilingChars));
}

/**
 * 測った結果を、作者に読める1文にする。
 *
 * **数字を必ず入れる。** 「思ったより短い」だけでは、設定をいくつに
 * すればよいのか決められない。字数（作者が本文で数えている単位）と
 * トークン数（設定に書く単位）の両方を出す。
 */
export function describeProbeResult(input: {
  /** 全部届いたと判定できた最大の字数 */
  low: number;
  sides: ProbeSides;
  /** 測れる上限。ここまで届いたことを伝えたいときだけ渡す */
  ceilingChars?: number;
  /**
   * 何で測ったか。**省略すると「合言葉」**——これまでの動きに揃える
   * （呼び出し側が渡し忘れても、弱いほうの測り方だと名乗る）。
   */
  measuredBy?: ProbeMeasureMethod;
  /**
   * 合言葉を書き写せなかった、いちばん長い字数（参考）。
   *
   * **長さの判定には使っていない。** 入力トークン数から本文は届いて
   * いたと分かっている回なので、ここで縮めない（作者の裁定、2026-09-13）。
   */
  wordCopyFailedChars?: number;
}): string {
  const byTokens = input.measuredBy === "tokens";

  if (input.low <= 0) {
    return byTokens
      ? `いちばん短い ${MIN_PROBE_CHARS.toLocaleString("ja-JP")}字あたりでも` +
          "入力トークン数が伸びませんでした。読める長さではなく、AIの設定か" +
          "接続の側に原因がありそうです。"
      : `いちばん短い ${MIN_PROBE_CHARS.toLocaleString("ja-JP")}字あたりでも` +
          "合言葉が返りませんでした。読める長さではなく、AIの設定か接続の側に" +
          "原因がありそうです。";
  }

  const tokens = probeCharsToTokens(input.low);
  const lines = [
    `実効の上限は約 ${input.low.toLocaleString("ja-JP")} 字` +
      `（約 ${tokens.toLocaleString("ja-JP")} トークン）です。`,
  ];

  if (byTokens) {
    // **どちら側が切られるかは、この測り方では分からない。** 分かるのは
    // 「どこまで届いたか」だけなので、分からないことを書かない
    lines.push(
      "長さは、AIが申告した入力トークン数の伸びで判定しました" +
        "（合言葉は参考にとどめています）。"
    );
    if (input.ceilingChars !== undefined && input.low >= input.ceilingChars) {
      lines.push(
        "今回測れる上限まで、入力トークン数が伸び続けました。" +
          "これより長く読める可能性があります。"
      );
    }
    if (input.wordCopyFailedChars !== undefined) {
      lines.push(
        `${input.wordCopyFailedChars.toLocaleString("ja-JP")} 字のあたりでは、` +
          "本文は届いていたのに合言葉を書き写せませんでした" +
          "（長さの判定には使っていません）。"
      );
    }
    return lines.join("");
  }

  // ここから先は合言葉で測った道。**弱い測り方であることを先に言う**
  lines.push(
    "このAIは入力トークン数を返さないので、合言葉が返るかで測りました。" +
      "この測り方は長さと関係なく落ちることがあるので、目安として見てください。"
  );

  if (input.ceilingChars !== undefined && input.low >= input.ceilingChars) {
    // 上限まで全部通った。**「これが限界」と言い切らない**——
    // 測れる範囲を広げれば、もっと読めるかもしれない
    lines.push(
      "今回測れる上限まで、先頭と末尾の合言葉が両方返りました。" +
        "これより長く読める可能性があります。"
    );
  } else if (input.sides.headDropped && input.sides.tailDropped) {
    lines.push("長すぎるときは、先頭側と末尾側の両方が切り落とされます。");
  } else if (input.sides.headDropped) {
    lines.push("長すぎるときは、先頭側（前のほう）が切り落とされます。");
  } else if (input.sides.tailDropped) {
    lines.push("長すぎるときは、末尾側（後ろのほう）が切り落とされます。");
  } else {
    lines.push("どちら側が切り落とされるかは、今回の測定では分かりませんでした。");
  }

  return lines.join("");
}
