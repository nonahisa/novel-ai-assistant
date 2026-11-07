import { describe, expect, test } from "vitest";
import {
  actionablePlans,
  afterCommit,
  describeOutcomes,
  describePlan,
  describeSyncConfirm,
  describeSyncSkips,
  describeTargetWorks,
  planSyncAll,
  planSyncTarget,
  worksTouchedByPaths,
  syncChoiceOf,
  syncCommitMessage,
  type SyncTargetState,
} from "../../../src/core/syncAllPlan";
import type { GitSyncStatus } from "../../../src/core/git";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 作品をすべて同期する（設計書5.5.14）。
 *
 * 作者の依頼（2026-08-24）：「作品をすべて同期するを実装してください」。
 *
 * **置き場ごとにまとめて動かす。** 既定では1つのリポジトリに複数の作品が
 * 入っているので、作品ごとに回すと同じ置き場を何度も処理してしまう。
 */

function work(id: string, title: string, folderPath: string): WorkEntry {
  return { id, title, folderPath } as WorkEntry;
}

function tracked(
  over: Partial<Extract<GitSyncStatus, { kind: "tracked" }>> = {}
): GitSyncStatus {
  // 置き場に作品が1つだけの想定なので、その作品ぶんの数（`〜Here`）は
  // 置き場ぜんぶの数と同じにする。**食い違う組み合わせを作らない**ために、
  // 渡された値から写す
  const behind = over.behind ?? 0;
  const ahead = over.ahead ?? 0;
  const dirty = over.dirty ?? 0;
  return {
    kind: "tracked",
    root: "C:/書庫",
    branch: "main",
    upstream: "origin/main",
    behind,
    ahead,
    dirty,
    behindHere: behind,
    aheadHere: ahead,
    dirtyHere: dirty,
    unmerged: 0,
    ...over,
  };
}

function state(over: Partial<SyncTargetState> = {}): SyncTargetState {
  return {
    folderPath: "C:/書庫",
    label: "書庫",
    works: [work("w1", "作品A", "C:/書庫/作品A")],
    status: tracked(),
    trackable: 0,
    ...over,
  };
}

describe("置き場ごとの手順", () => {
  test("同期が取れていれば、何もしない", () => {
    const plan = planSyncTarget(state());
    expect(plan.commit).toBe(false);
    expect(plan.pull).toBe(false);
    expect(plan.push).toBe(false);
    expect(plan.skip).toBe("nothing");
  });

  test("未記録の変更があれば、記録して送信する", () => {
    const plan = planSyncTarget(state({ trackable: 3 }));
    expect(plan.commit).toBe(true);
    // 記録すれば送るものができる
    expect(plan.push).toBe(true);
  });

  test("別の環境が進んでいれば、取り込む", () => {
    const plan = planSyncTarget(state({ status: tracked({ behind: 2 }) }));
    expect(plan.pull).toBe(true);
    expect(plan.push).toBe(false);
  });

  test("送っていないコミットがあれば、送信する", () => {
    const plan = planSyncTarget(state({ status: tracked({ ahead: 1 }) }));
    expect(plan.push).toBe(true);
    expect(plan.commit).toBe(false);
  });

  /** 記録が先。未記録のままでは取り込みが必ず飛ばされる（5.5.1） */
  test("記録も取り込みも要るときは、両方やる", () => {
    const plan = planSyncTarget(
      state({ trackable: 2, status: tracked({ behind: 3 }) })
    );
    expect(plan.commit).toBe(true);
    expect(plan.pull).toBe(true);
    expect(plan.push).toBe(true);
  });

  /** 競合マーカーごと履歴へ入れない（5.5.3） */
  test("競合が残っていたら、何もしない", () => {
    const plan = planSyncTarget(
      state({ trackable: 5, status: tracked({ unmerged: 1, behind: 1 }) })
    );
    expect(plan.commit).toBe(false);
    expect(plan.pull).toBe(false);
    expect(plan.push).toBe(false);
    expect(plan.skip).toBe("unmerged");
  });

  test("Gitで管理していない作品は飛ばす", () => {
    const plan = planSyncTarget(
      state({ trackable: 4, status: { kind: "not_a_repo" } })
    );
    expect(plan.commit).toBe(false);
    expect(plan.skip).toBe("not_a_repo");
  });

  /** 送り先が無くても、履歴には残せる */
  test("送り先が未設定でも、記録はする", () => {
    const plan = planSyncTarget(
      state({
        trackable: 2,
        // 記録していない2件は、gitから見ても変更として立っている
        status: { kind: "no_remote", root: "C:/書庫", dirty: 2, dirtyHere: 2 },
      })
    );
    expect(plan.commit).toBe(true);
    expect(plan.push).toBe(false);
  });

  test("一度も送信していない置き場は、記録して理由を残す", () => {
    const plan = planSyncTarget(
      state({
        trackable: 1,
        status: {
          kind: "no_upstream",
          root: "C:/書庫",
          branch: "main",
          dirty: 1,
          dirtyHere: 1,
        },
      })
    );
    expect(plan.commit).toBe(true);
    expect(plan.push).toBe(false);
    expect(plan.skip).toBe("no_upstream");
  });

  test("動かすものだけを取り出せる", () => {
    const plans = planSyncAll([
      state(),
      state({ trackable: 1 }),
      state({ status: { kind: "not_a_repo" } }),
    ]);
    expect(actionablePlans(plans)).toHaveLength(1);
  });
});

