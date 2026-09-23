import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { PROCEDURE_REFERENCED_COMMANDS } from "../../../src/core/procedures";
import { announceCommandFinished } from "../../../src/core/guidedTour";
import {
  CHECK_CANCELLED,
  CHECK_COMPLETED,
  CHECK_FAILED,
  checkSkipped,
} from "../../../src/core/proofreadingSuite";
import {
  GuidedTourHost,
  type TourScreen,
} from "../../../src/features/guidedTour";
import {
  ActionListProvider,
  type ActionNode,
  type GroupStateStore,
} from "../../../src/views/actionList";
import { StepMenuProvider, type StepNode } from "../../../src/views/stepMenu";
import {
  describeSpotlight,
  type ActionSpotlight,
  type SpotlightResult,
} from "../../../src/features/actionSpotlight";
import type { WorkEntry } from "../../../src/models/types";
import type { WorkRegistry } from "../../../src/core/workRegistry";

/**
 * 画面で指しながらの案内——**繋ぎ目**（設計書6.104。第1段）。
 *
 * 判断そのものは `guidedTour.test.ts` で見る。ここで守るのは、
 * 判断が画面へ届くまでの道である。
 *
 * 1. 手順書きが指すすべての操作を、**どちらかのツリーで引ける**
 *    （引けないと、押す場所を光らせられない）
 * 2. `TreeView.reveal()` に要る**親をたどれる**
 * 3. 押されたことを拾う口が、**成功して返ったときだけ**呼ばれる
 * 4. 相談パネルの画面に、案内の札のやり取りが**揃っている**
 */

const work: WorkEntry = {
  id: "w1",
  title: "ためし",
  folderPath: "C:/works/w1",
  registeredAt: "2026-09-21T00:00:00.000Z",
};

function fakeRegistry(): WorkRegistry {
  return {
    list: () => [work],
    onDidChange: () => ({ dispose() {} }),
  } as unknown as WorkRegistry;
}

const noStore: GroupStateStore = { get: () => [], set: () => undefined };

function providers(): {
  actions: ActionListProvider;
  steps: StepMenuProvider;
} {
  return {
    actions: new ActionListProvider(fakeRegistry(), noStore),
    steps: new StepMenuProvider(
      fakeRegistry(),
      { get: () => work.id, set: () => undefined },
      noStore
    ),
  };
}

describe("押す場所を引けること", () => {
  test("手順書きの全段が、どちらかのツリーで見つかる", () => {
    const { actions, steps } = providers();
    const missing = [...new Set(PROCEDURE_REFERENCED_COMMANDS)].filter(
      (command) =>
        !steps.findActionNode(command) && !actions.findActionNode(command)
    );
    expect(missing, "光らせる場所が画面に無い操作").toEqual([]);
  });

  test("知らないコマンドは引けない（黙って当てない）", () => {
    const { actions, steps } = providers();
    expect(steps.findActionNode("novelai.存在しない操作")).toBeUndefined();
    expect(actions.findActionNode("novelai.存在しない操作")).toBeUndefined();
  });

  test("簡単ステップメニューに無い操作は、詳細メニューのほうで引ける", () => {
    /*
      片方のメニューにしか無い操作がある（設計書6.104）。片方に無いことを
      知らずに片方だけ探すと、**光らせる場所が無いまま案内が進む**——作者から
      見ると「案内しますと言ったのに、どこも光らない」になる。

      以前は「新話を投稿」がその例だったが、2026-09-23 に簡単ステップ
      メニューの「5. 投稿脱稿」へ入った（作者の裁定 問14 A）。いまの例は
      「ランキング記録」（詳細メニューの「投稿・出力」にだけある）。

      上の総当たりは「どちらかで引ける」しか見ていないので、**どちらで
      引けるのか**をここで名指しにしておく。
    */
    const { actions, steps } = providers();
    expect(
      steps.findActionNode("novelai.recordRanking"),
      "簡単ステップメニューに入った（この前提が変わった）"
    ).toBeUndefined();
    expect(
      actions.findActionNode("novelai.recordRanking"),
      "詳細メニューからも引けない（案内が行き止まる）"
    ).toBeDefined();
    // 新話投稿は、いまは両方で引ける
    expect(steps.findActionNode("novelai.postNewEpisode")).toBeDefined();
    expect(actions.findActionNode("novelai.postNewEpisode")).toBeDefined();
  });
});

