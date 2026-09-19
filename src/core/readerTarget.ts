import {
  pickThreeAxes,
  scoreThreeAxisAnswers,
  threeAxisFlat,
  threeAxisLevel,
  type ThreeAxisLevel,
  type ThreeAxisPick,
  type ThreeAxisQuestion,
} from "./threeAxis";
import type {
  ReaderAxis,
  ReaderProfile,
  ReaderScores,
} from "../models/readerProfile";
// 日付の作り方（作者の時計で切る）は `advicePolicy.ts` の1か所だけが持つ
import { adviceDiagnosisDate } from "./advicePolicy";

export type { ReaderAxis, ReaderScores };

/**
 * ターゲット読者の分類（設計書6.91）。
 *
 * 作者の依頼（2026-09-13）：「作者の分類と同じように、ターゲット読者の
 * 分類も行えないでしょうか？」
 *
 * ## 作家タイプ（6.86）と、答える人が違う
 *
 * 作家タイプが当たるのは、**本人しか知らないことを本人に聞いている**
 * からである。だから「あなたは読者思いですか」ではなく「PVをふだん
 * どれくらい見ますか」と行動を聞く（自己像を聞くと、なりたい姿のほうを
 * 答えてしまう）。
 *
 * ターゲット読者を同じ形で聞くと、この罠が深くなる。**「誰に読んで
 * ほしいですか」に返ってくるのは願望**で、書けているものではない。
 * 読者は本人ではないので、本人に聞いても実像が出てこない。
 *
 * そこで2階建てにする。
 *
 * | | 何が出るか | 材料 | AI |
 * |---|---|---|---|
 * | **宣言** | 誰に向けて書いているつもりか | この9問 | 使わない |
 * | **実像** | 書けているものは誰に向いているか | 本文・プロット・紹介文 | 使う（P-37） |
 *
 * **値打ちはズレのほうにある。** 「中高生に向けているつもりが、
 * 書けているものは読み慣れた読者向け」——これは直せる指摘で、
 * 宣言だけでは出ない。
 *
 * ## 宣言の9問も、願望ではなく判断を聞く
 *
 * 「どんな読者に読んでほしいか」ではなく、**書くときに実際にしている
 * 判断**を聞く（1話の長さの決め方・造語の説明の仕方・結末の決め方）。
 * 願望は答えやすいぶん当たらないが、判断なら本文と突き合わせられる。
 *
 * ## 作品ごとに持つ
 *
 * 作者の裁定（2026-09-13）。同じ作者が異世界転生と純文学を書いていれば、
 * ターゲット読者は別物である。作家タイプが作者ごと（6.86）なのと対になる。
 *
 * VS Code APIに依存しない。
 */

export type ReaderLevel = ThreeAxisLevel;

/**
 * 軸を見る順。**同点のときは、この順で先にあるものを主軸にする。**
 *
 * 順を決めておかないと、同じ答えから違うタイプが出る。
 */
export const READER_AXIS_ORDER: readonly ReaderAxis[] = [
  "familiarity",
  "posture",
  "craving",
];

/** 軸の呼び名（画面と紙で共用する。写しを作らない） */
export const READER_AXIS_LABELS: Record<ReaderAxis, string> = {
  familiarity: "読み慣れ",
  posture: "読む姿勢",
  craving: "求めるもの",
};

/**
 * 軸の両端。診断の紙の表に出す。
 *
 * **どちらが上等でもない。** 「高いほうが良い」と読めると、
 * 作者が自分の読者像を格付けされたように感じる。
 */
export const READER_AXIS_ENDS: Record<ReaderAxis, { low: string; high: string }> =
  {
    familiarity: { low: "その題材が初めて", high: "読み尽くしている" },
    posture: { low: "隙間に読む", high: "腰を据えて読む" },
    craving: { low: "気持ちよさ", high: "揺さぶり" },
  };

/**
 * 年齢層を軸にしない理由（作者への説明にも使う）。
 *
 * 同じ30代でも、通勤で読む人と休日に読む人では書き方がまるで違う。
 * **年齢は結果であって、書き方を決めるものではない。**
 */
