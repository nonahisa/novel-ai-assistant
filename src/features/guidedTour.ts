// ログの書き先：作品が定まらない——案内するのは画面の道順で、作品を
// 選ぶ前（「書いてある作品を登録して整える」の1段目）から始まりうる
import * as vscode from "vscode";
import {
  currentStep,
  describeStep,
  describeTourEnd,
  observeCommand,
  startTourByKey,
  type TourState,
} from "../core/guidedTour";
import { logStep } from "../core/logger";
import { procedureActionLookup } from "./featureGuide";
import {
  describeSpotlight,
  type ActionSpotlight,
  type SpotlightResult,
} from "./actionSpotlight";

/**
 * 画面で指しながら案内する——VS Code 側（設計書6.104。第1段）。
 *
 * ## 判断はここに書かない
 *
 * 「いまどの段か」「押されたら進むのか」は `core/guidedTour.ts` にある。
 * ここがやるのは3つだけ——**サイドバーを光らせる・相談パネルへ札を出す・
 * 頼まれたらコマンドを起こす**。第3段で MCP から同じ案内を起こすときに、
 * 判断まで書き直さずに済むようにするためである。
 *
 * ## 既定は「作者が押すのを待つ」（作者の裁定、2026-09-21）
 *
 * 押してしまうと「やってもらった」になり、次に自分でできない。
 * ただし札の中に「**代わりに押して**」を置く。覚えたい人と急ぐ人の両方に
 * 合わせるためで、**どちらを選んでも次の段へは同じように進む**
 * ——どちらの道もコマンドの実行を通り、その実行を `notifyCommand` が
 * 拾うからである（進み方を2通り持たない）。
 *
 * ## 押されたことは、コマンド登録の包みから届く
 *
 * `extension.ts` の `registerCommand` が唯一の登録口なので、そこへ
 * 相乗りしている（**成功して返ったときだけ**知らせる。前提の関門で
 * 止まった回や、例外で落ちた回まで進めると、やっていない段が済む）。
 */

/** 案内の札を出す先。**相談パネルの中に出す**（専用のパネルは作らない） */
export interface TourScreen {
  /** 札を出す先を用意する（閉じていれば開く）。用意できたか */
  ensureVisible(): Promise<boolean>;
  /** 開いているすべての画面へ送る */
  post(message: unknown): void;
}

export class GuidedTourHost {
  /** いま案内しているもの。**無いときは何もしない**（寝ている） */
  private state: TourState | undefined;

  /**
   * 光らせる先。**起動の途中でしか渡せない**ので、あとから差す。
   *
   * ツリーは相談パネルより先に作られるが、パネルのほうが先に
   * 組み立てられる場面もあるので、渡っていなくても案内は始められる
   * （文だけの案内になる）。
   */
  private spotlight: ActionSpotlight | undefined;

  constructor(private readonly screen: TourScreen) {}

  setSpotlight(spotlight: ActionSpotlight): void {
    this.spotlight = spotlight;
  }

  /** 案内の最中か（画面の札を出し分けるのに使う） */
  isActive(): boolean {
    return this.state !== undefined;
  }

  /**
   * 手順書きの鍵で案内を始める。
   *
   * **すでに案内していても、新しいほうへ乗り換える。** 途中で別の相談を
   * したのだから、古い案内を抱えたままにすると、どちらの札に従えばよいか
   * 分からなくなる（やめたことは画面に出す）。
   */
  async start(key: string): Promise<void> {
    if (this.state) this.end("stopped");

    const state = startTourByKey(key, procedureActionLookup);
    if (!state) {
      // **黙って戻らない。** 押したのに何も起きない画面がいちばん困る
      this.screen.post({
        type: "tourEnded",
        message:
          "この手順は、いまの環境では案内できませんでした（押す場所が画面にありません）。",
      });
      return;
    }

    this.state = state;
    logStep(`画面案内: 開始 ${state.title}（${state.steps.length}段）`);
    await this.showCurrent();
  }

  /** 作者が「やめる」を押した */
  stop(): void {
    if (!this.state) return;
    this.end("stopped");
  }

  /**
   * 「代わりに押して」。
   *
   * **進め方は変えない。** ここでもコマンドを起こすだけで、進むのは
   * `notifyCommand` が実行を拾ったときである。
   */
  async runCurrent(): Promise<void> {
    const state = this.state;
    const step = state ? currentStep(state) : undefined;
    if (!state || !step) return;

    try {
      /*
        **引数を渡さない。** 詳細メニューから押したときと同じ形にする
        ——作品が要る操作なら、コマンド登録の包み（`guardPrerequisites`）が
        作品を訊いてくれる。ここで作品を決めて渡すと、案内から押したときだけ
        対象の決まり方が違う、という追いにくい食い違いができる。
      */
      await vscode.commands.executeCommand(step.command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.screen.post({
        type: "tourNote",
        message: `「${step.label}」を起こせませんでした（${message}）。ご自分で押してみてください。`,
      });
    }
  }

  /**
   * 操作が実行された。**案内していないときは何もしない。**
   *
   * すべてのコマンドがここを通るので、軽いままにしておく
   * （案内していない間は最初の1行で戻る）。
   */
  notifyCommand(command: string): void {
    const state = this.state;
    if (!state) return;

    const observed = observeCommand(state, command);
    this.state = observed.state;
    if (observed.kind === "ignored") return;
    if (observed.kind === "finished") {
      this.end("finished");
      return;
    }
    void this.showCurrent();
  }

  /** いまの段を、光らせて札に出す */
  private async showCurrent(): Promise<void> {
    const state = this.state;
    const view = state ? describeStep(state) : undefined;
    if (!state || !view) return;

    // **先に光らせる。** 札を出してから光らせると、読んでいる間に
    // サイドバーが動いて、どの行が光ったのか目で追えない
    const result: SpotlightResult = this.spotlight
      ? await this.spotlight.show(view.command)
      : { shown: false };

    // 案内の途中で画面が閉じられていることがある。閉じたまま送っても
    // 届かないので、ここで開き直す
    await this.screen.ensureVisible();
    this.screen.post({
      type: "tourStep",
      step: view,
      where: describeSpotlight(result),
    });
  }

  /** 案内を畳む。**終わり方にかかわらず、ここ1か所を通す** */
  private end(reason: "finished" | "stopped"): void {
    const state = this.state;
    if (!state) return;
    this.state = undefined;
    const message = describeTourEnd(state, reason);
    logStep(`画面案内: ${message}（寄り道 ${state.strayCount}回）`);
    this.screen.post({ type: "tourEnded", message });
  }
}
