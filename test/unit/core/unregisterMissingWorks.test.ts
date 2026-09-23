import { afterEach, describe, expect, test } from "vitest";
import { window } from "vscode";
import {
  offerToUnregisterMissingWorks,
  WorkRegistry,
} from "../../../src/core/workRegistry";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 「作品フォルダーが見つかりません」の知らせに付けた「登録を解除」
 * （設計書5.7.8。作者の裁定、2026-09-23）。
 *
 * 作者の実機で、取り込みの試しで作って後で消した作品の登録が残り、
 * **起動のたびに**この知らせが出た。外すには作品一覧の右クリックを
 * 探さなければならなかった。
 *
 * 守りたいのは3つ。
 * - **押さなければ何も外れない**（ドライブが繋がっていないだけのことがある）
 * - **押した時点でもう一度確かめる**（知らせを出したあとにドライブを
 *   繋ぎ直した・同期が終わった、なら外さない）
 * - **登録だけを外す**（フォルダーには触らない。ここは登録簿しか持たない）
 */

/** 登録簿の中身を持つだけの `globalState`。書いた値をそのまま覗く */
function fakeContext(works: WorkEntry[]): {
  context: { globalState: unknown };
  saved: () => WorkEntry[];
} {
  let stored = works;
  return {
    context: {
      globalState: {
        get: <T>(_key: string, _defaultValue: T): T => stored as unknown as T,
        update: async (_key: string, value: unknown) => {
          stored = value as WorkEntry[];
        },
      },
    },
    saved: () => stored,
  };
}

function entry(id: string, title: string): WorkEntry {
  return {
    id,
    title,
    folderPath: `C:\\novels\\${id}`,
    registeredAt: "2026-09-19T00:00:00.000Z",
  };
}

/** 画面に出たものの記録 */
interface Shown {
  warnings: Array<{ message: string; items: unknown[] }>;
  infos: string[];
  quickPicks: Array<{ items: unknown; options: unknown }>;
}

const original = {
  warn: window.showWarningMessage,
  info: window.showInformationMessage,
  pick: window.showQuickPick,
};
afterEach(() => {
  // 残すと、あとのテストが前の答えを拾う
  window.showWarningMessage = original.warn;
  window.showInformationMessage = original.info;
  window.showQuickPick = original.pick;
});

/**
 * 作者の答えを決めておく。
 *
 * @param notice 最初の知らせで押すボタン（`undefined` なら押さずに閉じた）
 * @param confirm 確認のダイアログで押すボタン
 * @param pick 複数のときの選択画面で選ぶ題（`undefined` なら閉じた）
 */
function answer(options: {
  notice?: string;
  confirm?: string;
  pick?: string[];
}): Shown {
  const shown: Shown = { warnings: [], infos: [], quickPicks: [] };
  window.showWarningMessage = (async (message: string, ...items: unknown[]) => {
    shown.warnings.push({ message, items });
    // 1回目は起動の知らせ、2回目以降は確認（modal）
    const isConfirm =
      typeof items[0] === "object" &&
      items[0] !== null &&
      (items[0] as { modal?: boolean }).modal === true;
    return isConfirm ? options.confirm : options.notice;
  }) as typeof window.showWarningMessage;
  window.showInformationMessage = (async (message: string) => {
    shown.infos.push(message);
    return undefined;
  }) as typeof window.showInformationMessage;
  window.showQuickPick = (async (items: unknown, pickOptions?: unknown) => {
    shown.quickPicks.push({ items, options: pickOptions });
    if (options.pick === undefined) return undefined;
    const list = items as Array<{ label: string }>;
    return list.filter((item) => options.pick?.includes(item.label));
  }) as typeof window.showQuickPick;
  return shown;
}

/** いつまでも無いまま（押した時点でも見つからない） */
const stillMissing = async (): Promise<boolean> => false;

