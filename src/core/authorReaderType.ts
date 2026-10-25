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

/**
 * 履歴に残す出どころ。
 *
 * いまの点数の出どころ（`AuthorReaderSource`）に「微調整」を足したもの。
 * 9問に答えた作者の点数は、相談から微調整されても出どころは「9問のお答え」
 * のまま（答えたことは消えない）だが、履歴では「答えそのもの」と
 * 「答えを土台に微調整したもの」を見分けて出す。
 */
export type AuthorReaderHistorySource = AuthorReaderSource | "tuned";

const AUTHOR_READER_HISTORY_SOURCE_LABELS: Record<AuthorReaderHistorySource, string> = {
  ...AUTHOR_READER_SOURCE_LABELS,
  tuned: "9問のお答えを相談から微調整したもの",
};

/** 過去のタイプ。**人は変化する**ので、上書きせずに積む */
export interface AuthorReaderHistoryEntry {
  typeId: ReaderTypeId;
  scores: ReaderScores;
  /** その状態がいつの時点のものか（ISO） */
  updatedAt: string;
  source: AuthorReaderHistorySource;
}

export interface AuthorReaderProfile {
  /**
   * いまの点数。9問に答えた作者では、答えの点数（`baseScores`）に
   * 相談からの微調整が乗ったもの。
   */
  scores: ReaderScores;
  /**
   * 9問の答え（各0/1/2）。
   *
   * 点数だけでなく答えも残す。やり直すときに前回を初期値にできると、
   * 「1問だけ変えたい」が最短で済む。**推定で入ったときは無い。**
   * **微調整では書き換えない**（作者の裁定、2026-10-25 昼）。
   */
  answers?: number[];
  /**
   * 9問の答えから出した点数（微調整の土台。設計書6.86 の `baseScores` と
   * 同じ考え方）。
   *
   * 答えた直後は持たない（`scores` がそのまま答えの点数）。相談から初めて
   * 微調整したときに、動く前の点数をここへ控える。**答え直したら、新しい
   * 答えの点数が土台になる**（`authorReaderProfileFromAnswers` が作り直す）。
   */
  baseScores?: ReaderScores;
  /** いまの点数の出どころ */
  source: AuthorReaderSource;
  /**
   * いつの時点のものか（ISO）。
   *
   * - 9問に答えた作者：**答えた日のまま。微調整では動かさない**
   *   （6.86 と同じ。動かすと、答え直しの目安の30日が永久に来なくなり、
   *   似た1問の写し（`sharedDiagnosisQuestion.ts`）がどちらの答えが新しいかを
   *   取り違える）。微調整した日は `tunedAt` に持つ
   * - 推し量っているだけの作者：最後に推し量った日（答えた日が無いので、
   *   「いつの読み取りか」を1つ持てば足りる）
   */
  updatedAt: string;
  /** 最後に相談から微調整した日時（ISO）。9問に答えた作者だけが持つ */
  tunedAt?: string;
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
 *
 * **まだ見せていない推定は積まない**（作者の裁定、2026-10-25 昼「推し量れる
 * まで隠す」）。積むと、隠していた出発点の「雑食層」が、線を越えたあとや
 * 9問に答えたあとの履歴に現れる。
 */
export function appendAuthorReaderHistory(
  previous: AuthorReaderProfile | undefined,
  next: AuthorReaderProfile
): AuthorReaderProfile {
  if (!previous) return next;
  if (!shownAuthorReader(previous)) {
    return { ...next, history: previous.history ?? next.history };
  }

  const tuned = isAuthorReaderTuned(previous);
  const entry: AuthorReaderHistoryEntry = {
    typeId: resolveReaderType(previous.scores),
    scores: previous.scores,
    updatedAt: tuned ? (previous.tunedAt ?? previous.updatedAt) : previous.updatedAt,
    source: tuned ? "tuned" : previous.source,
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
  profile: Partial<Pick<AuthorReaderProfile, "source" | "answers">> | undefined
): boolean {
  if (!profile) return false;
  // 出どころの無い記録（古い形・3つの輪へ点数だけ渡す形）も答えた値として扱う。
  // 「推し量ったもの」と言えるのは、そう印の付いたものだけである
  return profile.source !== "estimated" || (profile.answers?.length ?? 0) > 0;
}

/**
 * 推定で読み取った点数を書き入れる口（設計書6.101）。
 *
 * 呼ぶのは `applyAuthorReaderSignals`（相談の答えから）だけ。
 *
 * **9問に答えていない作者のための口である。** 答えた値が渡されたら、
 * そのまま返す——答えた作者の点数は `recordTunedAuthorReaderType`
 * （答えを土台にした微調整）の側が動かし、ここで推定の点数に置き換えると
 * 9問の答えの印が消える（CLAUDE.md 実装ルール2の精神）。
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
 * 9問に答えた作者の点数を、相談から微調整する口（設計書6.101。作者の裁定、
 * 2026-10-25 昼「微調整した上で、微調整している旨を表示してください」）。
 *
 * - **9問の答え（`answers`）と出どころは書き換えない。** 動くのは `scores`
 *   だけで、動く前の答えの点数を `baseScores` に控える（6.86 と同じ持ち方）
 * - `updatedAt`（答えた日）は動かさない。微調整した日は `tunedAt`
 * - 層が変わったときだけ履歴へ積む（点数の揺れをすべて積むと枠が埋まる）
 */
export function recordTunedAuthorReaderType(
  previous: AuthorReaderProfile,
  scores: ReaderScores,
  now: Date
): AuthorReaderProfile {
  const next: AuthorReaderProfile = {
    ...previous,
    scores,
    baseScores: authorReaderBaseScores(previous),
    tunedAt: now.toISOString(),
  };
  if (resolveReaderType(previous.scores) !== resolveReaderType(scores)) {
    return appendAuthorReaderHistory(previous, next);
  }
  return next;
}

/**
 * 見せ方を決めるのに要る項目だけの形（3つの輪のように、点数と出どころだけを
 * 運ぶ所でも同じ判定を通せるようにする）
 */
export type AuthorReaderView = Pick<AuthorReaderProfile, "scores"> &
  Partial<Pick<AuthorReaderProfile, "source" | "answers" | "baseScores">>;

/**
 * 9問の答えの点数（微調整の土台）。
 *
 * 控えが無ければ（答えた直後・古い記録）いまの点数を土台とみなす
 * （6.86 の `baseScores ?? scores` と同じ）。
 */
export function authorReaderBaseScores(profile: AuthorReaderProfile): ReaderScores {
  return profile.baseScores ?? profile.scores;
}

/** 9問の答えを土台に、相談から微調整されているか（どれかの軸が土台から動いたか） */
export function isAuthorReaderTuned(
  profile: AuthorReaderView
): boolean {
  if (!isAnsweredAuthorReader(profile)) return false;
  const base = profile.baseScores;
  if (!base) return false;
  return READER_AXIS_ORDER.some((axis) => base[axis] !== profile.scores[axis]);
}

/**
 * 微調整で、層が9問の答えと変わったか（画面に微調整の断りを出す線）。
 *
 * **層が変わったときだけ断る**（作者の判断、2026-10-25 昼「層が変わったとき
 * だけ出す」）。答えと同じ層のうちは、点数が少し動いていても、答えたときと
 * 同じ見え方にする——作者に見えるのは層なので、層の変わらない動きまで
 * 「微調整しています」と言うと、何が変わったのか分からない断りになる。
 * 履歴の出どころ（`tuned`）は点数が動いたかで分けたままにする（記録なので）。
 */
export function isAuthorReaderTypeShifted(profile: AuthorReaderView): boolean {
  if (!isAuthorReaderTuned(profile)) return false;
  return (
    resolveReaderType(profile.scores) !==
    resolveReaderType(profile.baseScores ?? profile.scores)
  );
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

/** 出発点の層（3軸とも中ほど＝雑食層）。「推し量れた」の線に使う */
const NEUTRAL_TYPE: ReaderTypeId = resolveReaderType(NEUTRAL_SCORES);

/**
 * 推し量っているだけの値を、画面に出してよいところまで推し量れたか
 * （「推し量れた」の線。作者の裁定、2026-10-25 昼「推し量れるまで隠した上で、
 * 推定である旨記載してください」）。
 *
 * **線は「層が出発点（雑食層）から離れたか」の1つだけにする。** 出発点の
 * 3点から ±0.5 ずつ動くので、同じ向きの発言が下へは3回（1.5点で「低」）、
 * 上へは4回（5点で「高」）積もると層が変わる——1〜2回の相談の言い回しで
 * 出さない速さである。点数の幅で別の数を持たないのは、段階の境目
 * （`threeAxis.ts` の 2・5）を写すことになり、上向きの作者には 4.5点でも
 * 「雑食層（推し量ったもの）」が出てしまうためである。
 *
 * 9問に答えた値は、この線と関係なく常に出す（答えたものだから）。
 */
export function isAuthorReaderEstimateSettled(
  profile: Pick<AuthorReaderProfile, "scores">
): boolean {
  return resolveReaderType(profile.scores) !== NEUTRAL_TYPE;
}

/**
 * 画面に出してよい作者の読者タイプ。**まだ推し量れていなければ `undefined`**
 * （未診断と同じ扱いにする）。
 *
 * 作者の目に触れる所（ターゲットシートの3つの輪・作品の読者との突き合わせ・
 * 作家タイプ診断の入口・結果の画面）は、すべてここを通す。1か所ずつ
 * `source` を見て隠すと、片方だけ直る所が出る。
 */
export function shownAuthorReader<
  T extends AuthorReaderView,
>(profile: T | undefined): T | undefined {
  if (!profile) return undefined;
  if (isAnsweredAuthorReader(profile)) return profile;
  return isAuthorReaderEstimateSettled(profile) ? profile : undefined;
}

/**
 * まだ推し量れていない推定だけがあるか（9問にも答えていない）。
 * 画面ごとに「まだ相談から推し量れていません」の断りを出す見分けに使う。
 */
export function isAuthorReaderEstimatePending(
  profile: AuthorReaderProfile | undefined
): boolean {
  return profile !== undefined && shownAuthorReader(profile) === undefined;
}

/** 推し量れていないことの短い断り（画面で共用する） */
export const AUTHOR_READER_PENDING_NOTE = "まだ相談から推し量れていません";

/**
 * 相談から読み取った傾向を、作者の読者タイプへ反映する（設計書6.101）。
 *
 * - **9問に答えていたら、答えを土台に微調整する**（作者の裁定、2026-10-25 昼。
 *   0.111.8 の「答えた値が常に勝つ」を改めた）。答えそのもの（`answers`）は
 *   書き換えず、動く前の答えの点数を `baseScores` に控える
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

  if (previous && isAnsweredAuthorReader(previous)) {
    return recordTunedAuthorReaderType(previous, scores, now);
  }
  return recordEstimatedAuthorReaderType(previous, scores, now);
}

/**
 * 相談で動いたことを作者へ知らせる文（設計書6.101）。
 *
 * **黙って作らない・黙って変えない。** 言うのは、画面に出る層が変わった
 * ときだけ（同じことを毎回言わない）。
 *
 * - 推し量っているだけの作者：線（`isAuthorReaderEstimateSettled`）を
 *   越えて初めて出る回に「推し量りました」を言う。線の手前では黙る——
 *   どの軸にもまだ傾きが見えていない状態で「雑食層と推し量りました」と
 *   言うと、1回の相談で読み方を決めたように聞こえる。出していた層が
 *   線の手前（出発点の雑食層）へ戻ったら、**黙って隠す**（作者の判断、
 *   2026-10-25 昼「黙って隠す」）。見え方は推し量れていないときと同じに
 *   戻る。戻ったことは呼ぶ側のログにだけ残す
 * - 9問に答えた作者：微調整で層が変わったら「答えは〇〇層、相談から
 *   〇〇層へ寄せています」。答えの層へ戻ったら、戻ったことを言う
 *   ——こちらは画面に「△△層（9問の答えは〇〇層…）」と出していたものが
 *   答えの層の見え方へ戻るので、黙ると見えていた層が理由なく消える
 */
export function describeAuthorReaderEstimate(
  before: AuthorReaderProfile | undefined,
  after: AuthorReaderProfile | undefined
): string[] {
  if (!after || after === before) return [];

  if (isAnsweredAuthorReader(after)) {
    if (!before) return [];
    const beforeType = resolveReaderType(before.scores);
    const afterType = resolveReaderType(after.scores);
    if (beforeType === afterType) return [];
    const baseType = resolveReaderType(authorReaderBaseScores(after));
    const baseLabel = READER_TYPES[baseType].label;
    const undo =
      "違うと感じたら、「自分の読者タイプ」から9問に答え直すと、新しい答えを土台にやり直します。";
    if (afterType === baseType) {
      return [
        `読者としてのあなたは、相談からの微調整が、9問の答え（${baseLabel}）へ戻りました。`,
        undo,
      ];
    }
    return [
      `読者としてのあなたは、答えは${baseLabel}、相談から${READER_TYPES[afterType].label}へ寄せています。`,
      undo,
    ];
  }

  const beforeShown = shownAuthorReader(before);
  const afterShown = shownAuthorReader(after);
  // 出していた層が真ん中へ戻ったとき（!afterShown）も、ここで黙る
  if (!afterShown) return [];
  if (!beforeShown) {
    return [
      `相談でのお話から、読者としてのあなたを「${authorReaderTypeLabel(after)}」と推し量りました。`,
      AUTHOR_READER_ESTIMATE_NOTE,
    ];
  }
  return describeAuthorReaderChange(before, after);
}

/**
 * 推し量った値であることの断り（画面と紙で共用する）。
 *
 * **作者が決めたものとして扱わない**（実装ルール2の精神）。9問に答えれば
 * 答えが土台になり、そのあとは相談から微調整することも併せて言う。
 */
export const AUTHOR_READER_ESTIMATE_NOTE =
  "これは相談でのお話から推し量ったもので、あなたが決めたものではありません。" +
  "作家タイプ診断の「読者としての好み」（9問）に答えると、その答えが土台になります（そのあとは相談から微調整します）。";

/**
 * 微調整していることの断り（作者の裁定、2026-10-25 昼）。
 *
 * **土台の答えの層を必ず名指しする。** いまの層だけを出すと、作者は
 * 「そう答えた覚えは無い」になる（6.86 の「いま：」と同じ用心）。
 * 出すのは層が答えと変わったときだけ（`isAuthorReaderTypeShifted`。
 * 呼ぶのは `authorReaderNote`）。
 */
export function authorReaderTuningNote(
  profile: Pick<AuthorReaderProfile, "scores" | "baseScores">
): string {
  const baseLabel = READER_TYPES[resolveReaderType(profile.baseScores ?? profile.scores)].label;
  const nowLabel = READER_TYPES[resolveReaderType(profile.scores)].label;
  return (
    `9問の答え（${baseLabel}）を土台に、相談から微調整しています` +
    `（いまは${nowLabel}へ寄せています）。` +
    "答え直すと、新しい答えを土台にやり直します。"
  );
}

/**
 * 作者の読者タイプに添える断り（推し量ったもの／微調整しているもの／無し）。
 *
 * 断りを出す所（突き合わせの行・3つの輪の節・結果の画面）は、すべてここを
 * 通す。**まだ推し量れていない値には呼ばない**（`shownAuthorReader` で先に外す）。
 */
export function authorReaderNote(
  profile: AuthorReaderView
): string | undefined {
  if (!isAnsweredAuthorReader(profile)) return AUTHOR_READER_ESTIMATE_NOTE;
  // 答えと同じ層のうちは、答えたときと同じ見え方（断りなし）にする
  return isAuthorReaderTypeShifted(profile) ? authorReaderTuningNote(profile) : undefined;
}

/** いまのタイプの呼び名（「考察層」） */
export function authorReaderTypeLabel(profile: Pick<AuthorReaderProfile, "scores">): string {
  return READER_TYPES[resolveReaderType(profile.scores)].label;
}

/**
 * 画面に出す呼び名。**推し量ったもの・微調整しているものなら、そう分かる
 * 言い方にする**（「考察層（相談から推し量ったもの）」
 * 「考察層（9問の答えは雑食層。相談から微調整しています）」）。
 * **まだ推し量れていなければ** `AUTHOR_READER_PENDING_NOTE` を返す。
 *
 * 記録（ログ）には `authorReaderTypeLabel` を使ってよいが、作者の目に
 * 触れる所ではこちらを使う。
 */
export function authorReaderTypeDisplay(profile: AuthorReaderProfile): string {
  if (!shownAuthorReader(profile)) return AUTHOR_READER_PENDING_NOTE;
  const label = authorReaderTypeLabel(profile);
  if (!isAnsweredAuthorReader(profile)) return `${label}（相談から推し量ったもの）`;
  // 層が答えと同じうちは、答えたときと同じ見え方（作者の判断、2026-10-25 昼）
  if (!isAuthorReaderTypeShifted(profile)) return label;
  const baseLabel = READER_TYPES[resolveReaderType(authorReaderBaseScores(profile))].label;
  return `${label}（9問の答えは${baseLabel}。相談から微調整しています）`;
}

/**
 * 変わったことを作者へ知らせる3点
 * （**何が何に変わったか・なぜそう読み取ったか・戻し方**）。
 *
 * **黙って変えない**（6.86 と同じ約束）。変わっていなければ空配列——
 * 同じことを繰り返し言わない。
 *
 * 前がまだ推し量れていない値なら、何も言わない——作者に一度も見せて
 * いない「雑食層」から変わったと言うと、隠していた出発点が出てしまう。
 */
export function describeAuthorReaderChange(
  before: AuthorReaderProfile | undefined,
  after: AuthorReaderProfile
): string[] {
  if (!before || !shownAuthorReader(before)) return [];
  const beforeLabel = authorReaderTypeLabel(before);
  const afterLabel = authorReaderTypeLabel(after);
  if (beforeLabel === afterLabel) return [];

  const when = adviceDiagnosisDate(
    isAuthorReaderTuned(before) ? (before.tunedAt ?? before.updatedAt) : before.updatedAt
  );
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
    `${adviceDiagnosisDate(isAuthorReaderTuned(profile) ? (profile.tunedAt ?? profile.updatedAt) : profile.updatedAt) ?? "日付不明"} ` +
    `${authorReaderTypeLabel(profile)}（いま）`;
  const past = history.slice(0, AUTHOR_READER_HISTORY_MAX).map(
    (entry) =>
      `${adviceDiagnosisDate(entry.updatedAt) ?? "日付不明"} ` +
      `${READER_TYPES[entry.typeId].label}` +
      `（${AUTHOR_READER_HISTORY_SOURCE_LABELS[entry.source] ?? AUTHOR_READER_SOURCE_LABELS.diagnosis}）`
  );
  return [head, ...past];
}
