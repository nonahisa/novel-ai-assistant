/**
 * 相談の助言方針（設計書6.86）。
 *
 * 作者の note 記事「理想の執筆アドバイザーを妄想してみる１」と、その続きの
 * 会話が土台。**同じ助言が、作者によってまったく違う意味で届く**という話で、
 * 「もっと読者を意識して」は読者を見ていない人には気づきに、
 * 題材そのものが目的の人には「別人になれ」に聞こえる。
 *
 * ここは**判定だけ**を持つ。VS Code にも AI にも依存しない純粋関数なので、
 * 境界（1→低、2→中、4→中、5→高）と同点の順を試験で固定できる。
 *
 * **初期値は自己申告、以後は推定**（作者の裁定、2026-09-07）。
 * 9問の診断で初期値を決め、そのあとは相談での発言から±0.5ずつ動かす。
 * **AIにタイプそのものを決めさせない**——1回の会話で人は決められないし、
 * 決めさせると外れたことに気づけない。AIが言えるのは「今回の発言からの
 * 弱い傾向（±1）」までで、点数と段階の計算はここが持つ。
 */

/** 志向の3軸 */
export type AdviceAxis = "reader" | "self" | "taste";

/** 各軸の段階 */
export type AdviceLevel = "low" | "mid" | "high";

export interface AdviceScores {
  /** X 読者志向（0〜6） */
  reader: number;
  /** Y 自己投影度（0〜6） */
  self: number;
  /** Z 嗜好志向（0〜6） */
  taste: number;
}

export type AdviceTypeId =
  | "reader_first"
  | "reader_message"
  | "reader_craft"
  | "self_reflective"
  | "self_dialogue"
  | "self_world"
  | "taste_explorer"
  | "taste_sharing"
  | "taste_myth"
  | "balanced"
  | "seeking_purpose";

/** 軸の呼び名（画面と記録で共用する。写しを作らない） */
export const ADVICE_AXIS_LABELS: Record<AdviceAxis, string> = {
  reader: "読者志向",
  self: "自己投影度",
  taste: "嗜好志向",
};

/** 段階の呼び名 */
export const ADVICE_LEVEL_LABELS: Record<AdviceLevel, string> = {
  low: "低",
  mid: "中",
  high: "高",
};

/**
 * 軸を見る順。**同点のときは、この順で先にあるものを主軸にする。**
 *
 * 順を決めておかないと、同じ答えから違うタイプが出る。
 */
const AXIS_ORDER: AdviceAxis[] = ["reader", "self", "taste"];

/** 段階の重み（比べるためだけの数） */
const LEVEL_RANK: Record<AdviceLevel, number> = { low: 0, mid: 1, high: 2 };

export interface AdviceChoice {
  /** 選択肢の文言。そのまま画面に出す */
  label: string;
  /** 0〜2点 */
  score: number;
}

export interface AdviceQuestion {
  /** X1・Y2 のような呼び名。答えの並びを人が読み解くときの手掛かり */
  id: string;
  axis: AdviceAxis;
  text: string;
  /** 0点・1点・2点の順に並べる（画面の並びもこのまま） */
  choices: AdviceChoice[];
}

/**
 * 判定の質問（各軸3問・各問0〜2点）。
 *
 * **作者本人が自分で答える形にする。** 「あなたは〜ですか」ではなく、
 * ふだんの行動を聞く。自己像を聞くと、なりたい姿のほうを答えてしまう。
 */