export const READER_AGE_NOTE =
  "年齢層は軸にしていません。同じ年頃でも、隙間に読む人と腰を据えて読む人では、効く書き方がまるで違うためです。";

export type ReaderTypeId =
  | "lore_flow"
  | "lore_deep"
  | "lore_crave"
  | "deep_pure"
  | "deep_lore"
  | "deep_crave"
  | "crave_pure"
  | "crave_lore"
  | "crave_deep"
  | "omnivore"
  | "light";

export type ReaderQuestion = ThreeAxisQuestion<ReaderAxis>;

/**
 * 宣言の9問（各軸3問・各問0〜2点）。
 *
 * **願望ではなく、書くときの判断を聞く。** 「どんな読者に読んで
 * ほしいか」は答えやすいが当たらない。判断なら本文と突き合わせられる。
 */
export const READER_QUESTIONS: ReaderQuestion[] = [
  {
    id: "A1",
    axis: "familiarity",
    text: "その題材のお約束（いわゆるテンプレ）を、どう扱っていますか",
    choices: [
      { label: "ていねいになぞる。初めての人でも分かるように", score: 0 },
      { label: "なぞるが、一部は自分の形に変えている", score: 1 },
      { label: "知っている前提で省く。外して驚かせることもある", score: 2 },
    ],
  },
  {
    id: "A2",
    axis: "familiarity",
    text: "作品の中だけの言葉（造語・独自の用語）が出たとき、説明をどうしていますか",
    choices: [
      { label: "その場で説明を入れる", score: 0 },
      { label: "話の流れの中で分かるようにする", score: 1 },
      { label: "説明しない。読めば分かる人に向けて書いている", score: 2 },
    ],
  },
  {
    id: "A3",
    axis: "familiarity",
    text: "似た作品を読んだことがない人が読んだら、と考えることはありますか",
    choices: [
      { label: "いつも考える。そこが基準になっている", score: 0 },
      { label: "ときどき考える", score: 1 },
      { label: "考えない。すでに読んでいる人に向けて書いている", score: 2 },
    ],
  },
  {
    id: "B1",
    axis: "posture",
    text: "1話の長さを、どう決めていますか",
    choices: [
      { label: "短く。移動中に1話読み切れる長さにする", score: 0 },
      { label: "話の切れ目で決める。長さは成り行き", score: 1 },
      { label: "長くなっても切らない。読み応えを優先する", score: 2 },
    ],
  },
  {
    id: "B2",
    axis: "posture",
    text: "話の終わりに、次を読ませる引きを作っていますか",
    choices: [
      { label: "毎回つくる。引きが無いと次が読まれない", score: 0 },
      { label: "つくる話と、つくらない話がある", score: 1 },
      { label: "つくらない。1話として収まる形で終える", score: 2 },
    ],
  },
  {
    id: "B3",
    axis: "posture",
    text: "前の話を忘れている読者を、どれくらい見込んでいますか",
    choices: [
      { label: "忘れている前提。要ることは毎回書き直す", score: 0 },
      { label: "大事なところだけ思い出せるようにする", score: 1 },
      { label: "覚えている前提。読み返す人に向けて書いている", score: 2 },
    ],
  },
  {
    id: "C1",
    axis: "craving",
    text: "主人公がひどい目に遭う場面を、どこまで書きますか",
    choices: [
      { label: "長くは続けない。すぐ報われるようにする", score: 0 },
      { label: "必要なだけ書く", score: 1 },
      { label: "逃げずに書く。報われないこともある", score: 2 },
    ],
  },
  {
    id: "C2",
    axis: "craving",
    text: "読み終わったあと、読者にどう感じてほしいですか",
    choices: [
      { label: "すっきりしてほしい", score: 0 },
      { label: "満ち足りていてほしい", score: 1 },
      { label: "しばらく引きずってほしい", score: 2 },
    ],
  },
  {
    id: "C3",
    axis: "craving",
    text: "結末を決めるとき、何を優先しますか",
    choices: [
      { label: "気持ちよく終わること", score: 0 },
      { label: "物語として筋が通ること", score: 1 },
      { label: "嘘をつかないこと。苦くてもそうする", score: 2 },
    ],
  },
];