describe("親をたどれること（reveal の前提）", () => {
  test("詳細メニュー：操作 → 小分類か分類 → 最上位", () => {
    const { actions } = providers();
    for (const command of new Set(PROCEDURE_REFERENCED_COMMANDS)) {
      const node = actions.findActionNode(command);
      if (!node) continue;
      // 最上位（分類）へ着くまでたどれること。無限に回らないよう上限を置く
      let cursor: ActionNode | undefined = node;
      let hops = 0;
      while (cursor && cursor.type !== "group" && hops < 5) {
        cursor = actions.getParent(cursor);
        hops += 1;
      }
      expect(cursor?.type, `${command} の親をたどれない`).toBe("group");
    }
    // 最上位の親は無い
    const top = actions.getChildren()[0];
    expect(actions.getParent(top)).toBeUndefined();
  });

  test("簡単ステップメニュー：操作 → 小分類か段階 → 最上位", () => {
    const { steps } = providers();
    for (const command of new Set(PROCEDURE_REFERENCED_COMMANDS)) {
      const node = steps.findActionNode(command);
      if (!node) continue;
      let cursor: StepNode | undefined = node;
      let hops = 0;
      while (cursor && cursor.type !== "step" && hops < 5) {
        cursor = steps.getParent(cursor);
        hops += 1;
      }
      expect(cursor?.type, `${command} の親をたどれない`).toBe("step");
    }
    // 最上段の作品選択に親は無い
    expect(steps.getParent({ type: "selector" })).toBeUndefined();
  });
});

describe("光らせた場所の言い方", () => {
  test("見つからなかったことを隠さない", () => {
    // **光ったことにして案内を続けない。** 画面のどこにも無いものを
    // 探させることになる
    expect(describeSpotlight({ shown: false })).toContain("見当たりません");
    expect(describeSpotlight({ shown: true, view: "steps" })).toContain(
      "簡単ステップメニュー"
    );
    expect(describeSpotlight({ shown: true, view: "actions" })).toContain(
      "詳細メニュー"
    );
  });
});

/**
 * `extension.ts` の `activate` は単体では動かせないので、
 * **書いてあるコードの形**で見る（`chatRunEntry.test.ts` と同じやり方）。
 */
describe("押されたことを拾う口", () => {
  const source = readFileSync("src/extension.ts", "utf8");

  test("コマンド登録の包みの中で、callback を待ち、戻り値ごと渡している", () => {
    const start = source.indexOf(
      "const registerCommand: typeof vscode.commands.registerCommand"
    );
    expect(start, "登録の包みが見つからない").toBeGreaterThan(-1);
    const body = source.slice(start, start + 2_500);

    const awaited = body.indexOf("const returned = await callback.apply(");
    const notified = body.indexOf(
      "announceCommandFinished(command, returned, onCommandFinished,"
    );
    expect(awaited, "callback の呼び出しが見つからない").toBeGreaterThan(-1);
    // **戻り値を渡していること。** 渡さずに知らせると、取りやめた回まで
    // 「済んだ」ことになる（2026-09-21に直した粗さ）。判断そのものは
    // 下の「取りやめたら進まない」で実際に呼んで測る
    expect(notified, "戻り値を渡して知らせていない").toBeGreaterThan(-1);
    // **成功して返ったあと**であること。前で呼ぶと、前提の関門で
    // 止まった回まで「済んだ」ことになる
    expect(notified).toBeGreaterThan(awaited);
    // 判断を包みの中へ書き戻していないこと（`activate` は単体で測れない）
    expect(body).not.toContain("onCommandFinished?.(command)");
    // 戻り値はそのまま返す（案内のために操作の結果を変えない）
    expect(body).toContain("return returned;");
  });

  test("相談パネルへ繋いであり、光らせる先も渡してある", () => {
    expect(source).toContain(
      "onCommandFinished = (command) => workChatPanel.notifyCommandRun(command)"
    );
    expect(source).toContain("workChatPanel.setTourSpotlight(");
    // 3つのツリーのうち、押す場所になる2つを渡している
    expect(source).toContain("createActionSpotlight({");
  });
});