export const ADVICE_QUESTIONS: AdviceQuestion[] = [
  {
    id: "X1",
    axis: "reader",
    text: "PV・ブクマ・ランキングの数字を、ふだんどれくらい見ますか",
    choices: [
      { label: "ほとんど見ない", score: 0 },
      { label: "たまに見る", score: 1 },
      { label: "更新のたびに見て、次の手を考える", score: 2 },
    ],
  },
  {
    id: "X2",
    axis: "reader",
    text: "読者が離れそうな場面を、自分で指摘できますか",
    choices: [
      { label: "考えたことがない", score: 0 },
      { label: "なんとなく分かる", score: 1 },
      { label: "場面と理由を言える", score: 2 },
    ],
  },
  {
    id: "X3",
    axis: "reader",
    text: "タイトルやあらすじを「読まれるため」に変えたことがありますか",
    choices: [
      { label: "ない", score: 0 },
      { label: "迷ったことはある", score: 1 },
      { label: "ある", score: 2 },
    ],
  },
  {
    id: "Y1",
    axis: "self",
    text: "作品への指摘を、どう受け取りますか",
    choices: [
      { label: "作品の話として聞ける", score: 0 },
      { label: "少し引っかかる", score: 1 },
      { label: "自分が否定されたように感じる", score: 2 },
    ],
  },
  {
    id: "Y2",
    axis: "self",
    text: "「この作品で伝えたいこと」を一文で言えますか",
    choices: [
      { label: "特にない", score: 0 },
      { label: "言おうとすれば言える", score: 1 },
      { label: "すぐ言える", score: 2 },
    ],
  },
  {
    id: "Y3",
    axis: "self",
    text: "書きたくない依頼や流行は断りますか",
    choices: [
      { label: "需要があれば書く", score: 0 },
      { label: "迷う", score: 1 },
      { label: "断る", score: 2 },
    ],
  },
  {
    id: "Z1",
    axis: "taste",
    text: "「この題材・属性が好きだから書いた」と言えますか",
    choices: [
      { label: "題材は手段", score: 0 },
      { label: "好きな題材はあるが変えられる", score: 1 },
      { label: "題材そのものが目的", score: 2 },
    ],
  },
  {
    id: "Z2",
    axis: "taste",
    text: "題材を変えてでも読まれたいですか",
    choices: [
      { label: "変えてでも読まれたい", score: 0 },
      { label: "場合による", score: 1 },
      { label: "変えない", score: 2 },
    ],
  },
  {
    id: "Z3",
    axis: "taste",
    text: "同じ題材の他作品を熱心に読みますか",
    choices: [
      { label: "あまり読まない", score: 0 },
      { label: "ときどき", score: 1 },
      { label: "かなり読む", score: 2 },
    ],
  },
];

/**
 * 「いまの調子」（受容度・自信度）。
 *
 * **作者には聞かないし、見せない**（作者の裁定、2026-09-07）。
 * 相談の中の発言からの推定だけで持つ。これは AI の言い方を調整するための
 * 内部の目盛りであって、本人に見せると
 * **「自信のない人」というラベルになって、それ自体が地雷になる。**
 *
 * **志向ではないので軸にも入れない。** 作品の出来や反応で上下するものを
 * 軸に混ぜると、調子が悪い時期の値がそのまま人柄として固定される。
 * 初期値は「未知」で、推定が届くまでは調子の文章を送らない。
 */
export interface AdviceState {
  acceptance: AdviceLevel;
  confidence: AdviceLevel;
  /** いつ答えたか（ISO） */
  updatedAt: string;
  /**
   * 受容度「低」が続けて読み取れた回数。
   *
   * **1回では下げない。** 一度きつい言い方をされただけで「いまは指摘より
   * 感想がほしい人」に切り替わると、次の相談から助言が消える。
   * 2回続いたときにだけ下げる。高・中はその場で反映してよい
   * （受け取れるほうへ戻すのは、外しても害が小さい）。
   */
  lowStreak?: number;
}

/**
 * 相談の答えから読み取った、志向と調子の動き（P-36）。
 *
 * 軸は -1／0／+1 の弱い傾向だけ。**AIにタイプそのものを決めさせない**
 * （1回の会話で人は決められない）。±0.5ずつ動かすので、
 * 段階が1つ動くまでにおおよそ10回の相談が要る。
 */
