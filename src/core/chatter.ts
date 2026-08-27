import type { ChatRunKind } from "./chatEdit";

/**
 * AIの独り言（設計書6.21）。
 *
 * 書いている最中に、相談パネルへ一言だけ差し込む機能である。
 * 「本日の執筆文字数が1,000文字を超えました！」のような区切りの報せと、
 * 「空き時間に資料抽出やっておきましょうか？」のような手伝いの申し出。
 *
 * **ここは何を言うかを決めるだけで、言う手段は持たない。**
 * VSCodeに依存させないのは、うるさすぎないかを試験で確かめたいため。
 * 独り言は間違えると**作者の邪魔にしかならない**ので、
 * 出す条件は目で追えるところに置く。
 *
 * 守っていること。
 *
 * - **同じことを二度言わない。** 鍵（`key`）で1日1回に絞る。
 *   節目を跨ぐたびに何度も言う相棒は、ただの雑音になる
 * - **手が止まっているときにだけ話しかける。** 書いている最中に
 *   割り込まない（`idleMs`）
 * - **手伝いの申し出は、実際に仕事があるときだけ。** 用も無いのに
 *   「やりましょうか？」と言われると、次から読まなくなる
 */

/** 節目にする字数。刻みすぎると、書くほどうるさくなる */
const MILESTONES = [1_000, 3_000, 5_000, 10_000, 20_000, 30_000] as const;

/**
 * 話しかけてよいと判断するまでの無操作時間。
 *
 * 最初は2分にしていた（考えて手が止まっているところへ話しかけない）が、
 * **作者の指定で20秒へ**（2026-08-27）。「20秒程度で動けるようになれば
 * いい。動かなくてもかまわない」——話しかける保証は要らず、
 * 頻度の抑えは QUIET_GAP と「同じことは1日1回」の側が受け持つ。
 */
export const IDLE_THRESHOLD_MS = 20 * 1_000;

export type ChatterKind =
  /** その日の字数が節目を超えた */
  | "milestone"
  /** その日の目標を達成した */
  | "goalReached"
  /** 連続して書いた日数が節目に届いた */
  | "streak"
  /** 承認待ちの更新がたまっている */
  | "pendingUpdates"
  /** 同じ人物とみられる組がある */
  | "mergeCandidates"
  /** 空き時間に資料抽出をしないか */
  | "idleExtract"
  /** 誤字脱字を見ておかないか */
  | "idleTypos";

export interface ChatterState {
  /** その日ここまでに書いた字数 */
  writtenToday: number;
  /** 日次目標。0なら未設定 */
  dailyGoal: number;
  /** 連続して書いた日数 */
  streak: number;
  /** 承認待ちの更新の件数 */
  pendingUpdates: number;
  /** 同じ人物とみられる組の件数 */
  mergeCandidates: number;
  /** 最後に本文を保存してからの経過ミリ秒 */
  idleMs: number;
  /**
   * まだ設定資料を抽出していない話数。
   * 分からないときは undefined（申し出ない）。
   */
  unextractedEpisodes?: number;
  /** いま開いている本文のパス。誤字脱字の申し出に使う */
  openManuscriptPath?: string;
  /** その日すでに言ったことの鍵 */
  saidToday: ReadonlySet<string>;
}

export interface Chatter {
  /** 同じことを言わないための鍵。1日1回に絞る */
  key: string;
  kind: ChatterKind;
  text: string;
  /** 押すと動く機能。申し出のときだけ付く */
  run?: { kind: ChatRunKind; label: string };
}

/**
 * いま言うことを1つだけ決める。無ければ黙る。
 *
 * **1回に1つしか返さない。** まとめて3つ出すと、
 * それは独り言ではなくお知らせの一覧になる。
 */
export function decideChatter(state: ChatterState): Chatter | undefined {
  for (const candidate of candidates(state)) {
    if (!state.saidToday.has(candidate.key)) return candidate;
  }
  return undefined;
}

/**
 * 言えることを、言いたい順に並べる。
 *
 * 祝いを先に置くのは、**手伝いの申し出より嬉しいから**である。
 * 目標を達成した直後に「抽出やっておきましょうか？」と言われては興が削がれる。
 */
function candidates(state: ChatterState): Chatter[] {
  const out: Chatter[] = [];

  // ── 祝う（書いている最中でも割り込んでよい。手を止めさせないため）
  if (state.dailyGoal > 0 && state.writtenToday >= state.dailyGoal) {
    out.push({
      key: "goalReached",
      kind: "goalReached",
      text: `おめでとうございます！　本日の文字数目標（${format(
        state.dailyGoal
      )}字）を達成しました。`,
    });
  }

  // 越えた節目のうち、いちばん大きいものだけを言う。
  // 一気に5,000字書いた人へ、1,000・3,000・5,000と3回続けて言わない
  const reached = MILESTONES.filter(
    (milestone) => state.writtenToday >= milestone
  );
  const top = reached[reached.length - 1];
  if (top !== undefined) {
    out.push({
      key: `milestone:${top}`,
      kind: "milestone",
      text: `本日の執筆文字数が${format(top)}文字を超えました！`,
    });
  }

  if (state.streak >= 3) {
    out.push({
      key: `streak:${state.streak}`,
      kind: "streak",
      text: `${state.streak}日続けて書いていますね。`,
    });
  }

  // ── 手伝いを申し出る（手が止まっているときだけ）
  if (state.idleMs < IDLE_THRESHOLD_MS) return out;

  if (state.pendingUpdates > 0) {
    out.push({
      key: "pendingUpdates",
      kind: "pendingUpdates",
      text: `承認待ちの更新が${state.pendingUpdates}件たまっています。空き時間に見ておきますか？`,
      run: { kind: "openSettingsPanel", label: "設定資料集を開く" },
    });
  }

  if (state.mergeCandidates > 0) {
    out.push({
      key: "mergeCandidates",
      kind: "mergeCandidates",
      text: `同じ人物とみられる組が${state.mergeCandidates}件あります。まとめておきましょうか？`,
      run: { kind: "unifyCharacters", label: "重複をまとめる" },
    });
  }

  if (state.unextractedEpisodes !== undefined && state.unextractedEpisodes > 0) {
    out.push({
      key: "idleExtract",
      kind: "idleExtract",
      text: `まだ設定資料に取り込んでいない話が${state.unextractedEpisodes}話あります。空き時間に資料抽出やっておきましょうか？`,
      run: { kind: "extractSettings", label: "設定資料を抽出する" },
    });
  }

  // 誤字脱字は最後。**書いた直後に言うと、粗探しをされているように読める。**
  // ここまでの申し出が無く、なお手が空いているときだけにする
  if (state.openManuscriptPath && state.writtenToday > 0) {
    out.push({
      key: "idleTypos",
      kind: "idleTypos",
      text: "書き終えたところ、誤字脱字じゃないですか？　いま開いている話だけ見ておきましょうか。",
      run: { kind: "checkTyposForFile", label: "この話の誤字脱字を見る" },
    });
  }

  return out;
}

function format(value: number): string {
  return value.toLocaleString("ja-JP");
}
