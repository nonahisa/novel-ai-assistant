import * as vscode from "vscode";
import * as path from "../core/paths";
import { isAiBusy, withAiWork } from "../core/aiActivity";
import {
  decideChatter,
  type Chatter,
  type ChatterCommentRequest,
  type ChatterState,
} from "../core/chatter";
import { validateChatterComment } from "../core/chatterCommentValidation";
import { logFailure } from "../core/logger";
import { SUPPORTED_EXTENSIONS, type WorkEntry } from "../models/types";
import { dailyGoal } from "./writingProgress";

/**
 * AIの独り言を動かす係（設計書6.21）。
 *
 * 何を言うかは `core/chatter.ts` が決める。ここは
 * **いつ様子を見に行くか**と**そもそも話しかけてよいか**を受け持つ。
 *
 * 話しかけない条件を先に挙げる。ここを緩めると、
 * ただ煩わしいだけの機能になる。
 *
 * | 条件 | 理由 |
 * |---|---|
 * | 設定が切 | 黙っていてほしい作者がいる |
 * | 有料のAI | **勝手に課金しない。** 作者に頼まれていない発言で金は使えない |
 * | AIが仕事中 | 抽出の最中に割り込むと、遅い機械では抽出そのものを遅くする |
 * | 相談パネルが閉じている | 見ていないところへ書き溜めても意味がない |
 * | 対象の作品が分からない | 誰の話をしているのか言えない |
 *
 * **通知（ポップアップ）は使わない。** 独り言は手を止めさせるものではない。
 * 相談パネルに残しておき、作者が目を向けたときに読めればよい。
 */

/** 様子を見に行く間隔。短いほど反応が良いが、そのぶん無駄に走る */
const TICK_MS = 60 * 1_000;

/**
 * 前に言ってから、次に言うまで空ける時間。
 *
 * **同じことは言わない、だけでは足りなかった。** 言えることが3つ
 * たまっている日には、1分おきに順番に喋り出す。試験で気づいた。
 * 独り言は「たまに横から一言」であって、実況ではない。
 */
export const QUIET_GAP_MS = 10 * 60 * 1_000;

/**
 * 未抽出の話数を数え直す間隔。
 *
 * **数えるには作品の走査が要る。** 1分ごとの様子見のたびに走らせると、
 * 書いている最中に無駄な読み取りが起きる。申し出が数分遅れても困らない。
 */
export const UNEXTRACTED_INTERVAL_MS = 5 * 60 * 1_000;

/**
 * 本文の感想を待つ上限（設計書6.21.4）。
 *
 * **誰も待っていない発言である。** 作者は感想を頼んでいないので、
 * 返ってこないなら諦めるのが正しい。抽出のような長い待ち時間
 * （既定180秒）をここへ持ち込むと、その間ずっとAIが埋まり、
 * 作者が自分で頼んだ処理の順番が後ろへ回る。
 */
export const COMMENT_TIMEOUT_MS = 30 * 1_000;

/**
 * 使う相手を、必要な分だけの形で受け取る。
 *
 * `WorkChatPanel` や `AIRegistry` をそのまま要求すると、
 * **「黙るべきときに黙るか」を試験で確かめられない**（WebViewが要る）。
 * ここが独り言のいちばん大事なところなので、確かめられる形にする。
 */