export interface ReaderTypeInfo {
  label: string;
  /** 診断結果の画面に出す1行。**その読者が何を求めて読むか**を書く */
  summary: string;
  /** その読者に効くこと（紙に出す） */
  works: string;
  /** その読者が離れるところ（紙に出す） */
  loses: string;
}

/**
 * 読者タイプの一覧。
 *
 * **作者の作品への評価にしない。** 読者像の説明であって、
 * 「あなたの作品は浅い」と読める書き方をしない。どの層にも
 * その層なりの読み方があり、上下は無い。
 *
 * 呼び名は「〜層」で揃える。作家タイプの「〜型」と対にして、
 * 画面で混ざっても取り違えないようにするためである。
 */
export const READER_TYPES: Record<ReaderTypeId, ReaderTypeInfo> = {
  lore_flow: {
    label: "回遊層",
    summary:
      "その題材を読み尽くしていて、次から次へと渡り歩く読者。お約束は説明なしで通じます。",
    works: "本題まで早く着くこと。1話目で「これはあの型だ」と分かること。",
    loses: "知っていることを長く説明されると、そこで閉じます。",
  },
  lore_deep: {
    label: "考察層",
    summary:
      "読み慣れていて、腰を据えて読む読者。伏線を拾い、読み返し、辻褄を見ています。",
    works: "回収される伏線と、設定どうしの筋。細部が効きます。",
    loses: "筋の通らない展開。後から設定が変わると、信用を失います。",
  },
  lore_crave: {
    label: "開拓層",
    summary:
      "定番を読み尽くして、まだ見ていないものを探している読者。既視感にいちばん厳しい層です。",
    works: "型を承知のうえで外すこと。外し方に意図が見えること。",
    loses: "どこかで読んだ展開。「知っている話」と感じた時点で離れます。",
  },
  deep_pure: {
    label: "没入層",
    summary:
      "腰を据えて、作品の世界に浸かりに来る読者。長さは苦になりません。",
    works: "世界の手触り。情景・空気・その場にいる感じ。",
    loses: "急ぎ足の展開。説明で片づけられると、世界から追い出されます。",
  },
  deep_lore: {
    label: "常連層",
    summary:
      "腰を据えて読み、読み慣れてもいる読者。気に入った書き手を追いかけます。",
    works: "更新の続くこと。前の話を踏まえた積み重ね。",
    loses: "間が空くこと。話ごとの温度差が大きいこと。",
  },
  deep_crave: {
    label: "感涙層",
    summary:
      "腰を据えて読み、心を動かされに来る読者。泣ける話を探しています。",
    works: "溜めてから放つこと。感情の置き場がきちんと作られていること。",
    loses: "溜めの無い悲劇。段取りが見えると、冷めます。",
  },
  crave_pure: {
    label: "刺激層",
    summary:
      "強い展開を求めて読む読者。動きの止まらない話を探しています。",
    works: "毎話なにかが起きること。引きが強いこと。",
    loses: "静かな話が続くこと。会話だけの回で離れます。",
  },
  crave_lore: {
    label: "裏読み層",
    summary:
      "読み慣れたうえで、揺さぶられに来る読者。お約束が崩れる瞬間を待っています。",
    works: "型を踏ませてから裏切ること。読者の予想を利用すること。",
    loses: "予想どおりに進むこと。崩す気配が無いと、早めに見切ります。",
  },
  crave_deep: {
    label: "余韻層",
    summary:
      "揺さぶられに来て、読んだあとも考えていたい読者。苦さを厭いません。",
    works: "言い切らずに終えること。読者に委ねた余白。",
    loses: "全部を説明して閉じること。答えを渡されると、余韻が消えます。",
  },
  omnivore: {
    label: "雑食層",
    summary:
      "3つの軸がどれも中ほどにある読者。面白ければ何でも読みます。",
    works: "作品ごとの持ち味。ここを狙うと決めれば、どの方向へも寄せられます。",
    loses: "何を売りにしているか分からないこと。持ち味が見えないと素通りされます。",
  },
  light: {
    label: "すきま層",
    summary:
      "空いた時間に、気持ちよく読める話を探している読者。WEB小説でいちばん数の多い層です。",
    works: "短く、分かりやすく、次が気になること。1話目で面白さが分かること。",
    loses: "読み始めに要る前提が多いこと。長い導入で離れます。",
  },
};