/**
 * 記録の前の保存（設計書5.5.19。作者の裁定 2026-10-04）。
 *
 * 変更が未保存の文書にしか無い置き場は、ディスクの件数（trackable）が0で、
 * 数えなければ「同期は取れています」で飛ばされ、保存の段までたどり着かない。
 */
describe("未保存の文書がある置き場", () => {
  test("ディスクに変更が無くても、未保存があれば記録する", () => {
    const plan = planSyncTarget(state({ trackable: 0, unsaved: 1 }));
    expect(plan.commit).toBe(true);
    expect(plan.push).toBe(true);
    expect(plan.skip).toBeUndefined();
  });

  test("送り先が未設定でも、未保存があれば記録する", () => {
    const plan = planSyncTarget(
      state({
        trackable: 0,
        unsaved: 2,
        status: { kind: "no_remote", root: "C:/書庫", dirty: 0, dirtyHere: 0 },
      })
    );
    expect(plan.commit).toBe(true);
  });

  test("競合が残っていたら、未保存があっても触らない（5.5.3）", () => {
    const plan = planSyncTarget(
      state({ unsaved: 1, status: tracked({ unmerged: 1 }) })
    );
    expect(plan.commit).toBe(false);
    expect(plan.skip).toBe("unmerged");
  });

  test("Gitで管理していない置き場は、未保存があっても飛ばす", () => {
    const plan = planSyncTarget(
      state({ unsaved: 1, status: { kind: "not_a_repo" } })
    );
    expect(plan.commit).toBe(false);
    expect(plan.skip).toBe("not_a_repo");
  });

  test("押す前の一覧に、先に保存することが出る", () => {
    expect(describePlan(planSyncTarget(state({ trackable: 0, unsaved: 1 })))).toContain(
      "記録（未保存 1件を先に保存）"
    );
    expect(describePlan(planSyncTarget(state({ trackable: 2, unsaved: 1 })))).toContain(
      "記録 2件（未保存 1件を先に保存）"
    );
  });
});