export interface ChatterDeps {
  /** いま選ばれているAI。有料かどうかだけ見る */
  resolveAi(): { paid: boolean } | undefined;
  /** 相談パネルが画面に出ているか */
  panelVisible(): boolean;
  /** 独り言を差し込む */
  post(chatter: Chatter, work: WorkEntry, filePath?: string): void;
  /** その日の執筆量。読めなければ undefined */
  summary(
    work: WorkEntry
  ): Promise<{ today: string; written: number; streak: number } | undefined>;
  /**
   * まだ設定資料へ取り込んでいない話の数。読めなければ undefined。
   *
   * **毎回は数えない**（走査が入る）。呼び出し側で間隔を空ける。
   */
  unextractedEpisodes(work: WorkEntry): Promise<number | undefined>;
  /** 承認待ち・重複の件数。操作メニューのバッジと同じ数 */
  counts(): { pendingUpdates: number; mergeCandidates: number };
  /**
   * 本文を読ませて、感想の一言をもらう（設計書6.21.4）。
   *
   * **呼ばれるのは「言ってよい」と決まってからだけである。** 黙る回にも
   * 呼びに行くと、様子見のたびに手元のAIを無駄に走らせる。
   *
   * 言えるものが無ければ undefined を返す。**任意にしていない**のは、
   * 配線を忘れても動いてしまう作りにすると、忘れたことに誰も
   * 気づけないためである（`GenerateMeta` で踏んだのと同じ形）。
   */
  requestComment(
    work: WorkEntry,
    manuscriptPath: string,
    signal: AbortSignal
  ): Promise<string | undefined>;
}

export class ChatterService implements vscode.Disposable {
  private timer: ReturnType<typeof setInterval> | undefined;
  /** 最後に本文を保存した時刻。「手が空いているか」の判断に使う */
  private lastEditAt = Date.now();
  /** 直近に本文を保存した作品。独り言の相手 */
  private currentWork: WorkEntry | undefined;
  /** 直近に保存した本文のパス。「この話の誤字脱字」に渡す */
  private currentPath: string | undefined;
  /**
   * その日すでに言ったこと。
   *
   * 日付ごとに持つのは、日をまたいだら言い直してよいため
   * （「本日の執筆文字数が1,000文字を超えました」は毎日言う）。
   */
  private said = new Map<string, Set<string>>();
  /** 最後に何か言った時刻。立て続けに喋らないための間合い */
  private lastSpokeAt = 0;

  constructor(private readonly deps: ChatterDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * 本文が保存されたときに呼ぶ。
   *
   * 保存を「手を動かした」印として使う。入力そのものを見張ると、
   * 1文字打つたびに時刻を書き換えることになり、そのために
   * 全ファイルの変更を購読することになる。
   */
  noteEdit(work: WorkEntry, filePath: string): void {
    const ext = path.extname(filePath).toLowerCase();
    if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) return;
    this.lastEditAt = Date.now();
    this.currentWork = work;
    this.currentPath = filePath;
  }

  private enabled(): boolean {
    return vscode.workspace
      .getConfiguration("novelai")
      .get<boolean>("chatter.enabled", true);
  }

  /**
   * 話しかけてよいかを見る。
   *
   * **理由は返さない。** 黙るべきときに「なぜ黙ったか」を出すと、
   * それ自体が独り言と同じだけうるさい。
   */
  private allowed(): boolean {
    if (!this.enabled()) return false;
    if (!this.currentWork) return false;
    if (isAiBusy()) return false;
    // 前に言ってから間もないなら、言えることがあっても黙る
    if (Date.now() - this.lastSpokeAt < QUIET_GAP_MS) return false;

    // 有料のAIでは動かさない。**頼まれていない発言で課金しない。**
    // 無料の手元AI（Ollama・LM Studioなど）なら動く。AIが未設定なら出ない
    const resolved = this.deps.resolveAi();
    if (!resolved || resolved.paid) return false;

    return this.deps.panelVisible();
  }

