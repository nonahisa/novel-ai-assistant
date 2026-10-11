/**
 * はじめの案内の流れ（設計書6.90.7）。
 *
 * 画面（QuickPick・知らせ）から切り離してある。**何がどの順で出るか**を
 * VS Code なしで見張るため（`test/unit/core/tutorialFlow.test.ts`）。
 *
 * ## 2026-10-10 の永久ループ
 *
 * 作者の報告：「続きを書く」→「執筆を再開」→作品を選ぶ→また一覧→……が終わらない。
 * 原因は2つ重なっていた。
 *
 * 1. 段のコマンドを引数なしで呼んでいたので、**押すたびに作品を選ばされた**
 * 2. 段が終わると**すぐ一覧を出し直していた**。一覧は焦点を外しても閉じない
 *    作りなので、段が開いた紙（執筆再開の紙は毎回できていた）の前に出て、
 *    作者には「作品を選ぶ→一覧に戻る」の繰り返しにしか見えなかった
 *
 * そこで、作品は案内の中で一度だけ決め、段のあとは右下の知らせで
 * ［はじめの案内に戻る］を押したときだけ一覧へ戻す。作品の選択を
 * 取りやめたら案内そのものを終える（黙って一覧へ戻すと、また同じ輪に入る）。
 */
import { isCancelledOutcome } from "./proofreadingSuite";
import type { TutorialStepInput, TutorialStepMark } from "./tutorialStepList";

/**
 * 作品を引数（`{ type: "work", work }`）で受けるコマンド。
 *
 * **ここに無いコマンドへは何も渡さない。** 作品の追加・縦書き（開いている
 * 原稿を見る）・相談・投稿用コピー・ルビ取込・モード切替は、作品を受けない。
 * `extension.ts` の登録と食い違わないことは `tutorialWorkCommands.test.ts` が
 * 見張る（段を足したときに、ここへ書き忘れると作品をまた選ばされる）。
 */
export const TUTORIAL_WORK_COMMANDS: ReadonlySet<string> = new Set([
  "novelai.checkDeviations",
  "novelai.checkTypos",
  "novelai.configurePostingSites",
  "novelai.createEpisodePlot",
  "novelai.exportPdf",
  "novelai.extractSettings",
  "novelai.generateAnnouncement",
  "novelai.generatePlot",
  "novelai.openEpubEditor",
  "novelai.openSceneMemos",
  "novelai.readManuscriptAloud",
  "novelai.resumeWriting",
  "novelai.reviewProposals",
  "novelai.runProofreadingSuite",
]);

export function stepNeedsWork(command: string): boolean {
  return TUTORIAL_WORK_COMMANDS.has(command);
}

/** 目的1つ分。画面側は、紙を開くのに要るものを足して渡してよい */
export interface TutorialFlowGoal {
  label: string;
  steps: readonly TutorialStepInput[];
}

export type TutorialStepChoice =
  | { step: TutorialStepInput; action: "open" | "skip" }
  | "back"
  | undefined;

/** 段のあとの知らせで押されたもの。閉じた（undefined）ときも終える */
export type TutorialAfterStep = "back" | "finish" | undefined;

export interface TutorialFlowPorts<G extends TutorialFlowGoal, W> {
  askGoal(): Promise<G | undefined>;
  /** 助言の紙を開く。**焦点は奪わない**（一覧と並べて読ませるため） */
  openGuide(goal: G): Promise<void>;
  hasWork(): boolean;
  /** 作品を決める。1つなら黙って返し、取りやめたら undefined */
  pickWork(): Promise<W | undefined>;
  askStep(
    goal: G,
    marks: ReadonlyMap<string, TutorialStepMark>
  ): Promise<TutorialStepChoice>;
  /** 段のコマンドを走らせる。`work` は作品を受けるコマンドのときだけ入る */
  runStep(step: TutorialStepInput, work: W | undefined): Promise<unknown>;
  notifyOpened(step: TutorialStepInput): Promise<TutorialAfterStep>;
  /**
   * 作品が1つも無いのに、作品を受ける段が押されたときの知らせ。
   * 作品の登録へ案内する。［はじめの案内に戻る］なら "back"、閉じたら終える
   */
  notifyNeedsWork(step: TutorialStepInput): Promise<TutorialAfterStep>;
  log(line: string): void;
}