export interface AdviceProfileSignals {
  reader?: number;
  self?: number;
  taste?: number;
  acceptance?: AdviceLevel;
  confidence?: AdviceLevel;
}

/** 記録を積んだきっかけ */
export type AdviceHistorySource = "diagnosis" | "estimated";

/** 過去に出たタイプ。**人は変化する**ので、上書きせずに積む */
export interface AdviceHistoryEntry {
  typeId: AdviceTypeId;
  scores: AdviceScores;
  /**
   * その状態がいつの時点のものか（ISO）。
   * 診断で積んだ記録は前回の診断日、推定で積んだ記録は変わった日時。
   */
  updatedAt: string;
  /** 作者が診断し直したのか、相談での推定で動いたのか */
  source?: AdviceHistorySource;
}

export interface AdviceProfile {
  scores: AdviceScores;
  /**
   * 9問の答え（各0/1/2）。
   *
   * 点数だけでなく答えも残す。やり直すときに前回を初期値にできると、
   * 「1問だけ変えたい」が最短で済む。
   */
  answers: number[];
  /**
   * 診断した日時（ISO）。
   *
   * **推定で点数が動いても、ここは動かさない。** ここは「作者が自分で
   * 答えたのはいつか」であって、最後に触った日時ではない。
   * 診断日を上書きすると、やり直しの目安（30日）が永久に来なくなる。
   */
  updatedAt: string;
  /**
   * 診断で答えたときの点数。推定で動く前の値。
   *
   * 「診断 4 → 現在 4.5」を見せるために要る。無い場合（古い記録）は
   * `scores` をそのまま診断時の値とみなす。
   */
  baseScores?: AdviceScores;
  state?: AdviceState;
  /**
   * 過去の診断（新しいものが先。最大5件）。
   *
   * **タイプは「決めるもの」ではなく「推定」である**（作者の裁定、
   * 2026-09-07）。人は変化するので、前回との違いを見せられるように残す。
   * 5件で切るのは、それ以上遡っても作者が覚えていないため。
   */
  history?: AdviceHistoryEntry[];
}

/** 状態フラグを持つ期限（日）。過ぎたら未知として扱う */
export const ADVICE_STATE_FRESH_DAYS = 14;

/** 履歴に残す件数 */
export const ADVICE_HISTORY_MAX = 5;

/**
 * 診断をやり直したほうがよい目安（日）。
 *
 * **止めはしない。** 相談のログに一言添えるだけ——古い推定で助言が
 * ずれているとき、原因にたどり着く手掛かりが要る。
 */
export const ADVICE_REDIAGNOSE_DAYS = 30;

export interface AdviceTypeInfo {
  label: string;
  /** 診断結果の画面に出す1行 */
  summary: string;
}

/**
 * タイプの一覧。
 *
 * **`summary` は作者本人が読む説明書きである**（作者の裁定、2026-09-07。
 * タイプと説明は見せる）。診断や不足の指摘ではなく、
 * **「あなたにはこういう助言が役に立つ」**という言い方で書く。
 * 「〜が足りない」「〜ができていない」と読める書き方をしない。
 */