describe("何が起きるかを書く", () => {
  test("やることを並べる", () => {
    const text = describePlan(
      planSyncTarget(state({ trackable: 2, status: tracked({ behind: 1 }) }))
    );
    expect(text).toContain("記録 2件");
    expect(text).toContain("取り込み 1件");
  });

  /** 記録するぶんも送られる。数字だけだと足りなく見える */
  test("記録して送るときは、そのことが分かる", () => {
    const text = describePlan(planSyncTarget(state({ trackable: 2 })));
    expect(text).toContain("記録したぶん");
  });

  test("やることが無ければ、理由を書く", () => {
    expect(describePlan(planSyncTarget(state()))).toBe("同期は取れています");
    expect(
      describePlan(planSyncTarget(state({ status: { kind: "not_a_repo" } })))
    ).toBe("Gitで管理していません");
  });

  test("作品が1つなら、作品名を出す", () => {
    expect(describeTargetWorks(state())).toBe("作品A");
  });

});

/**
 * 書庫の同期で、その回に関わる作品だけを名前で出す（作者の指摘、2026-10-12 夜）。
 *
 * 「書庫単位で同期する際、書庫の全部作品名がでるのはわかりにくいです。
 * 作品名を特定してください」。実際に直したのは1作品だけなのに、書庫の
 * 5作品が全部並んでいた。
 */
describe("書庫の同期で出す作品名", () => {
  const five = [
    work("w1", "いじめられっ子", "C:/書庫/いじめられっ子"),
    work("w2", "たゆたう鉛", "C:/書庫/たゆたう鉛"),
    work("w3", "ハイエルフ未亡人", "C:/書庫/ハイエルフ未亡人"),
    work("w4", "教科書チート", "C:/書庫/教科書チート"),
    work("w5", "事実の照合台", "C:/書庫/事実の照合台"),
  ];

  test("1作品だけ変えたなら、その作品名と書庫の名前だけを出す", () => {
    const text = describeTargetWorks(
      state({ works: five, involved: [five[0]] })
    );
    expect(text).toBe("いじめられっ子（書庫 書庫）");
    expect(text).not.toContain("たゆたう鉛");
  });

  test("2作品なら、書庫の名前のあとに2つを並べる", () => {
    expect(
      describeTargetWorks(state({ works: five, involved: [five[0], five[2]] }))
    ).toBe("書庫 の いじめられっ子・ハイエルフ未亡人");
  });

  test("多いときは、先頭の作品と「ほか N作品」に縮める", () => {
    expect(
      describeTargetWorks(state({ works: five, involved: five.slice(0, 4) }))
    ).toBe("書庫 の いじめられっ子・たゆたう鉛 ほか2作品");
  });

  test("作品に当てられない変更しか無ければ、書庫の名前だけ（全作品を並べない）", () => {
    expect(describeTargetWorks(state({ works: five, involved: [] }))).toBe("書庫");
    // 材料が無い（調べられなかった）ときも同じ
    expect(describeTargetWorks(state({ works: five }))).toBe("書庫");
  });

  test("変わった道を、作品フォルダーへ当てる（書庫の直下は当てない）", () => {
    const touched = worksTouchedByPaths("C:/書庫", five, [
      "いじめられっ子/本文/001.txt",
      "教科書チート/設定/characters.json",
      "README.md",
      // 書庫の名前が前方一致するだけの別フォルダーは、中ではない
      "いじめられっ子2/本文/001.txt",
    ]);
    expect(touched.map((one) => one.title)).toEqual([
      "いじめられっ子",
      "教科書チート",
    ]);
    expect(worksTouchedByPaths("C:/書庫", five, ["README.md"])).toEqual([]);
  });
});