describe("見つからない作品の知らせから登録を外す", () => {
  test("知らせに「登録を解除」のボタンが付いている", async () => {
    const shown = answer({});
    const { context } = fakeContext([entry("w1", "消えた作品")]);
    const registry = new WorkRegistry(context as never);

    await offerToUnregisterMissingWorks(
      registry,
      [entry("w1", "消えた作品")],
      stillMissing
    );

    expect(shown.warnings[0].message).toContain("見つかりません");
    expect(shown.warnings[0].message).toContain("消えた作品");
    expect(shown.warnings[0].items).toContain("登録を解除");
  });

  test("ボタンを押さなければ、何も外れない", async () => {
    // ドライブが繋がっていないだけ、同期がまだ、ということがある
    const shown = answer({ notice: undefined, confirm: "登録を解除" });
    const works = [entry("w1", "消えた作品"), entry("w2", "もう1つ")];
    const { context, saved } = fakeContext(works);
    const registry = new WorkRegistry(context as never);

    const removed = await offerToUnregisterMissingWorks(
      registry,
      works,
      stillMissing
    );

    expect(removed).toEqual([]);
    expect(saved().map((w) => w.id)).toEqual(["w1", "w2"]);
    // 確認も選択画面も出さない（知らせ1つだけ）
    expect(shown.warnings).toHaveLength(1);
    expect(shown.quickPicks).toHaveLength(0);
  });

  test("押しても、その時点でフォルダーが戻っていれば外さない", async () => {
    // 知らせを出したあとにドライブを繋ぎ直した・同期が終わった
    const shown = answer({ notice: "登録を解除", confirm: "登録を解除" });
    const { context, saved } = fakeContext([entry("w1", "戻った作品")]);
    const registry = new WorkRegistry(context as never);

    const removed = await offerToUnregisterMissingWorks(
      registry,
      [entry("w1", "戻った作品")],
      async () => true
    );

    expect(removed).toEqual([]);
    expect(saved().map((w) => w.id)).toEqual(["w1"]);
    // 確認は出さず、戻っていたことを短く知らせる
    expect(shown.warnings).toHaveLength(1);
    expect(shown.infos.join("\n")).toContain("戻った作品");
  });

  test("1件のとき、確認で「登録を解除」を選ぶと外れる", async () => {
    const shown = answer({ notice: "登録を解除", confirm: "登録を解除" });
    const { context, saved } = fakeContext([
      entry("w1", "消えた作品"),
      entry("w2", "残る作品"),
    ]);
    const registry = new WorkRegistry(context as never);
    let fired = 0;
    // 作品一覧は `onDidChange` で追随する（登録・解除と同じ流儀）
    registry.onDidChange(() => (fired += 1));

    const removed = await offerToUnregisterMissingWorks(
      registry,
      [entry("w1", "消えた作品")],
      stillMissing
    );

    expect(removed).toEqual(["w1"]);
    expect(saved().map((w) => w.id)).toEqual(["w2"]);
    expect(fired).toBe(1);
    // 確認は作品一覧の「作品の登録を解除」と同じ文面・同じボタン
    const confirm = shown.warnings[1];
    expect(confirm.message).toBe(
      "「消えた作品」の登録を解除しますか？\nフォルダとファイルは削除されません。"
    );
    expect(confirm.items).toEqual([{ modal: true }, "登録を解除"]);
  });

  test("1件のとき、確認で選ばなければ外れない", async () => {
    answer({ notice: "登録を解除", confirm: undefined });
    const { context, saved } = fakeContext([entry("w1", "消えた作品")]);
    const registry = new WorkRegistry(context as never);

    const removed = await offerToUnregisterMissingWorks(
      registry,
      [entry("w1", "消えた作品")],
      stillMissing
    );

    expect(removed).toEqual([]);
    expect(saved().map((w) => w.id)).toEqual(["w1"]);
  });

  test("複数のとき、選んだものだけが外れる（既定では何も選ばない）", async () => {
    const shown = answer({
      notice: "登録を解除",
      confirm: "登録を解除",
      pick: ["消えたA", "消えたC"],
    });
    const works = [
      entry("a", "消えたA"),
      entry("b", "消えたB"),
      entry("c", "消えたC"),
      entry("d", "在る作品"),
    ];
    const { context, saved } = fakeContext(works);
    const registry = new WorkRegistry(context as never);

    const removed = await offerToUnregisterMissingWorks(
      registry,
      works.slice(0, 3),
      stillMissing
    );

    expect([...removed].sort()).toEqual(["a", "c"]);
    expect(saved().map((w) => w.id)).toEqual(["b", "d"]);

    // 複数を選べる形で、**既定では1つも選ばれていない**
    const picked = shown.quickPicks[0];
    expect((picked.options as { canPickMany?: boolean }).canPickMany).toBe(true);
    const items = picked.items as Array<{ label: string; picked?: boolean }>;
    expect(items.map((item) => item.label)).toEqual([
      "消えたA",
      "消えたB",
      "消えたC",
    ]);
    expect(items.every((item) => item.picked !== true)).toBe(true);

    // 選んだものを確認してから外す
    const confirm = shown.warnings[1];
    expect(confirm.message).toContain("消えたA");
    expect(confirm.message).toContain("消えたC");
    expect(confirm.message).not.toContain("消えたB");
    expect(confirm.message).toContain("フォルダとファイルは削除されません");
    expect(confirm.items).toEqual([{ modal: true }, "登録を解除"]);
  });

  test("複数のとき、確認で選ばなければ1つも外れない", async () => {
    answer({ notice: "登録を解除", confirm: undefined, pick: ["消えたA"] });
    const works = [entry("a", "消えたA"), entry("b", "消えたB")];
    const { context, saved } = fakeContext(works);
    const registry = new WorkRegistry(context as never);

    expect(
      await offerToUnregisterMissingWorks(registry, works, stillMissing)
    ).toEqual([]);
    expect(saved().map((w) => w.id)).toEqual(["a", "b"]);
  });

  test("複数のとき、選択画面を閉じれば1つも外れない", async () => {
    const shown = answer({ notice: "登録を解除", confirm: "登録を解除" });
    const works = [entry("a", "消えたA"), entry("b", "消えたB")];
    const { context, saved } = fakeContext(works);
    const registry = new WorkRegistry(context as never);

    expect(
      await offerToUnregisterMissingWorks(registry, works, stillMissing)
    ).toEqual([]);
    expect(saved().map((w) => w.id)).toEqual(["a", "b"]);
    // 閉じたら確認は出さない
    expect(shown.warnings).toHaveLength(1);
  });

  test("一部だけ戻っていれば、戻った作品を知らせて、残りだけを対象にする", async () => {
    // 2件のうち1件が戻った → 残り1件なので、選択画面ではなく1件の確認になる
    const shown = answer({ notice: "登録を解除", confirm: "登録を解除" });
    const works = [entry("a", "戻った作品"), entry("b", "消えた作品")];
    const { context, saved } = fakeContext(works);
    const registry = new WorkRegistry(context as never);

    const removed = await offerToUnregisterMissingWorks(
      registry,
      works,
      async (folderPath) => folderPath.endsWith("a")
    );

    expect(removed).toEqual(["b"]);
    expect(saved().map((w) => w.id)).toEqual(["a"]);
    expect(shown.infos.join("\n")).toContain("戻った作品");
    expect(shown.quickPicks).toHaveLength(0);
    expect(shown.warnings[1].message).toContain("「消えた作品」");
  });

  test("押すまでのあいだに登録が外れていた作品は、対象にしない", async () => {
    // 作品一覧の右クリックで先に外した、など
    const shown = answer({ notice: "登録を解除", confirm: "登録を解除" });
    const { context, saved } = fakeContext([entry("b", "消えたB")]);
    const registry = new WorkRegistry(context as never);

    const removed = await offerToUnregisterMissingWorks(
      registry,
      [entry("a", "消えたA"), entry("b", "消えたB")],
      stillMissing
    );

    expect(removed).toEqual(["b"]);
    expect(saved()).toEqual([]);
    // 残りが1件なので、選択画面は出ない
    expect(shown.quickPicks).toHaveLength(0);
  });
});

describe("起動の整備はボタンを待たない", () => {
  test("知らせに答えなくても、整備は終わる", async () => {
    // **作者が知らせを放っておいても、起動は先へ進む。** 答えを待つと、
    // その後ろ（未登録の作品の知らせ・起動の数字）が止まる
    let noticeShown = false;
    window.showWarningMessage = ((message: string) => {
      if (message.includes("見つかりません")) noticeShown = true;
      // いつまでも答えない
      return new Promise<string | undefined>(() => undefined);
    }) as typeof window.showWarningMessage;

    // `workspace.fs.stat` は代役に無いので、どの作品も「見つからない」になる
    const { context, saved } = fakeContext([entry("w1", "消えた作品")]);
    const registry = new WorkRegistry(context as never);
    let unregisteredNoticeCalled = false;

    const report = await registry.maintainWorks(() => {
      unregisteredNoticeCalled = true;
    });

    expect(report.count).toBe(1);
    expect(noticeShown).toBe(true);
    expect(unregisteredNoticeCalled).toBe(true);
    // 押していないので、登録はそのまま
    expect(saved().map((w) => w.id)).toEqual(["w1"]);
  });
});