export const ADVICE_TYPES: Record<AdviceTypeId, AdviceTypeInfo> = {
  reader_first: {
    label: "読者最適型",
    summary:
      "読者にどう届くかを基準に判断する書き手。具体的な技術論と数字の話がいちばん役に立ちます。根拠があればテーマにも踏み込みます。",
  },
  reader_message: {
    label: "発信表現型",
    summary:
      "伝えたいことがあり、それを読者へ届けたい書き手。伝えたい内容を確かめてから、届け方の技術論に入ります。意図の言語化を手伝います。",
  },
  reader_craft: {
    label: "題材職人型",
    summary:
      "書きたい題材を、読まれる形で仕上げたい書き手。題材はそのままに、その題材が届く読者層と届け方を一緒に探します。",
  },
  self_reflective: {
    label: "内省表現型",
    summary:
      "書くことで自分と向き合う書き手。まず何が伝わったかを述べてから、少しだけ指摘します。断定より、こう読めたという置き方をします。",
  },
  self_dialogue: {
    label: "対話表現型",
    summary:
      "伝えたいものがあり、届き方も気になる書き手。書きたかったことと読者に届いていることの差を、翻訳する形で並べます。",
  },
  self_world: {
    label: "世界没入型",
    summary:
      "作り込んだ世界の中で書く書き手。設定どうしの筋が通っているか、まだ書かれていない帰結は何かというところから話を始めます。",
  },
  taste_explorer: {
    label: "嗜好探究型",
    summary:
      "好きな題材を掘り下げていく書き手。題材への具体的な共感が先で、技術の話はそのあとに置きます。順番が逆だと届きません。",
  },
  taste_sharing: {
    label: "共感共有型",
    summary:
      "好きなものを同じ趣味の読者と分かち合う書き手。その読者にどう見つけてもらうかが、いちばん役に立つ話題になります。",
  },
  taste_myth: {
    label: "私的神話型",
    summary:
      "題材に自分の解釈を持つ書き手。まずその解釈を最後まで聞いてから、作品そのものの話に入ります。要約を急ぎません。",
  },
  balanced: {
    label: "均衡模索型",
    summary:
      "3つの軸がどれも中ほどにある書き手。選択肢を並べて選んでもらう形の助言が、いちばん効く位置にいます。どこへでも動けます。",
  },
  seeking_purpose: {
    label: "目的模索型",
    summary:
      "何のために書くかを探している時期の書き手。楽しかった執筆の記憶を辿るところから、一緒に始めます。目標づくりは急ぎません。",
  },
};

/**
 * 主軸と副軸の組み合わせから決まるタイプ。
 *
 * 副軸が無いときは "none" を鍵にする。表を1か所に置いて、
 * 判定の関数のほうでは分岐を書かない（分岐で書くと表と食い違う）。
 */
const TYPE_TABLE: Record<string, AdviceTypeId> = {
  "reader:none": "reader_first",
  "reader:self": "reader_message",
  "reader:taste": "reader_craft",
  "self:none": "self_reflective",
  "self:reader": "self_dialogue",
  "self:taste": "self_world",
  "taste:none": "taste_explorer",
  "taste:reader": "taste_sharing",
  "taste:self": "taste_myth",
};

/**
 * 合計点から段階を決める。
 *
 * 診断の答えは整数（0〜1＝低、2〜4＝中、5〜6＝高）だが、**推定で動いたあとは
 * 小数になる**（±0.5ずつ）。境界を `< 2` と `>= 5` で書けば、整数のときは
 * これまでと同じ結果になり、小数も同じ物差しで測れる。
 */
export function adviceLevel(score: number): AdviceLevel {
  if (score < 2) return "low";
  if (score < 5) return "mid";
  return "high";
}

/** 9問の答えを軸ごとに合計する。足りない答えは0点として扱う */
export function scoreAnswers(answers: readonly number[]): AdviceScores {
  const scores: AdviceScores = { reader: 0, self: 0, taste: 0 };
  ADVICE_QUESTIONS.forEach((question, index) => {
    const answer = answers[index];
    if (typeof answer !== "number") return;
    const choice = question.choices[answer];
    if (!choice) return;
    scores[question.axis] += choice.score;
  });
  return scores;
}

/**
 * タイプを決める。
 *
 * 3軸すべて低・すべて中は、主軸を選んでも意味がない（差が無いから
 * 選ばれただけの軸を主軸と呼ぶことになる）ので、先に別扱いにする。
 */