/**
 * 主軸と副軸の組み合わせから決まるタイプ。
 *
 * 副軸が無いときは "none" を鍵にする。表を1か所に置いて、
 * 判定の関数のほうでは分岐を書かない（分岐で書くと表と食い違う）。
 *
 * **外へ出しているのは、隣り合い（`readerTypeNeighbors.ts`、設計書6.101）を
 * ここから導くためである。** 「どの層とどの層が隣か」を手書きの表で
 * もう1つ持つと、軸の組み合わせを変えたときに片方だけ直る日が来る。
 */
export const READER_TYPE_TABLE: Record<string, ReaderTypeId> = {
  "familiarity:none": "lore_flow",
  "familiarity:posture": "lore_deep",
  "familiarity:craving": "lore_crave",
  "posture:none": "deep_pure",
  "posture:familiarity": "deep_lore",
  "posture:craving": "deep_crave",
  "craving:none": "crave_pure",
  "craving:familiarity": "crave_lore",
  "craving:posture": "crave_deep",
};

/** 合計点から段階を決める。物差しは作家タイプと共通 */
export function readerLevel(score: number): ReaderLevel {
  return threeAxisLevel(score);
}

/** 9問の答えを軸ごとに合計する。足りない答えは0点として扱う */
export function scoreReaderAnswers(answers: readonly number[]): ReaderScores {
  return scoreThreeAxisAnswers(
    READER_AXIS_ORDER,
    READER_QUESTIONS,
    answers
  ) as ReaderScores;
}

export type ReaderAxesPick = ThreeAxisPick<ReaderAxis>;

/** 名前を決めた軸。紙が「なぜこの名前になったか」を出すのに要る */
export function readerAxesOf(scores: ReaderScores): ReaderAxesPick {
  return pickThreeAxes(READER_AXIS_ORDER, scores);
}

/**
 * タイプを決める。
 *
 * **全低は「すきま層」で、これははっきりした層である。** 作家タイプでは
 * 全低が「目的模索型（まだ定まらない）」だったが、読者では違う——
 * 初めての題材を、隙間の時間に、気持ちよく読む人のことで、
 * WEB小説でいちばん数が多い。**迷いではなく、宛先である。**
 */
export function resolveReaderType(scores: ReaderScores): ReaderTypeId {
  const { main, sub } = readerAxesOf(scores);
  if (!main) {
    return threeAxisFlat(READER_AXIS_ORDER, scores) === "low"
      ? "light"
      : "omnivore";
  }
  return READER_TYPE_TABLE[`${main}:${sub ?? "none"}`];
}

/** 記録と画面に出す一行（「考察層」） */
export function readerTypeLabel(scores: ReaderScores): string {
  return READER_TYPES[resolveReaderType(scores)].label;
}

/* ───────────────────────────────────────────────────────────────
   相談へ渡す読者像（設計書6.91.9）
   ─────────────────────────────────────────────────────────────── */

/** 相談へ渡した読者像の出どころ */
export type ReaderChatSource = "declared" | "actual";

export interface ReaderChatBasis {
  scores: ReaderScores;
  source: ReaderChatSource;
  /** その欄を書いた日時（ISO）。記録に出す */
  updatedAt: string;
}

export const READER_CHAT_SOURCE_LABELS: Record<ReaderChatSource, string> = {
  declared: "宣言",
  actual: "実像",
};