describe("次は同期しないもの", () => {
  test("Gitで管理していない置き場を、理由付きで並べる（実機確認リスト A-15 の代わり）", () => {
    const text = describeSyncSkips(
      planSyncAll([
        state({ trackable: 2 }),
        state({
          label: "手書きの作品",
          works: [work("w9", "手書きの作品", "C:/手書きの作品")],
          status: { kind: "not_a_repo" },
        }),
      ])
    );
    expect(text).toContain("以下は同期しません。");
    expect(text).toContain("・手書きの作品：Gitで管理していません");
  });

  /*
    作者の指摘（ノートPCでネットを切った保存・同期、2026-11-05）：あとの報告の「次は同期しません。」が
    「次回は同期しない」と読めた。作者の答え：場面で分ける——あとの報告と「同期するものはありませんでした」は
    「以下は同期できませんでした。」、前の確認の窓は「以下は同期しません。」
  */
  test("同期のあと（報告・同期するものはありませんでした）は「以下は同期できませんでした。」、前の確認は「以下は同期しません。」", () => {
    const plans = planSyncAll([
      state({ trackable: 2 }),
      state({
        label: "手書きの作品",
        works: [work("w9", "手書きの作品", "C:/手書きの作品")],
        status: { kind: "not_a_repo" },
      }),
    ]);
    const after = describeSyncSkips(plans, "after");
    expect(after).toContain("以下は同期できませんでした。");
    expect(after).not.toContain("次は");
    const before = describeSyncSkips(plans, "before");
    expect(before).toContain("以下は同期しません。");
    expect(before).not.toContain("次は");
  });

  test("競合が残っている置き場も、理由付きで出す（実機確認リスト A-15 の代わり）", () => {
    const text = describeSyncSkips(
      planSyncAll([
        state({ trackable: 5, status: tracked({ unmerged: 1, behind: 1 }) }),
      ])
    );
    // 開発の言葉（競合）を使わず、知らせのボタン「残す文を選ぶ」と同じ言葉で言う
    // （作者の判断 2026-11-01。「競合解決」は詳細メニューから外した）
    expect(text).toContain("・作品A：どちらの文を残すか決まっていない原稿があります");
    expect(text).toContain("「残す文を選ぶ」");
  });

  /** 「同期は取れています」は、作者が直すところが無いので書かない */
  test("やることが無いだけの置き場は、並べない（実機確認リスト A-15 の代わり）", () => {
    expect(describeSyncSkips(planSyncAll([state(), state()]))).toBe("");
  });
});

describe("記録に付ける説明", () => {
  test("「2026-08-24 20:30 の執筆（3件）」の形（実機確認リスト A-15 の代わり）", () => {
    expect(syncCommitMessage(3, new Date(2026, 7, 24, 20, 30))).toBe(
      "2026-08-24 20:30 の執筆（3件）"
    );
  });

  test("月・日・時・分は2桁に揃える（実機確認リスト A-15 の代わり）", () => {
    expect(syncCommitMessage(1, new Date(2026, 0, 5, 9, 7))).toBe(
      "2026-01-05 09:07 の執筆（1件）"
    );
  });
});