export function resolveAdviceType(scores: AdviceScores): AdviceTypeId {
  const levels = AXIS_ORDER.map((axis) => adviceLevel(scores[axis]));
  if (levels.every((level) => level === "low")) return "seeking_purpose";
  if (levels.every((level) => level === "mid")) return "balanced";

  // (段階, 点数) が最大のものを主軸にする。同点なら AXIS_ORDER の先のもの
  const ranked = [...AXIS_ORDER].sort((a, b) => compareAxis(scores, b, a));
  const main = ranked[0];
  // 副軸は「残りのうち段階が中以上」で最大のもの。無ければ「なし」
  const sub = ranked
    .slice(1)
    .find((axis) => adviceLevel(scores[axis]) !== "low");

  return TYPE_TABLE[`${main}:${sub ?? "none"}`];
}

/** 軸の強さを比べる。正なら a のほうが強い */
function compareAxis(
  scores: AdviceScores,
  a: AdviceAxis,
  b: AdviceAxis,
): number {
  const byLevel =
    LEVEL_RANK[adviceLevel(scores[a])] - LEVEL_RANK[adviceLevel(scores[b])];
  if (byLevel !== 0) return byLevel;
  const byScore = scores[a] - scores[b];
  if (byScore !== 0) return byScore;
  // 同点は AXIS_ORDER の先にあるほうを強いとみなす（並びを一意にするため）
  return AXIS_ORDER.indexOf(b) - AXIS_ORDER.indexOf(a);
}

/**
 * 状態フラグがまだ使えるか。
 *
 * **14日で切る。** 調子は変わるもので、古い答えを使い続けると
 * 「自信のない人」という固定のラベルになる。切れても相談は止まらない
 * （タイプの方針だけを送る）。
 */
export function isStateFresh(updatedAt: string, now: Date): boolean {
  const at = Date.parse(updatedAt);
  if (Number.isNaN(at)) return false;
  const elapsed = now.getTime() - at;
  if (elapsed < 0) return true; // 未来の日付は「まだ新しい」と読む
  return elapsed <= ADVICE_STATE_FRESH_DAYS * 24 * 60 * 60 * 1000;
}

/** いま使える状態フラグ。期限を過ぎていれば undefined */
export function freshState(
  profile: AdviceProfile,
  now: Date,
): AdviceState | undefined {
  if (!profile.state) return undefined;
  return isStateFresh(profile.state.updatedAt, now) ? profile.state : undefined;
}

/**
 * 記録用の一行（「読者最適型」）。
 *
 * **タイプだけを書く。** 受容度・自信度はログにも出さない
 * （作者の裁定、2026-09-07）。操作ログは作者が読むもので、
 * 画面に出さないと決めたものがここから漏れては意味がない。
 *
 * ログに残す理由は変わらない——作者が「方針が効いているか」を
 * 確かめる唯一の手掛かりだからである。
 */
export function describeAdvicePolicy(profile: AdviceProfile): string {
  return ADVICE_TYPES[resolveAdviceType(profile.scores)].label;
}

/**
 * 診断をやり直したほうがよい頃合いか。
 *
 * 日付が読めないときは「古い」と言わない——判定できないことを
 * 「古い」と言い切ると、直しようのない注意が出続ける。
 */
export function isDiagnosisStale(updatedAt: string, now: Date): boolean {
  const at = Date.parse(updatedAt);
  if (Number.isNaN(at)) return false;
  return now.getTime() - at > ADVICE_REDIAGNOSE_DAYS * 24 * 60 * 60 * 1000;
}

/** 診断した日（YYYY-MM-DD）。読めなければ undefined */
export function adviceDiagnosisDate(updatedAt: string): string | undefined {
  const at = new Date(updatedAt);
  if (Number.isNaN(at.getTime())) return undefined;
  return at.toISOString().slice(0, 10);
}

/**
 * 新しい診断の結果に、前回を履歴として積んで返す。
 *
 * **前回を消さない。** 変化そのものが作者への情報で、
 * 「前は発信表現型だった」と見えることに意味がある。
 */