/**
 * 相談へ渡す読者像を1つ選ぶ。
 *
 * **宣言（作者が答えた宛先）を優先し、無ければ実像を使う。**
 * 助言は作者が向かおうとしている先へ添えるものであり、書けているものが
 * たまたま届いた先へ寄せて助言すると、ズレを固定してしまう。ズレそのものは
 * `readerGaps` が別に出す仕組みがあるので、ここで混ぜない。
 *
 * **選ぶ規則をここ1か所に置く。** プロンプトの組み立てと操作ログの両方が
 * これを呼ぶので、写しを作ると「送ったもの」と「記録したもの」が食い違う。
 *
 * どちらも無ければ `undefined`——**何も足さない**（相談は止めない）。
 */
export function chatReaderBasis(
  profile: ReaderProfile | undefined
): ReaderChatBasis | undefined {
  if (!profile) return undefined;
  if (profile.declared) {
    return {
      scores: profile.declared.scores,
      source: "declared",
      updatedAt: profile.declared.updatedAt,
    };
  }
  if (profile.actual) {
    return {
      scores: profile.actual.scores,
      source: "actual",
      updatedAt: profile.actual.updatedAt,
    };
  }
  return undefined;
}

/**
 * 相談へ渡した読者タイプを、操作ログの1行にする。
 *
 * **文言をここに置くのは `advicePolicyLogLines` と同じ理由**——
 * 試験から見るためである。**出どころ（宣言か実像か）まで残す**：
 * 助言の当たり外れを見るとき、どちらを基準にしたかが分かれ目になる。
 *
 * 診断していなければ空配列。
 */
export function readerTypeChatLogLines(
  profile: ReaderProfile | undefined
): string[] {
  const basis = chatReaderBasis(profile);
  if (!basis) return [];
  const when = adviceDiagnosisDate(basis.updatedAt);
  const source =
    READER_CHAT_SOURCE_LABELS[basis.source] + (when ? ` ${when}` : "");
  return [`相談: 読者タイプ ${readerTypeLabel(basis.scores)}（${source}）`];
}

/**
 * 宣言と実像のズレ（設計書6.91）。
 *
 * **この診断でいちばん値打ちがあるところ。** 宣言だけなら願望が出るし、
 * 実像だけなら「そう書いたつもりはない」で終わる。並べて初めて動かせる。
 */
export interface ReaderGap {
  axis: ReaderAxis;
  /** 宣言の点（作者の答え） */
  declared: number;
  /** 実像の点（本文から読んだ値） */
  actual: number;
  /** 実像 − 宣言。正なら「書けているものは、思っているより右寄り」 */
  diff: number;
}

/**
 * ズレとして扱う幅。
 *
 * **2点未満は言わない。** 1点は選択肢1つぶんで、質問の読み方の差で動く。
 * そこを「ズレています」と言うと、当たらない指摘で信用を失う。
 */
export const READER_GAP_THRESHOLD = 2;

/**
 * 宣言と実像を突き合わせる。**幅の大きい順**に返す。
 *
 * ズレが無ければ空。「ズレていません」は呼ぶ側が言う
 * （ここで空と「材料が無い」を混ぜない）。
 */
export function readerGaps(
  declared: ReaderScores,
  actual: ReaderScores
): ReaderGap[] {
  return READER_AXIS_ORDER.map((axis) => ({
    axis,
    declared: declared[axis],
    actual: actual[axis],
    diff: actual[axis] - declared[axis],
  }))
    .filter((gap) => Math.abs(gap.diff) >= READER_GAP_THRESHOLD)
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
}

/**
 * ズレ1件の言い方。
 *
 * **どちらが正しいとも言わない。** 宣言が本当のこともあれば
 * （まだ書けていないだけ）、実像が本当のこともある（気づかずに
 * そう書いていた）。決めるのは作者である。
 */
export function describeReaderGap(gap: ReaderGap): string {
  const name = READER_AXIS_LABELS[gap.axis];
  const ends = READER_AXIS_ENDS[gap.axis];
  const toward = gap.diff > 0 ? ends.high : ends.low;
  return (
    `${name}：向けているつもりは${gap.declared}／書けているものは${gap.actual}。` +
    `本文は「${toward}」の側に寄っています。`
  );
}