describe("相談パネルの画面", () => {
  const html = readFileSync("src/views/workChatPanelHtml.ts", "utf8");

  test("案内の札の、出す口と押す口が揃っている", () => {
    // 拡張機能 → 画面
    for (const kind of ["tourStep", "tourEnded", "tourNote"]) {
      expect(html, `${kind} を受け取っていない`).toContain(
        `message.type === '${kind}'`
      );
    }
    // 画面 → 拡張機能
    for (const kind of ["startTour", "tourRun", "tourAgain", "tourStop"]) {
      expect(html, `${kind} を送っていない`).toContain(`type: '${kind}'`);
    }
  });

  test("1段につき出すものが揃っている", () => {
    // いま何番目か・何をするか・次に何を見るか・代わりに押して・
    // もう一度光らせる・やめる
    expect(html).toContain("step.position");
    expect(html).toContain("step.label");
    expect(html).toContain("step.why");
    expect(html).toContain("step.check");
    expect(html).toContain("代わりに押して");
    // 光らせても目立たなかった（作者の報告、2026-09-22）。
    // **何度でも呼べる道**が札に無いと、見失ったら終わりになる
    expect(html, "「もう一度光らせる」の札が無い").toContain(
      "もう一度光らせる"
    );
    expect(html).toContain("やめる");
  });

  test("相談パネルが「もう一度光らせる」を受けている", () => {
    const panel = readFileSync("src/features/workChatPanel.ts", "utf8");
    expect(panel).toContain('message.type === "tourAgain"');
    expect(panel).toContain("this.tour.showAgain()");
  });
});

/**
 * **ここから下は、書き方ではなく実際に呼んで確かめる**（2026-09-21）。
 *
 * 上の「押されたことを拾う口」は `extension.ts` の**書き方**しか見ていない。
 * 書き方が合っていても、**取りやめた回まで「済んだ」と数えていれば案内は
 * 進んでしまう**——実際にそうなっていた（設計書6.104 の粗さ）。
 *
 * そこで、包みが通す判断（`announceCommandFinished`）へ**本物の案内**
 * （`GuidedTourHost` と実在の手順書き）を繋いで、段が動くか動かないかを見る。
 */

/** 相談パネルの代わり。**送られたものを溜めるだけ** */
class FakeScreen implements TourScreen {
  readonly posts: TourMessage[] = [];
  async ensureVisible(): Promise<boolean> {
    return true;
  }
  post(message: unknown): void {
    this.posts.push(message as TourMessage);
  }
  /** いま出ている札（最後に出した段） */
  get step(): TourStepMessage {
    const steps = this.posts.filter(
      (post): post is TourStepMessage => post.type === "tourStep"
    );
    const last = steps[steps.length - 1];
    expect(last, "案内の札が一度も出ていない").toBeDefined();
    return last;
  }
  get ended(): TourMessage | undefined {
    return this.posts.find((post) => post.type === "tourEnded");
  }
}

interface TourMessage {
  readonly type: string;
  readonly message?: string;
}

interface TourStepMessage extends TourMessage {
  readonly step: { readonly command: string; readonly number: number };
}

/**
 * 札が出るのを待つ。`notifyCommand` は中で非同期に組み立てるので、
 * すぐ見に行くと前の札しか見えない
 */
const settle = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * **製品と同じ道で知らせる。** 包みがやっていること（戻り値を見て、
 * 数えてよければ知らせる）をここで作り直さない——作り直すと、
 * また「テストの中だけ正しい」ことになる。
 *
 * 知らせる側が投げたら、ここでは**そのまま外へ出す**（製品は記録して
 * 握る）。テストの中で黙って消えると、壊れたことに気づけない
 */
function finished(
  host: GuidedTourHost,
  command: string,
  returned: unknown
): void {
  announceCommandFinished(
    command,
    returned,
    (done) => host.notifyCommand(done),
    (error) => {
      throw error;
    }
  );
}

/**
 * 実在の手順書き「矛盾を洗う」で案内を始める。
 *
 * **この手順を選んだ理由**は、4段のうち3段が検知系で、
 * **本当に `CHECK_CANCELLED` を返す操作**（矛盾検知・プロット逸脱）が
 * 入っているからである。作り物の戻り値だけで測ると、製品では起きない
 * 形を確かめたことになる。
 */
async function startedTour(): Promise<{
  screen: FakeScreen;
  host: GuidedTourHost;
}> {
  const screen = new FakeScreen();
  const host = new GuidedTourHost(screen);
  await host.start("consistency");
  return { screen, host };
}

/** 1段進めて、検知系（取りやめを返せる段）まで持っていく */
async function advanced(): Promise<{
  screen: FakeScreen;
  host: GuidedTourHost;
}> {
  const started = await startedTour();
  finished(started.host, started.screen.step.step.command, undefined);
  await settle();
  expect(
    started.screen.step.step.command,
    "2段目が検知系でなくなった（この試験の前提が変わった）"
  ).toBe("novelai.checkContradictions");
  return started;
}

