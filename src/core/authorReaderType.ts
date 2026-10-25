import {
  ADVICE_HISTORY_MAX,
  ADVICE_REDIAGNOSE_DAYS,
  adviceDiagnosisDate,
  isDiagnosisStale,
  MAX_AXIS_SCORE,
  SIGNAL_STEP,
} from "./advicePolicy";
import { READER_NEUTRAL_SCORE } from "./readerTargetValidation";
import {
  READER_AXIS_ORDER,
  READER_QUESTIONS,
  READER_TYPES,
  resolveReaderType,
  scoreReaderAnswers,
  type ReaderQuestion,
} from "./readerTarget";
import type { ReaderAxis, ReaderScores } from "../models/readerProfile";
import type { ReaderTypeId } from "./readerTarget";

/**
 * 作者自身の読者タイプ（設計書6.101、実装の順「1」）。
 *
 * **作品のターゲット読者（6.91）とは別物である。** あちらは「この作品は
 * 誰に届けるか」、こちらは「**作者自身が読者として何を求めるか**」で、
 * 作品ごとではなく**作者ごとに1つ**持つ。
 *
 * ## なぜ要るか
 *
 * 3つの輪（すでに書けたもの・書きたいもの・読者が読みたいもの）のうち、
 * 「読者が読みたいもの」だけは作者が直接観測できない。だから作者は
 * **無意識に自分の読み癖で代用する**。作者の読者タイプは、その代用が
 * 何であるかを名指しできる——**そのズレが「作者が気づけない場所」**になる。
 *
 * ## 6.86（助言方針）の形をそのまま写す
 *
 * 新しい流儀を作らない。点数・出どころ・履歴・更新日時の持ち方も、
 * 履歴の上限（`ADVICE_HISTORY_MAX`）も再診断の目安
 * （`ADVICE_REDIAGNOSE_DAYS`）も**同じ値を使い回す**（写しを作らない）。
 *
 * ## 問いは 6.91 のものを、主語だけ変えて使う
 *
 * 診断を増やさない（3つに増えると27問になり、答えるのが苦行になる）。
 * **軸と点数の構造は `READER_QUESTIONS` をそのまま使い、文面だけ変える。**
 * 別の配列を手で書くと、軸の並びや点数が片方だけ直る日が来る。
 *
 * VS Code APIにも AI にも依存しない。
 */

/** 履歴に残す件数。**6.86 と同じ値を使う**（写しを作らない） */
export const AUTHOR_READER_HISTORY_MAX = ADVICE_HISTORY_MAX;

/** 答え直したほうがよい目安（日）。こちらも 6.86 と同じ */
export const AUTHOR_READER_REDIAGNOSE_DAYS = ADVICE_REDIAGNOSE_DAYS;

/** 点数がどこから来たか */
export type AuthorReaderSource = "diagnosis" | "estimated";

/** 出どころの呼び名（画面と記録で共用する） */
export const AUTHOR_READER_SOURCE_LABELS: Record<AuthorReaderSource, string> = {
  diagnosis: "9問のお答え",
  estimated: "相談での発言からの推定",
};

/** 過去のタイプ。**人は変化する**ので、上書きせずに積む */
export interface AuthorReaderHistoryEntry {
  typeId: ReaderTypeId;
  scores: ReaderScores;
  /** その状態がいつの時点のものか（ISO） */
  updatedAt: string;
  source: AuthorReaderSource;
}

export interface AuthorReaderProfile {
  scores: ReaderScores;
  /**
   * 9問の答え（各0/1/2）。
   *
   * 点数だけでなく答えも残す。やり直すときに前回を初期値にできると、
   * 「1問だけ変えたい」が最短で済む。**推定で入ったときは無い。**
   */
  answers?: number[];
  /** いまの点数の出どころ */
  source: AuthorReaderSource;
  /**
   * いつの時点のものか（ISO）。
   *
   * 6.86 の `AdviceProfile.updatedAt` と違い、**推定で動いたときも
   * ここを動かす。** あちらは診断した日を別に持つ必要があったが
   * （やり直しの目安のため）、こちらは `source` でどちらか分かるので、
   * 「いつの読み取りか」を1つ持てば足りる。
   */
  updatedAt: string;
  /** 過去のタイプ（新しいものが先。最大 `AUTHOR_READER_HISTORY_MAX` 件） */
  history?: AuthorReaderHistoryEntry[];
}