describe("済んだあとの報告", () => {
  const plan = planSyncTarget(state({ trackable: 1 }));

  test("できたことを数える", () => {
    const text = describeOutcomes([
      { plan, committed: true, pulled: false, pushed: true },
    ]);
    expect(text).toContain("記録 1か所");
    expect(text).toContain("送信 1か所");
  });

  /** 半分しか通っていないときに気づけるようにする */
  test("通らなかったものも書く", () => {
    const text = describeOutcomes([
      { plan, committed: true, pulled: false, pushed: false, error: "拒まれた" },
    ]);
    expect(text).toContain("1か所は最後まで通りませんでした");
  });

  test("何も無ければ、そう書く", () => {
    expect(describeOutcomes([])).toBe("同期するものはありませんでした。");
  });

  /*
    作者の実機（2026-11-03 夜、ノートPC・0.122.2）：Wi-Fi を切ったまま「保存・同期」を押すと、
    記録はできたが送信は届かず、届いていないことが作者に伝わらなかった。
    作者の裁定：**作者が押した同期で届かなかったときは1回だけ知らせる**。
    原因は当てず、「届いていない」事実と作品の数、次に起きること（自動の送り直しの有無）を言う
  */
  describe("送信だけが届かなかったとき（作者の裁定 2026-11-03）", () => {
    const library = state({
      trackable: 3,
      works: [
        work("w1", "作品A", "C:/書庫/作品A"),
        work("w2", "作品B", "C:/書庫/作品B"),
        work("w3", "作品C", "C:/書庫/作品C"),
      ],
    });
    const libraryPlan = planSyncTarget(library);

    test("手元には記録したこと・届いていない作品の数・自動で送ることを言う", () => {
      const text = describeOutcomes(
        [
          {
            plan: libraryPlan,
            committed: true,
            pulled: false,
            pushed: false,
            pushFailed: true,
            error: "GitHub へは届いていません",
          },
        ],
        { autoResend: true }
      );
      expect(text).toBe(
        "手元には記録しました。GitHub へは届いていません（3作品）。" +
          "ネットにつながったら自動で送ります。"
      );
    });

    test("自動の送り直しが切ってあれば、もう一度押すように言う", () => {
      const text = describeOutcomes(
        [
          {
            plan: libraryPlan,
            committed: true,
            pulled: false,
            pushed: false,
            pushFailed: true,
            error: "GitHub へは届いていません",
          },
        ],
        { autoResend: false }
      );
      expect(text).toContain("GitHub へは届いていません（3作品）。");
      expect(text).toContain("ネットにつながったら「保存・同期」をもう一度押してください。");
      expect(text).not.toContain("自動で送ります");
    });

    test("関わる作品が分かっていれば、その数で言う", () => {
      const touched = planSyncTarget({ ...library, involved: [library.works[1]] });
      const text = describeOutcomes(
        [
          {
            plan: touched,
            committed: true,
            pulled: false,
            pushed: false,
            pushFailed: true,
            error: "GitHub へは届いていません",
          },
        ],
        { autoResend: true }
      );
      expect(text).toContain("（1作品）");
    });

    test("記録していない置き場（前からの未送信だけ）なら「記録しました」と言わない", () => {
      const aheadOnly = planSyncTarget(state({ status: tracked({ ahead: 2 }) }));
      const text = describeOutcomes(
        [
          {
            plan: aheadOnly,
            committed: false,
            pulled: false,
            pushed: false,
            pushFailed: true,
            error: "GitHub へは届いていません",
          },
        ],
        { autoResend: true }
      );
      expect(text).not.toContain("手元には記録しました");
      expect(text).toContain("GitHub へは届いていません（1作品）。");
    });

    test("ほかの置き場が送れていれば、既存の形で送った数を前に置く", () => {
      const other = planSyncTarget(
        state({ folderPath: "C:/別", label: "別", trackable: 1, works: [work("x", "別作品", "C:/別")] })
      );
      const text = describeOutcomes(
        [
          { plan: other, committed: true, pulled: false, pushed: true },
          {
            plan: libraryPlan,
            committed: true,
            pulled: false,
            pushed: false,
            pushFailed: true,
            error: "GitHub へは届いていません",
          },
        ],
        { autoResend: true }
      );
      expect(text.startsWith("記録 1か所・送信 1か所を済ませました。")).toBe(true);
      expect(text).toContain("GitHub へは届いていません（3作品）。");
      // 送信だけ届かなかった所は「最後まで通りませんでした」に数えない（同じことを2度言わない）
      expect(text).not.toContain("最後まで通りませんでした");
    });
  });
});

describe("記録の結果を、次の手順へ翻訳する", () => {
  /**
   * 2026-08-26、作者の実機で
   * 「記録できませんでした: On branch main / nothing to commit, working tree clean」
   * が出た。**そこで打ち切っていたので、取り込み1件・送信11件が飛んでいた。**
   */
  test("記録するものが無くても、止めない", () => {
    const next = afterCommit({ ok: true, nothingToCommit: true });

    expect(next.stop).toBe(false);
    // 記録はしていないので、報告で「記録した」と数えない
    expect(next).toMatchObject({ committed: false });
  });

  test("記録できたら、記録したと数える", () => {
    expect(afterCommit({ ok: true })).toEqual({ stop: false, committed: true });
  });

  test("本当に失敗したときは止めて、理由を返す", () => {
    // 続けても同じ理由で止まる。取り込みは未記録の変更があると動かない
    const next = afterCommit({ ok: false, detail: "fatal: index.lock" });

    expect(next).toEqual({
      stop: true,
      error: "記録できませんでした: fatal: index.lock",
    });
  });

  test("理由が分からなくても、黙って止まらない", () => {
    expect(afterCommit({ ok: false })).toMatchObject({
      error: "記録できませんでした: （詳細なし）",
    });
  });
});