describe("取りやめたら進まない（実際に呼ぶ）", () => {
  test("取りやめを返した回は、段が動かない", async () => {
    const { screen, host } = await advanced();
    const now = screen.step.step;

    finished(host, now.command, CHECK_CANCELLED);
    await settle();

    expect(screen.step.step.number, "取りやめたのに進んだ").toBe(now.number);
    expect(screen.step.step.command).toBe(now.command);
    expect(screen.ended, "取りやめで案内が畳まれた").toBeUndefined();
  });

  test("済んだ回は、次の段へ進む", async () => {
    const { screen, host } = await advanced();
    const now = screen.step.step;

    finished(host, now.command, CHECK_COMPLETED);
    await settle();

    expect(screen.step.step.number).toBe(now.number + 1);
    expect(screen.step.step.command).not.toBe(now.command);
  });

  test("取りやめても、押し直せばそこから進む（戻る道が残っている）", async () => {
    const { screen, host } = await advanced();
    const now = screen.step.step;

    finished(host, now.command, CHECK_CANCELLED);
    await settle();
    finished(host, now.command, CHECK_COMPLETED);
    await settle();

    expect(screen.step.step.number).toBe(now.number + 1);
  });

  test("取りやめ続けるかぎり、案内はその段に留まる", async () => {
    const { screen, host } = await advanced();
    const now = screen.step.step;

    for (let i = 0; i < 5; i++) {
      finished(host, screen.step.step.command, CHECK_CANCELLED);
      await settle();
    }

    expect(screen.step.step.number).toBe(now.number);
    expect(screen.ended).toBeUndefined();
  });

  test("順に済ませれば最後まで進んで終わる", async () => {
    const { screen, host } = await startedTour();

    for (let i = 0; i < 12 && !screen.ended; i++) {
      finished(host, screen.step.step.command, CHECK_COMPLETED);
      await settle();
    }

    expect(screen.ended?.message, "最後まで進んでも終わらない").toContain(
      "案内が終わりました"
    );
  });

  test("先の段を取りやめても、飛ばして進まない", async () => {
    // 「先の段を押したら飛ばして進む」は案内の決まり（6.104）。
    // **取りやめた回は、その飛び越しも起こさない**
    const { screen, host } = await startedTour();
    const first = screen.step.step;

    finished(host, "novelai.checkDeviations", CHECK_CANCELLED);
    await settle();

    expect(screen.step.step.number).toBe(first.number);
  });
});

describe("案内に関係のないところへ影響を出さない", () => {
  const noop = (): void => undefined;

  test("案内していなければ、何を返しても何も起きない", () => {
    // 知らせる相手がいない（案内が寝ている）ときに投げないこと。
    // 包みは80か所すべてのコマンドが通る道である
    expect(() =>
      announceCommandFinished(
        "novelai.addWork",
        CHECK_CANCELLED,
        undefined,
        noop
      )
    ).not.toThrow();
    expect(() =>
      announceCommandFinished("novelai.addWork", undefined, undefined, noop)
    ).not.toThrow();
  });

  test("知らせる側が投げても、操作のほうへ出さない", () => {
    const seen: unknown[] = [];
    expect(() =>
      announceCommandFinished(
        "novelai.addWork",
        undefined,
        () => {
          throw new Error("札を出せない");
        },
        (error) => void seen.push(error)
      )
    ).not.toThrow();
    expect(seen, "投げたことが記録されていない").toHaveLength(1);
  });

  test("戻り値を持たない操作は、これまでどおり済んだものとして数える", () => {
    // 80か所のうち大半は何も返さない。ここを「分からないから進めない」に
    // すると、**案内がどこにも進まなくなる**
    const done: string[] = [];
    const notify = (command: string): void => void done.push(command);
    announceCommandFinished("a", undefined, notify, noop);
    announceCommandFinished("b", null, notify, noop);
    announceCommandFinished("c", { id: "w1" }, notify, noop);
    expect(done).toEqual(["a", "b", "c"]);
  });

  test("失敗・飛ばした段でも進まない（**一度ひっくり返した**）", () => {
    /*
      **この期待値は、一度は逆だった。** 2026-09-21 の最初の修正では
      「取りやめ（cancelled）」だけを留め、`failed`（走って失敗した）と
      `skipped`（前提が足りず走らせなかった）は**進めていた**。

      作者の裁定で反転した——走って失敗した段も、前提が足りず飛ばした段も、
      **作者から見れば「やっていないのに進んだ」にしか見えない**。
      進むのは本当に済んだときだけである。

      **ひっくり返した事実をここに残しておく。** 「昔からこうだった」と
      思って戻されると、同じ議論をもう一度やることになる。
    */
    const done: string[] = [];
    const notify = (command: string): void => void done.push(command);
    announceCommandFinished("走って失敗した", CHECK_FAILED, notify, noop);
    announceCommandFinished(
      "前提が足りず飛ばした",
      checkSkipped("プロットがまだ無いため"),
      notify,
      noop
    );
    announceCommandFinished("本当に済んだ", CHECK_COMPLETED, notify, noop);
    // 進むのは最後の1つだけ
    expect(done).toEqual(["本当に済んだ"]);
  });
});