export function appendAdviceHistory(
  previous: AdviceProfile | undefined,
  next: AdviceProfile,
  source: AdviceHistorySource = "diagnosis",
  at?: string,
): AdviceProfile {
  if (!previous) return next;

  const entry: AdviceHistoryEntry = {
    typeId: resolveAdviceType(previous.scores),
    scores: previous.scores,
    updatedAt: at ?? previous.updatedAt,
    source,
  };
  return {
    ...next,
    history: [entry, ...(previous.history ?? [])].slice(0, ADVICE_HISTORY_MAX),
  };
}

/** 軸の点数の上限（3問×2点） */
const MAX_AXIS_SCORE = 6;

/** 1回の相談で動かせる幅。段階が1つ動くまでにおよそ10回かかる */
const SIGNAL_STEP = 0.5;

/**
 * 相談から読み取った動きを、点数へ反映する。
 *
 * **AIにタイプを決めさせない。** 1回の会話で人は決められないので、
 * AIには「今回の発言からの弱い傾向（±1）」だけを言わせ、
 * 点数の計算と段階の判定はこちら（コード）が持つ。
 *
 * 何も読み取れなかったときは、渡された `profile` をそのまま返す
 * （同じ内容を書き戻さない）。
 */
export function applyProfileSignals(
  profile: AdviceProfile,
  signals: AdviceProfileSignals,
  now: Date,
): AdviceProfile {
  const scores = { ...profile.scores };
  let moved = false;

  for (const axis of AXIS_ORDER) {
    const signal = signals[axis];
    if (typeof signal !== "number" || signal === 0) continue;
    const next = clampScore(scores[axis] + SIGNAL_STEP * signal);
    if (next === scores[axis]) continue; // 端に張り付いている
    scores[axis] = next;
    moved = true;
  }

  const state = nextState(profile.state, signals, now);
  if (!moved && state === profile.state) return profile;

  const updated: AdviceProfile = {
    ...profile,
    scores,
    // 診断で答えたときの点数は残す（無い記録は、いまの点数を診断時とみなす）
    baseScores: profile.baseScores ?? profile.scores,
    state,
  };

  // タイプが変わったときだけ記録に残す。点数の揺れをすべて積むと、
  // 5件の枠がその日のうちに埋まって、前の診断が見えなくなる
  if (resolveAdviceType(profile.scores) === resolveAdviceType(scores)) {
    return updated;
  }
  return appendAdviceHistory(profile, updated, "estimated", now.toISOString());
}

function clampScore(value: number): number {
  return Math.min(MAX_AXIS_SCORE, Math.max(0, value));
}

/**
 * 調子の更新。
 *
 * 受容度の「低」だけは2回続けて読み取れたときに反映する
 * （`lowStreak`）。高・中は読み取れた時点で反映してよい。
 */
function nextState(
  current: AdviceState | undefined,
  signals: AdviceProfileSignals,
  now: Date,
): AdviceState | undefined {
  if (!signals.acceptance && !signals.confidence) return current;

  // 記録がまだ無いときの土台。読み取れなかった側は「中」に置く
  // （高でも低でもない、いちばん害の小さい既定）
  const base: AdviceState = current ?? {
    acceptance: "mid",
    confidence: "mid",
    updatedAt: now.toISOString(),
  };

  let acceptance = base.acceptance;
  let lowStreak = base.lowStreak ?? 0;
  if (signals.acceptance === "low") {
    lowStreak += 1;
    if (lowStreak >= 2) acceptance = "low";
  } else if (signals.acceptance) {
    acceptance = signals.acceptance;
    lowStreak = 0;
  }

  return {
    acceptance,
    confidence: signals.confidence ?? base.confidence,
    updatedAt: now.toISOString(),
    lowStreak,
  };
}