  /** 一度だけ様子を見る。試験から直接呼ぶ */
  async tick(): Promise<void> {
    if (!this.allowed()) return;
    const work = this.currentWork;
    if (!work) return;

    try {
      const state = await this.snapshot(work);
      const decision = decideChatter(state);
      if (!decision) return;

      // **取りに行く前に「言った」ことにする。** 感想の道は失敗しうるが、
      // 失敗のたびに数えないと、繋がらないAIへ様子見のたびに聞き直す
      const already = this.said.get(state.saidKey) ?? new Set<string>();
      already.add(decision.key);
      this.said.set(state.saidKey, already);

      if (decision.kind === "commentRequest") {
        await this.speakComment(decision, work);
        return;
      }

      this.lastSpokeAt = Date.now();
      this.deps.post(decision, work, this.currentPath);
    } catch (error) {
      // 独り言のために執筆を止めない。黙って諦め、ログにだけ残す
      logFailure("独り言", {
        作品: work.title,
        詳細: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 本文を読ませて、感想を1つ出す（設計書6.21.4）。
   *
   * **失敗は画面に出さない。** 読めない答え・繋がらない・時間切れ、
   * どれも黙ってログへ落とす。頼まれてもいない発言の失敗を知らせるのは、
   * 独り言のいちばん邪魔な出方である。
   *
   * 言えなかったときは `lastSpokeAt` を動かさない。**何も言っていない**
   * のだから、次の様子見で祝いや申し出が出るのを止める理由が無い。
   */
  private async speakComment(
    request: ChatterCommentRequest,
    work: WorkEntry
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COMMENT_TIMEOUT_MS);
    try {
      // **自分の呼び出しの間も「AIが仕事中」にする。** そうしないと、
      // 次の様子見が空いていると勘違いして、重ねて呼びに行く
      const raw = await withAiWork(() =>
        this.deps.requestComment(
          work,
          request.manuscriptPath,
          controller.signal
        )
      );
      const comment = raw ? validateChatterComment(raw) : undefined;
      if (!comment) {
        // **黙るのはよいが、何も残さないのはよくない**（設計書6.21.4の
        // 「黙る（ログのみ）」の「ログ」。0.32.6のレビュー）。検査で落ちた
        // 一言がどこにも無いと、「AIが黙っている」のか「言おうとしたが
        // 落ちた」のかを、作者も開発側も区別できない。
        // **答えが返らなかった回（undefined）は残さない**——見送る中身が無い
        if (raw) {
          logFailure("独り言の感想（検査で見送りました）", {
            作品: work.title,
            答え: raw.slice(0, 200),
          });
        }
        return;
      }

      this.lastSpokeAt = Date.now();
      this.deps.post(
        { key: request.key, kind: "manuscriptComment", text: comment },
        work,
        this.currentPath
      );
    } catch (error) {
      logFailure("独り言の感想（黙って諦めました）", {
        作品: work.title,
        詳細: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 未抽出の話数。**間隔を空けて数える。**
   *
   * 数えるには作品を走査してファイルの時刻を引く。独り言は1分ごとに
   * 様子を見に来るので、毎回やると書いている最中に無駄な読み取りが走る。
   */
  private async unextractedCached(
    work: WorkEntry
  ): Promise<number | undefined> {
    const cached = this.unextracted.get(work.id);
    if (cached && Date.now() - cached.at < UNEXTRACTED_INTERVAL_MS) {
      return cached.count;
    }
    const count = await this.deps.unextractedEpisodes(work);
    this.unextracted.set(work.id, { at: Date.now(), count });
    return count;
  }

  private readonly unextracted = new Map<
    string,
    { at: number; count: number | undefined }
  >();

  private async snapshot(
    work: WorkEntry
  ): Promise<ChatterState & { saidKey: string }> {
    const summary = await this.deps.summary(work);
    // 日付の区切りは執筆量と揃える（午前4時など、作者の設定に従う）
    const saidKey = `${work.id}:${summary?.today ?? "unknown"}`;
    const counts = this.deps.counts();

    return {
      saidKey,
      writtenToday: summary?.written ?? 0,
      dailyGoal: dailyGoal(),
      streak: summary?.streak ?? 0,
      pendingUpdates: counts.pendingUpdates,
      mergeCandidates: counts.mergeCandidates,
      idleMs: Date.now() - this.lastEditAt,
      // **分からないものは undefined のまま渡す。**
      // 0を渡すと「抽出済み」と言い切ることになる（設計書6.21.1）
      unextractedEpisodes: await this.unextractedCached(work),
      openManuscriptPath: this.currentPath,
      saidToday: this.said.get(saidKey) ?? new Set<string>(),
    };
  }
}