/**
 * **21段のうち、どこまで「取りやめ」と名乗れるようになったかの台帳**
 * （設計書6.104。作者の裁定 2026-09-21で18段を揃えた）。
 *
 * 判断そのものは上で実際に呼んで測っている。ここで守るのは**行き渡り**で、
 * 1段でも名乗れないままだと、その段だけ**取りやめても案内が進む**。
 *
 * `activate` は単体で動かせないので、登録の**書いてある形**で数える。
 * 形しか見ていないことは承知のうえで置いてある——**行き渡りは、
 * 実際に呼ぶやり方では測れない**（80か所の登録を1つずつ起こせない）。
 */
describe("取りやめを名乗れる段が、行き渡っていること", () => {
  const source = readFileSync("src/extension.ts", "utf8");

  /** 定数で登録している段の、探し方 */
  const needleOf = (command: string): string =>
    command === "novelai.runProofreadingSuite"
      ? "PROOFREADING_SUITE_COMMAND,"
      : `"${command}"`;

  /**
   * その段の登録の中身。
   *
   * **`registerCommand(` に続く出どころだけを拾う。** コマンドIDは
   * import や対応表にも出てくるので、最初に見つけた場所を使うと
   * 見当違いのところを読む
   */
  function registrationOf(command: string): string {
    const needle = needleOf(command);
    let from = 0;
    for (;;) {
      const at = source.indexOf(needle, from);
      expect(at, `${command} の登録が見つからない`).toBeGreaterThan(-1);
      const before = source.slice(Math.max(0, at - 40), at).trimEnd();
      if (before.endsWith("registerCommand(")) {
        const next = source.indexOf("registerCommand(", at + needle.length);
        return source.slice(at, next < 0 ? source.length : next);
      }
      from = at + needle.length;
    }
  }

  /**
   * **自分の中では名乗らない段と、その代わりの道。**
   *
   * ここが空に近いほどよい。増やすときは「どこで名乗っているか」を
   * 必ず書く——書けないなら、それは塞げていないということである
   */
  const delegated: Readonly<Record<string, string>> = {
    // 作品を作る3つの入口は、同じ `createNewWork` を通る。
    // 行き先・作品名・タイプ・始め方のどれを閉じても取りやめになる
    "novelai.createWorkWithPlot": "createNewWork",
  };

  test("手順書きの全段が、取りやめを名乗れる", () => {
    const silent = [...new Set(PROCEDURE_REFERENCED_COMMANDS)].filter(
      (command) => {
        const body = registrationOf(command);
        if (body.includes("CHECK_CANCELLED")) return false;
        // 任せた先で名乗っているなら、それも数える
        const via = delegated[command];
        return !(via && body.includes(via));
      }
    );
    expect(silent, "取りやめても案内が進んでしまう段").toEqual([]);
  });

  test("任せた先が、本当に取りやめを名乗っている", () => {
    // 上の逃げ道が**言い張るだけ**にならないよう、任せた先も見る
    for (const [command, via] of Object.entries(delegated)) {
      const at = source.indexOf(`async function ${via}(`);
      expect(at, `${command} が任せた ${via} が見つからない`).toBeGreaterThan(
        -1
      );
      const body = source.slice(at, at + 4_000);
      expect(body, `${via} が取りやめを名乗っていない`).toContain(
        "CHECK_CANCELLED"
      );
    }
  });

  test("済んだことも名乗れる（名乗らない段は、任せた先が返している）", () => {
    /*
      **取りやめだけ名乗っても足りない。** 済んだことを名乗らない段は
      `undefined` で返り、`outcomeKindOf` が「済んだ」と読む——結果は
      同じだが、**読み手が「何も返していない」と「済んだ」を区別できない**。

      ここに並ぶ2つは、任せた先が印そのものを返している段である。
    */
    const returnsFromCallee = new Set([
      // 登録できた作品そのものを返す（ブラウザ版の実動テストが受け取る）
      "novelai.addWork",
      // `checkOpening.ts` が印を組み立てて返す
      "novelai.checkOpening",
      // `readerTargetDiagnosis.ts` が印を返す（0.74.12。手順書きの段に
      // なったので、取りやめ・済んだを名乗るようにした）
      "novelai.runReaderTargetDiagnosis",
      // `targetReader.ts` が印を返す（設計書6.108.6。読者の手順書き2本の段）
      "novelai.openTargetReader",
    ]);
    const silent = [...new Set(PROCEDURE_REFERENCED_COMMANDS)].filter(
      (command) =>
        !returnsFromCallee.has(command) &&
        !registrationOf(command).includes("CHECK_COMPLETED") &&
        !(
          delegated[command] &&
          registrationOf(command).includes(delegated[command])
        )
    );
    expect(silent, "済んだことを名乗らない段").toEqual([]);
  });
});

