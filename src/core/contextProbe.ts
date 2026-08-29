import { TOKENS_PER_CHAR } from "./chunker";

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
 * ## 測り方（作者の発案）
 *
 * 「最後のほうに合図を入れて、それが返るか見ればよい」。本文の代わりに
 * 無害な詰め物を N 字入れ、**先頭と末尾の両方**に合言葉を置く。
 * 両方返れば N は読めている。片方しか返らなければ、**どちら側が
 * 切られたか**まで分かる（クラウドには前を切る実装もありうる）。
 *
 * 作者の原案から2点だけ変えた。
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
  /** 両方の合言葉が返った最大の字数。まだ無ければ 0 */
  readonly low: number;
  /** 返らなかった最小の字数。まだ無ければ undefined */
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
    `最初の合言葉は『${options.headWord}』です。\n` +
    "この下は検査用の詰め物です。内容に意味はありません。\n" +
    `${buildProbeFiller(options.fillerChars)}\n` +
    `最後の合言葉は『${options.tailWord}』です。\n` +
    "返事は「最初の合言葉 最後の合言葉」の形で、合言葉だけを書いてください。";

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
 * **直前の結果（`bothReturned`）を一緒に受け取る。** 状態だけでは
 * 次を決められない——「いま送った `current` が入ったのか」が、
 * `low` を伸ばすか `high` を縮めるかの分かれ目だからである。
 *
 * 動きは二分探索そのものである。まだ一度も落ちていないうちは倍々に
 * 伸ばし（上限で頭打ち）、落ちた点が見つかったら間を詰める。
 * **幅が `low` の1割まで狭まったら終わり**にする。
 */
export function nextProbeSize(
  state: ProbeState,
  bothReturned: boolean
): ProbeState | undefined {
  const low = bothReturned ? Math.max(state.low, state.current) : state.low;
  const high = bothReturned
    ? state.high
    : state.high === undefined
      ? state.current
      : Math.min(state.high, state.current);

  if (high === undefined) {
    // まだ一度も落ちていない。倍にして伸ばす
    const doubled = Math.min(low * 2, state.ceilingChars);
    // 上限に届いていれば、これ以上は測れない（測れる範囲では全部読めた）
    if (doubled <= low) return undefined;
    return { ceilingChars: state.ceilingChars, low, high, current: doubled };
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
  /** 両方の合言葉が返った最大の字数 */
  low: number;
  sides: ProbeSides;
  /** 測れる上限。ここまで届いたことを伝えたいときだけ渡す */
  ceilingChars?: number;
}): string {
  if (input.low <= 0) {
    return (
      `いちばん短い ${MIN_PROBE_CHARS.toLocaleString("ja-JP")}字あたりでも` +
      "合言葉が返りませんでした。読める長さではなく、AIの設定か接続の側に" +
      "原因がありそうです。"
    );
  }

  const tokens = probeCharsToTokens(input.low);
  const lines = [
    `実効の上限は約 ${input.low.toLocaleString("ja-JP")} 字` +
      `（約 ${tokens.toLocaleString("ja-JP")} トークン）です。`,
  ];

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