export async function runTutorialFlow<G extends TutorialFlowGoal, W>(
  ports: TutorialFlowPorts<G, W>
): Promise<void> {
  // 印は案内を開いている間だけ持つ（保存しない）。目的を選び直しても残す
  const marks = new Map<string, TutorialStepMark>();
  // **作品は案内1回につき一度だけ決める。** 目的を選び直しても訊き直さない
  let work: W | undefined;

  for (;;) {
    const goal = await ports.askGoal();
    if (!goal) return;

    if (
      work === undefined &&
      ports.hasWork() &&
      goal.steps.some((step) => stepNeedsWork(step.command))
    ) {
      work = await ports.pickWork();
      // 取りやめたら案内を終える。一覧へ黙って戻すと、次に段を押したとき
      // また作品を訊かれ、同じ輪に入る（2026-10-10 の永久ループの入口）
      if (work === undefined) return;
    }

    // **紙を先に開く。** 操作の一覧より前に、なぜそれを勧めるのかを読ませる
    await ports.openGuide(goal);

    for (;;) {
      const picked = await ports.askStep(goal, marks);
      if (picked === "back") break;
      if (!picked) return;

      if (picked.action === "skip") {
        ports.log(`はじめの案内：${goal.label} → ${picked.step.label}（飛ばした）`);
        marks.set(picked.step.command, "skipped");
        continue;
      }

      const needsWork = stepNeedsWork(picked.step.command);
      if (needsWork && work === undefined) {
        if (!ports.hasWork()) {
          /*
            **作品が無いまま段を動かさない**（2026-10-11 作者の指示）。
            動かすと機能の側が「作品が登録されていません。」とだけ出し、
            何も開いていないのに案内は「開きました」と知らせていた。
            作者はそこで何をすればよいか分からなくなるので、登録へ案内する。
            印は付けない（開いていない）
          */
          ports.log(
            `はじめの案内：${goal.label} → ${picked.step.label}（作品が無いので登録へ案内）`
          );
          const next = await ports.notifyNeedsWork(picked.step);
          if (next !== "back") return;
          continue;
        }
        /*
          案内の途中で作品が登録された（作品の追加の段を開いた等）。目的を
          選んだ時点では作品が無かったので、ここで一度だけ決める
        */
        work = await ports.pickWork();
        if (work === undefined) return;
      }

      ports.log(`はじめの案内：${goal.label} → ${picked.step.label}`);
      const result = await ports.runStep(
        picked.step,
        needsWork ? work : undefined
      );
      /*
        段の中で取りやめた（確認で断った等）なら、開いたとは言わない。
        作者は自分で止めたので、一覧へ戻して次を選べるようにする
      */
      if (isCancelledOutcome(result)) continue;

      // 「済んだ」とは書かない。開いただけで、やり終えたとは限らない
      marks.set(picked.step.command, "opened");
      /*
        **一覧をすぐ出し直さない。** 段が開いた紙や画面を読ませるため、
        右下の知らせで［はじめの案内に戻る］を押したときだけ戻る
      */
      const after = await ports.notifyOpened(picked.step);
      if (after !== "back") return;
    }
  }
}

/** 案内1回ぶんの印。新しい案内が始まると `superseded` になる */
export interface TutorialNoticeSession {
  readonly superseded: boolean;
  /**
   * 知らせの答えを待つ。**新しい案内が始まったら、答えを待たずに
   * undefined（閉じた）を返す。** 始まったあとで古い知らせが押されても、
   * 押されたものは捨てる（古い一覧へ戻さない）
   */
  wait<T>(pending: PromiseLike<T>): Promise<T | undefined>;
}

/**
 * はじめの案内を、拡張機能の中で1つだけ動かすための門。
 *
 * ## 2026-10-11 の「古い知らせが残る」
 *
 * 段のあとの知らせ（［はじめの案内に戻る］［終える］）は、しばらくすると
 * 右下から消えて通知センター（ベル）へ移る。**押されるまで案内は待ったまま**
 * なので、作者が終わったと思ってヘルプから案内をもう一度始めると、古い知らせが
 * 新しい案内と並んで残り、押すと古い一覧まで戻ってきた。
 *
 * VS Code には出した知らせを外から閉じる手段が無い。できるのは、**新しい案内を
 * 始めた時点で古い案内の待ちを解いて終わらせ、古い知らせが押されても何も
 * 起こさない**ことである。知らせの箱そのものはベルに残る。
 */
export class TutorialNoticeGate {
  private current: { supersede(): void } | undefined;

  begin(): TutorialNoticeSession {
    this.current?.supersede();
    let superseded = false;
    const waiters = new Set<() => void>();
    this.current = {
      supersede: () => {
        superseded = true;
        for (const wake of waiters) wake();
        waiters.clear();
      },
    };
    return {
      get superseded() {
        return superseded;
      },
      wait: <T>(pending: PromiseLike<T>): Promise<T | undefined> => {
        if (superseded) return Promise.resolve(undefined);
        return new Promise<T | undefined>((resolve, reject) => {
          const wake = (): void => resolve(undefined);
          waiters.add(wake);
          pending.then(
            (value) => {
              waiters.delete(wake);
              // 待ちが解けたあとで押された古い知らせは、捨てる
              resolve(superseded ? undefined : value);
            },
            (error: unknown) => {
              waiters.delete(wake);
              reject(error);
            }
          );
        });
      },
    };
  }
}