/**
 * **「もう一度光らせる」**（設計書6.104。作者の報告、2026-09-22
 * 「相談で光らせるが目立ちません。もう一度光らせるとかいるかも」）。
 *
 * 押しても**進まない**ことが要である——進み具合に関わると、
 * 見失って押し直しただけで案内が先へ行ってしまう。
 */
class FakeSpotlight implements ActionSpotlight {
  readonly shown: string[] = [];
  cleared = 0;
  async show(command: string): Promise<SpotlightResult> {
    this.shown.push(command);
    return { shown: true, view: "steps" };
  }
  clear(): void {
    this.cleared += 1;
  }
}

async function withSpotlight(): Promise<{
  screen: FakeScreen;
  host: GuidedTourHost;
  spotlight: FakeSpotlight;
}> {
  const screen = new FakeScreen();
  const host = new GuidedTourHost(screen);
  const spotlight = new FakeSpotlight();
  host.setSpotlight(spotlight);
  await host.start("consistency");
  return { screen, host, spotlight };
}

describe("もう一度光らせる", () => {
  test("同じ段をもう一度指すだけで、段は動かない", async () => {
    const { screen, host, spotlight } = await withSpotlight();
    const now = screen.step.step;
    expect(spotlight.shown, "始めたときに光らせていない").toEqual([
      now.command,
    ]);

    await host.showAgain();

    expect(spotlight.shown, "もう一度指していない").toEqual([
      now.command,
      now.command,
    ]);
    expect(screen.step.step.number, "押しただけで進んだ").toBe(now.number);
    expect(screen.ended, "押しただけで案内が畳まれた").toBeUndefined();
  });

  test("札は積み増さず、どこを光らせたかの1行だけ出す", async () => {
    const { screen, host } = await withSpotlight();
    await host.showAgain();

    // 同じ段の札が2枚並ぶと、どちらが生きているのか分からなくなる
    expect(
      screen.posts.filter((post) => post.type === "tourStep"),
      "同じ段の札が積み増された"
    ).toHaveLength(1);
    const notes = screen.posts.filter((post) => post.type === "tourNote");
    expect(notes, "どこを光らせたかが出ていない").toHaveLength(1);
    expect(notes[0]?.message).toContain("簡単ステップメニュー");
  });

  test("案内していなければ何も起きない", async () => {
    const screen = new FakeScreen();
    const host = new GuidedTourHost(screen);
    const spotlight = new FakeSpotlight();
    host.setSpotlight(spotlight);

    await host.showAgain();

    expect(spotlight.shown).toEqual([]);
    expect(screen.posts).toEqual([]);
  });
});

describe("案内が終わったら印を外す", () => {
  test("やめたとき", async () => {
    const { host, spotlight } = await withSpotlight();
    host.stop();
    expect(spotlight.cleared, "「▶」が居座る").toBe(1);
  });

  test("最後まで進んだとき", async () => {
    const { screen, host, spotlight } = await withSpotlight();
    for (let i = 0; i < 12 && !screen.ended; i++) {
      finished(host, screen.step.step.command, CHECK_COMPLETED);
      await settle();
    }
    expect(screen.ended, "最後まで進んでいない").toBeDefined();
    expect(spotlight.cleared, "「▶」が居座る").toBe(1);
  });
});