/**
 * 確認の窓を1つにまとめる（作者の裁定、2026-10-01 案2）。
 *
 * 作者の報告（2026-09-27）：別の機械で変えた分との合流が3クリックかかる。
 * ［保存・同期］→［同期する］→ 見比べの入口［全部、新しいほうを採る］。
 * **選ぶ設定資料があるときだけ**、確認の窓に選び方のボタンを並べ、
 * 入口の窓を省く。無ければ「同期する」1つ。
 */
describe("同期の確認の窓", () => {
  function diverged(conflicts: {
    settings?: string[];
    undecidedSettings?: string[];
    manuscripts?: string[];
  }): SyncTargetState {
    return state({
      status: tracked({
        behind: 2,
        ahead: 1,
        conflicts: {
          settings: conflicts.settings ?? [],
          undecidedSettings: conflicts.undecidedSettings,
          manuscripts: conflicts.manuscripts ?? [],
          autoWritten: [],
          appendOnly: [],
        },
      }),
    });
  }

  test("選ぶ設定資料があれば、確認の窓で選び方まで訊く", () => {
    const plans = planSyncAll([
      diverged({
        settings: ["短編/設定/characters/a.json"],
        undecidedSettings: ["短編/設定/characters/a.json"],
      }),
    ]);
    const text = describeSyncConfirm(actionablePlans(plans), plans);

    expect(text.buttons).toEqual([
      "同期する（設定資料は新しいほうへ）",
      "同期する（1件ずつ選ぶ）",
    ]);
    expect(syncChoiceOf(text.buttons[0])).toBe("newest");
    expect(syncChoiceOf(text.buttons[1])).toBe("oneByOne");
    // 入口の窓が言っていたことは、こちらへ移す（件数・戻し方）
    expect(text.detail).toContain("設定資料 1件");
    expect(text.detail).toContain("退避の枝");
  });

  test("設定資料の衝突が規則で決まる見込みなら、ボタンは「同期する」1つ", () => {
    const plans = planSyncAll([
      diverged({
        settings: ["短編/設定/characters/a.json"],
        undecidedSettings: [],
      }),
    ]);
    const text = describeSyncConfirm(actionablePlans(plans), plans);

    expect(text.buttons).toEqual(["同期する"]);
    expect(syncChoiceOf("同期する")).toBe("manuscriptsOnly");
  });

  test("本文だけが衝突するなら「同期する」1つで、1件ずつ選ぶことを書いておく", () => {
    const plans = planSyncAll([diverged({ manuscripts: ["短編/本文/第1話.txt"] })]);
    const text = describeSyncConfirm(actionablePlans(plans), plans);

    expect(text.buttons).toEqual(["同期する"]);
    expect(text.detail).toContain("本文 1件");
    expect(text.detail).toContain("途中でやめると");
  });

  test("見込みを調べられなかった設定資料は、選ぶ側に数える（安全な側）", () => {
    const plans = planSyncAll([
      diverged({ settings: ["短編/設定/characters/a.json"] }),
    ]);
    const text = describeSyncConfirm(actionablePlans(plans), plans);

    expect(text.buttons).toHaveLength(2);
  });

  test("送信の有無は、これまでどおり書く", () => {
    const plans = planSyncAll([diverged({})]);
    const text = describeSyncConfirm(actionablePlans(plans), plans);

    expect(text.message).toBe("1か所を同期します。");
    expect(text.detail).toContain("1か所はGitHubへ送信します");
  });

  test("押さずに閉じたら、同期しない", () => {
    expect(syncChoiceOf(undefined)).toBeUndefined();
  });
});