/**
 * 問いの文面（読む側の主語へ書き換えたもの）。
 *
 * 鍵は `READER_QUESTIONS` の `id`。**軸も点数もここには書かない**——
 * そこは元の問いから受け継ぐ。ここにあるのは文面だけである。
 */
interface AuthorReaderRewrite {
  text: string;
  /** 0点・1点・2点の順。元の問いと同じ並び */
  labels: [string, string, string];
}

const AUTHOR_READER_REWRITES: Record<string, AuthorReaderRewrite> = {
  A1: {
    text: "その題材のお約束（いわゆるテンプレ）が出てきたとき、読んでいてどう感じますか",
    labels: [
      "ていねいに説明があると安心する。まだ慣れていない",
      "知っているものもあれば、初めて見るものもある",
      "見飽きている。説明されると読み飛ばす",
    ],
  },
  A2: {
    text: "作品の中だけの言葉（造語・独自の用語）に出会ったとき、どう読みますか",
    labels: [
      "その場で説明してほしい",
      "流れの中で分かれば足りる",
      "説明は要らない。読んでいれば分かる",
    ],
  },
  A3: {
    text: "いま好きな題材について、似た作品をどれくらい読んできましたか",
    labels: [
      "ほとんど読んでいない。これから知るところ",
      "人並みには読んでいる",
      "かなり読んでいる。定番はひととおり通った",
    ],
  },
  B1: {
    text: "1話が長いと感じるのは、どのあたりからですか",
    labels: [
      "移動中に読み切れないと長い",
      "話の切れ目まで読めれば、長さは気にならない",
      "長くても気にならない。読み応えがあるほうがよい",
    ],
  },
  B2: {
    text: "話の終わりに次への引きが無かったとき、続きを読みますか",
    labels: [
      "引きが無いと、そこで止まってしまう",
      "作品による",
      "引きが無くても読む。1話として収まっていればよい",
    ],
  },
  B3: {
    text: "前の話の中身を、どれくらい覚えて次の話に入りますか",
    labels: [
      "たいてい忘れている。毎回思い出させてほしい",
      "大事なところは覚えている",
      "覚えている。分からなければ自分で読み返す",
    ],
  },
  C1: {
    text: "主人公がひどい目に遭う場面を、読者としてどう読みますか",
    labels: [
      "長く続くとつらい。早く報われてほしい",
      "話に必要なら読む",
      "逃げずに描いてあるほうがよい。報われなくても読む",
    ],
  },
  C2: {
    text: "読み終わったあと、自分はどう感じていたいですか",
    labels: [
      "すっきりしていたい",
      "満ち足りていたい",
      "しばらく引きずっていたい",
    ],
  },
  C3: {
    text: "結末に、いちばん何を求めますか",
    labels: [
      "気持ちよく終わること",
      "物語として筋が通っていること",
      "嘘がないこと。苦くてもそのほうがよい",
    ],
  },
};

/**
 * 作者自身について聞く9問。
 *
 * **`READER_QUESTIONS` から作る。** 軸・点数・並びはそのまま受け継ぎ、
 * 文面だけ差し替える。答えの並びが揃うので、採点は
 * `scoreReaderAnswers` をそのまま通せる。
 *
 * 書き換えの無い問いは、元の文面のまま出す。**拡張機能ごと落とすより
 * ましだから**である（問いが増えたときにここを足し忘れることはあるが、
 * それは `authorReaderType.test.ts` が落ちて分かる）。
 */
export const AUTHOR_READER_QUESTIONS: ReaderQuestion[] = READER_QUESTIONS.map(
  (question) => {
    const rewrite = AUTHOR_READER_REWRITES[question.id];
    if (!rewrite) return question;
    return {
      ...question,
      text: rewrite.text,
      choices: question.choices.map((choice, index) => ({
        ...choice,
        label: rewrite.labels[index] ?? choice.label,
      })),
    };
  }
);