/**
 * AIが返した `profileSignals` を、使える形に絞る。
 *
 * **壊れた値は捨てる。** AIは指示語をそのまま返すことがあり
 * （`"reader": "+1"`、`"acceptance": "low|mid|high"`）、
 * そのまま足すと点数が壊れる。想定した値以外は無かったことにする。
 */
export function parseProfileSignals(
  value: unknown,
): AdviceProfileSignals | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;

  const signals: AdviceProfileSignals = {};
  for (const axis of AXIS_ORDER) {
    const raw = record[axis];
    // -1 / 0 / +1 だけを受ける。0.7 や 3 のような値は読み違いなので捨てる
    if (raw === -1 || raw === 0 || raw === 1) signals[axis] = raw;
  }
  for (const kind of ["acceptance", "confidence"] as const) {
    const raw = record[kind];
    if (raw === "low" || raw === "mid" || raw === "high") signals[kind] = raw;
  }

  return Object.keys(signals).length > 0 ? signals : undefined;
}

/** 点数の表示（4 は「4」、4.5 は「4.5」） */
export function formatAdviceScore(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

/**
 * 診断時と現在の点数を並べた行
 * （「読者志向：診断 4 → 現在 4.5（中）」）。
 *
 * **動いたことが見えるようにする。** 推定で少しずつ動く仕組みなので、
 * いまの値だけを見せると「勝手に変わった」としか映らない。
 */
export function describeAdviceScoreShift(profile: AdviceProfile): string[] {
  const base = profile.baseScores ?? profile.scores;
  return AXIS_ORDER.map((axis) => {
    const level = ADVICE_LEVEL_LABELS[adviceLevel(profile.scores[axis])];
    if (base[axis] === profile.scores[axis]) {
      return `${ADVICE_AXIS_LABELS[axis]}：${formatAdviceScore(profile.scores[axis])}（${level}）`;
    }
    return (
      `${ADVICE_AXIS_LABELS[axis]}：診断 ${formatAdviceScore(base[axis])} → ` +
      `現在 ${formatAdviceScore(profile.scores[axis])}（${level}）`
    );
  });
}

/** 履歴のきっかけの呼び名 */
const HISTORY_SOURCE_LABELS: Record<AdviceHistorySource, string> = {
  diagnosis: "診断",
  estimated: "相談からの推定",
};

/**
 * 変化の履歴（新しい順、最大5行）。
 *
 * 先頭にいまのタイプを置き、そのあとに過去の記録を並べる。
 * 記録が無ければ空配列——初回は「変化」が無いので、何も出さない。
 */
export function describeAdviceHistory(profile: AdviceProfile): string[] {
  const history = profile.history ?? [];
  if (history.length === 0) return [];

  const head =
    `${adviceDiagnosisDate(profile.updatedAt) ?? "日付不明"} ` +
    `${ADVICE_TYPES[resolveAdviceType(profile.scores)].label}（いま）`;
  const past = history
    .slice(0, ADVICE_HISTORY_MAX)
    .map(
      (entry) =>
        `${adviceDiagnosisDate(entry.updatedAt) ?? "日付不明"} ` +
        `${ADVICE_TYPES[entry.typeId].label}` +
        `（${HISTORY_SOURCE_LABELS[entry.source ?? "diagnosis"]}）`,
    );
  return [head, ...past];
}

/**
 * 推定で動いた軸の一覧（「読者志向 3.5→4.0」）。
 *
 * ログ用。**小数点以下1桁で揃える**——「4」と書くと、動いたのか
 * もともと4だったのかが読めない。
 */
export function describeAdviceScoreMoves(
  before: AdviceScores,
  after: AdviceScores,
): string[] {
  return AXIS_ORDER.filter((axis) => before[axis] !== after[axis]).map(
    (axis) =>
      `${ADVICE_AXIS_LABELS[axis]} ${before[axis].toFixed(1)}→${after[axis].toFixed(1)}`,
  );
}