/**
 * 状態を調べる前の取りに行き（fetch）が失敗した置き場（2026-11-02）。
 *
 * 遅れの数は手元が知っている古いままなので、0件でも「同期は取れています」とは言えない。
 * 以前は理由が `nothing` になり、「次は同期しません」（いまは「以下は同期しません」）の行からも消えて、つながらなかったことが
 * 作者に伝わらなかった（原稿箱の受け取りと同じ形。編集者の「保存・同期」の受け取るだけの道でも同じ）。
 */
describe("取りに行けなかった置き場", () => {
  test("作者の手順：ほかにやることが無ければ「受け取れませんでした」を理由にし、次は同期しないものへ並べる", () => {
    const plans = planSyncAll([state({ fetchFailed: true })]);
    expect(plans[0]?.skip).toBe("fetch_failed");
    expect(actionablePlans(plans)).toHaveLength(0);
    const skips = describeSyncSkips(plans);
    expect(skips).toContain("GitHub から受け取れませんでした");
    // エラー文から原因を当てない（実装ルール5）
    expect(skips).not.toMatch(/ネット|回線|権限/);
  });

  test("編集者の受け取るだけの手順でも同じ", () => {
    const plans = planSyncAll([state({ fetchFailed: true })], { editor: true });
    expect(plans[0]?.receiveOnly).toBe(true);
    expect(plans[0]?.skip).toBe("fetch_failed");
    expect(describeSyncSkips(plans)).toContain("GitHub から受け取れませんでした");
  });

  test("手元にやることがあれば、取りに行けなくても今までどおり進める（送信の失敗は別に報告される）", () => {
    const plan = planSyncTarget(state({ fetchFailed: true, trackable: 2 }));
    expect(plan.commit).toBe(true);
    expect(plan.push).toBe(true);
    expect(plan.skip).toBeUndefined();
  });

  test("編集者の手順で作者の側と分かれていれば、合わせにいかず「校閲を終えて返す」を理由の行に出す", () => {
    const plans = planSyncAll([state({ status: tracked({ ahead: 1, behind: 1 }) })], { editor: true });
    expect(plans[0]?.receiveOnly).toBe(true);
    expect(plans[0]?.skip).toBe("editor_diverged");
    expect(plans[0]?.pull).toBe(false);
    expect(actionablePlans(plans)).toHaveLength(0);
    expect(describeSyncSkips(plans)).toContain("「校閲を終えて返す」");
  });

  test("取りに行けたなら、これまでどおり「同期は取れています」（理由の行には出さない）", () => {
    const plans = planSyncAll([state()], { editor: true });
    expect(plans[0]?.skip).toBe("nothing");
    expect(describeSyncSkips(plans)).toBe("");
  });

  /*
    編集者の「1. 作者の最新の原稿を受け取る」で、理由を GitHub の API で見分けたとき
    （設計書5.7.5.4。作者の決定 2026-11-07「分けて知らせる」）。見分けは呼ぶ側
    （`syncAllWorks.ts`）が API の返事で決め、ここへは結果だけが来る
  */
  test("置き場に届かない（404）と分かったら、解除か置き場が無い見込みと言う", () => {
    const plans = planSyncAll([state({ fetchFailed: true, fetchTrouble: "revoked" })], { editor: true });
    expect(plans[0]?.skip).toBe("fetch_revoked");
    expect(describeSyncSkips(plans)).toContain("作者が連携を解除したか、置き場が無くなった見込み");
  });

  test("通信そのものが失敗したと分かったら、つながってから押し直すよう言う", () => {
    const plans = planSyncAll([state({ fetchFailed: true, fetchTrouble: "offline" })], { editor: true });
    expect(plans[0]?.skip).toBe("fetch_offline");
    expect(describeSyncSkips(plans)).toContain("ネットにつながっていないようです");
  });
});