/**
 * 前回を履歴へ積む。**前回を消さない**——変化そのものが作者への情報で、
 * 「前はすきま層だった」と見えることに意味がある。
 */
export function appendAuthorReaderHistory(
  previous: AuthorReaderProfile | undefined,
  next: AuthorReaderProfile
): AuthorReaderProfile {
  if (!previous) return next;

  const entry: AuthorReaderHistoryEntry = {
    typeId: resolveReaderType(previous.scores),
    scores: previous.scores,
    updatedAt: previous.updatedAt,
    source: previous.source,
  };
  return {
    ...next,
    history: [entry, ...(previous.history ?? [])].slice(
      0,
      AUTHOR_READER_HISTORY_MAX
    ),
  };
}

/** 9問の答えから、作者自身の読者タイプを作る */
export function authorReaderProfileFromAnswers(
  answers: readonly number[],
  now: Date,
  previous?: AuthorReaderProfile
): AuthorReaderProfile {
  const fresh: AuthorReaderProfile = {
    scores: scoreReaderAnswers(answers),
    answers: [...answers],
    source: "diagnosis",
    updatedAt: now.toISOString(),
    history: previous?.history,
  };
  return appendAuthorReaderHistory(previous, fresh);
}

/**
 * 作者が9問で答えた値か（推定で動かしてはいけない値か）。
 *
 * `source` だけでなく `answers` も見る。古い記録や手で直された記録で
 * 出どころが食い違っていても、**答えが残っているなら答えた値として守る**
 * ——取り違えたときに失うのは作者が答えた手間のほうだからである。
 */
export function isAnsweredAuthorReader(
  profile: AuthorReaderProfile | undefined
): boolean {
  if (!profile) return false;
  return profile.source === "diagnosis" || (profile.answers?.length ?? 0) > 0;
}

/**
 * 推定で読み取った点数を書き入れる口（設計書6.101）。
 *
 * 呼ぶのは `applyAuthorReaderSignals`（相談の答えから）だけ。
 *
 * **作者が9問で答えた値の上には書かない**（作者の裁定、2026-10-25
 * 「推定を作る」。CLAUDE.md 実装ルール2の精神）。答えた値が渡されたら、
 * そのまま返す——呼ぶ側は同一性で「動かなかった」と分かる。
 * 推定が働くのは、まだ9問に答えていない作者だけである。
 */
export function recordEstimatedAuthorReaderType(
  previous: AuthorReaderProfile | undefined,
  scores: ReaderScores,
  now: Date
): AuthorReaderProfile {
  if (previous && isAnsweredAuthorReader(previous)) return previous;

  const next: AuthorReaderProfile = {
    scores,
    // 9問の答えは持たない（推定の点数に、答えの印を付けない）
    source: "estimated",
    updatedAt: now.toISOString(),
    history: previous?.history,
  };

  // タイプが変わったときだけ記録に残す。点数の揺れをすべて積むと、
  // 枠がその日のうちに埋まって、前の診断が見えなくなる（6.86 と同じ）
  if (
    previous &&
    resolveReaderType(previous.scores) !== resolveReaderType(scores)
  ) {
    return appendAuthorReaderHistory(previous, next);
  }
  return next;
}

/**
 * 相談の答えから読み取った、作者の読み方の弱い傾向（設計書6.101）。
 *
 * 軸ごとに -1・0・+1 だけ。**AIにタイプの名前を言わせない**（6.86 の
 * `profileSignals`、6.91.6 の P-38 と同じ考え方）。1回の会話で人の読み方は
 * 決められないし、名前を選ばせると点数が名前に引きずられる。名前は
 * 点数から `resolveReaderType` が決めるので、いまの表（`READER_TYPE_TABLE`
 * と全中・全低）に無い層が作者に見えることは、作りの上で起きない。
 */
export type AuthorReaderSignals = Partial<Record<ReaderAxis, -1 | 0 | 1>>;

/**
 * AIが返した `authorReaderSignals` を、使える形に絞る。
 *
 * **壊れた値は捨てる**（実装ルール3）。AIは指示語をそのまま返すことがあり
 * （`"+1"`・`"familiarity"`）、層の名前（`"type": "考察層"`）を勝手に
 * 足してくることもある。軸の鍵に -1・0・+1 が入ったものだけを通し、
 * 1つも残らなければ「読み取れなかった」として `undefined` を返す。
 */
export function parseAuthorReaderSignals(
  value: unknown
): AuthorReaderSignals | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const signals: AuthorReaderSignals = {};
  for (const axis of READER_AXIS_ORDER) {
    const raw = record[axis];
    // 0.7 や 3 のような値は読み違いなので捨てる（6.86 と同じ）
    if (raw === -1 || raw === 0 || raw === 1) signals[axis] = raw;
  }
  return Object.keys(signals).length > 0 ? signals : undefined;
}

/**
 * まだ何も分かっていない作者の出発点（3軸とも「どちらとも言えない」）。
 *
 * 本文の実像を測れなかった軸に置く値（`READER_NEUTRAL_SCORE`、6.91.6）と
 * 同じ考え方で、**どちらへも寄せていない場所**から始める。
 */
const NEUTRAL_SCORES: ReaderScores = {
  familiarity: READER_NEUTRAL_SCORE,
  posture: READER_NEUTRAL_SCORE,
  craving: READER_NEUTRAL_SCORE,
};

/**
 * 相談から読み取った傾向を、作者の読者タイプへ反映する（設計書6.101）。
 *
 * - **9問に答えていたら何もしない**（渡された値をそのまま返す）。
 *   答えた値が常に勝つ（作者の裁定、2026-10-25）
 * - まだ何も無ければ、3軸とも中ほど（3点）から始める
 * - 動かす幅は 6.86 と同じ ±0.5（`SIGNAL_STEP`）、0〜6 に収める
 *   ——段階が1つ動くまでにおよそ数回〜10回の相談がかかる。1回の会話で
 *   読み方が決まったことにしない速さである
 *
 * 何も動かなければ `previous` をそのまま返す（同じ内容を書き戻さない。
 * 呼ぶ側は同一性で見分ける）。
 */
export function applyAuthorReaderSignals(
  previous: AuthorReaderProfile | undefined,
  signals: AuthorReaderSignals | undefined,
  now: Date
): AuthorReaderProfile | undefined {
  if (!signals) return previous;
  if (isAnsweredAuthorReader(previous)) return previous;

  const scores: ReaderScores = { ...(previous?.scores ?? NEUTRAL_SCORES) };
  let moved = false;
  for (const axis of READER_AXIS_ORDER) {
    const signal = signals[axis];
    if (typeof signal !== "number" || signal === 0) continue;
    const next = Math.min(
      MAX_AXIS_SCORE,
      Math.max(0, scores[axis] + SIGNAL_STEP * signal)
    );
    if (next === scores[axis]) continue; // 端に張り付いている
    scores[axis] = next;
    moved = true;
  }
  if (!moved) return previous;

  return recordEstimatedAuthorReaderType(previous, scores, now);
}

/**
 * 推定で動いたことを作者へ知らせる文（設計書6.101）。
 *
 * **黙って作らない・黙って変えない。** ただし初めて推し量った回は
 * `describeAuthorReaderChange` が何も言わない（前が無い）ので、ここで
 * 「推し量りました」を言う。
 *
 * 出発点の中ほど（雑食層）にいるあいだは、初回を言わない。どの軸にも
 * まだ傾きが見えていない状態で「雑食層と推し量りました」と言うと、
 * 1回の相談で読み方を決めたように聞こえる。
 */
export function describeAuthorReaderEstimate(
  before: AuthorReaderProfile | undefined,
  after: AuthorReaderProfile | undefined
): string[] {
  if (!after || after === before || after.source !== "estimated") return [];

  const afterType = resolveReaderType(after.scores);
  const neutralType = resolveReaderType(NEUTRAL_SCORES);
  const firstTime =
    !before ||
    (before.source === "estimated" &&
      (before.history ?? []).length === 0 &&
      resolveReaderType(before.scores) === neutralType);

  if (!firstTime) return describeAuthorReaderChange(before, after);
  if (afterType === neutralType) return [];

  return [
    `相談でのお話から、読者としてのあなたを「${READER_TYPES[afterType].label}」と推し量りました。`,
    AUTHOR_READER_ESTIMATE_NOTE,
  ];
}

/**
 * 推し量った値であることの断り（画面と紙で共用する）。
 *
 * **作者が決めたものとして扱わない**（実装ルール2の精神）。9問に答えれば
 * 答えのほうに替わり、以後は推し量らないことも併せて言う。
 */
export const AUTHOR_READER_ESTIMATE_NOTE =
  "これは相談でのお話から推し量ったもので、あなたが決めたものではありません。" +
  "作家タイプ診断の「読者としての好み」（9問）に答えると、そちらに替わります（以後は推し量りません）。";

/** いまのタイプの呼び名（「考察層」） */
export function authorReaderTypeLabel(profile: AuthorReaderProfile): string {
  return READER_TYPES[resolveReaderType(profile.scores)].label;
}

/**
 * 画面に出す呼び名。**推し量ったものなら、そう分かる言い方にする**
 * （「考察層（相談から推し量ったもの）」）。
 *
 * 記録（ログ）には `authorReaderTypeLabel` を使ってよいが、作者の目に
 * 触れる所ではこちらを使う。
 */
export function authorReaderTypeDisplay(profile: AuthorReaderProfile): string {
  const label = authorReaderTypeLabel(profile);
  return profile.source === "estimated"
    ? `${label}（相談から推し量ったもの）`
    : label;
}

/**
 * 変わったことを作者へ知らせる3点
 * （**何が何に変わったか・なぜそう読み取ったか・戻し方**）。
 *
 * **黙って変えない**（6.86 と同じ約束）。変わっていなければ空配列——
 * 同じことを繰り返し言わない。
 */
export function describeAuthorReaderChange(
  before: AuthorReaderProfile | undefined,
  after: AuthorReaderProfile
): string[] {
  if (!before) return [];
  const beforeLabel = authorReaderTypeLabel(before);
  const afterLabel = authorReaderTypeLabel(after);
  if (beforeLabel === afterLabel) return [];

  const when = adviceDiagnosisDate(before.updatedAt);
  return [
    `読者としてのあなたの読み取りが変わりました：${beforeLabel}` +
      `${when ? `（${when}）` : ""} → ${afterLabel}`,
    `そう読み取ったのは、${AUTHOR_READER_SOURCE_LABELS[after.source]}からです。`,
    "違うと感じたら、「自分の読者タイプ」からやり直せます（消して素の状態にも戻せます）。",
  ];
}

/**
 * 答え直したほうがよい頃合いか。
 *
 * 判定は 6.86 と同じものを使う。日付が読めないときは「古い」と言わない
 * ——直しようのない注意が出続けるため。
 */
export function isAuthorReaderStale(
  profile: AuthorReaderProfile,
  now: Date
): boolean {
  return isDiagnosisStale(profile.updatedAt, now);
}

/**
 * 変化の履歴（新しい順）。先頭にいまのタイプを置く。
 *
 * 記録が無ければ空配列——初回は「変化」が無いので、何も出さない。
 */
export function describeAuthorReaderHistory(
  profile: AuthorReaderProfile
): string[] {
  const history = profile.history ?? [];
  if (history.length === 0) return [];

  const head =
    `${adviceDiagnosisDate(profile.updatedAt) ?? "日付不明"} ` +
    `${authorReaderTypeLabel(profile)}（いま）`;
  const past = history.slice(0, AUTHOR_READER_HISTORY_MAX).map(
    (entry) =>
      `${adviceDiagnosisDate(entry.updatedAt) ?? "日付不明"} ` +
      `${READER_TYPES[entry.typeId].label}` +
      `（${AUTHOR_READER_SOURCE_LABELS[entry.source]}）`
  );
  return [head, ...past];
}
