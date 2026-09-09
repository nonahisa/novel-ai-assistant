import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { window } from "./support/vscodeStub";
import { disposeLog } from "../../src/core/logger";
import type { WorkEntry } from "../../src/models/types";

/**
 * 誤字脱字の対象範囲は、まとめ実行では聞かない（設計書6.80／6.8.7）。
 *
 * **まとめ実行は「ボタン1回で放置できる」ためにある。** 量と料金の確認を
 * 1枚にまとめたのに、そのあと誤字脱字だけが「前回から書いた分だけ／全体」を
 * 聞いてくると、作者は結局そこに座って待つことになる。
 *
 * 飛ばすときは**全体を選んだことにする**——処理済みのチャンクはキャッシュが
 * 飛ばすので、送る量は「前回から書いた分」とほとんど変わらない。逆に
 * 「書いた分だけ」を勝手に選ぶと、まだ見ていない話が黙って対象から外れる。
 */

/**
 * `chooseScope` は本物だと更新時刻の走査とQuickPickが要る。
 * ここで見たいのは**呼ばれたかどうか**だけなので、丸ごと差し替える。
 */
const mocks = vi.hoisted(() => ({ chooseScope: vi.fn() }));
vi.mock("../../src/features/typoCheckScope", () => ({
  chooseScope: mocks.chooseScope,
}));

const { resolveTypoScope } = await import("../../src/features/checkTypos");

const work: WorkEntry = {
  id: "w1",
  title: "試しの作品",
  folderPath: "C:/works/試しの作品",
  registeredAt: "2026-09-05T00:00:00.000Z",
};

/** ログへ出た行。飛ばした中身を捨てていないことを、ここで確かめる */
let logged: string[] = [];

const stub = window as unknown as Record<string, unknown>;
const originalCreateOutputChannel = stub.createOutputChannel;

beforeEach(() => {
  logged = [];
  mocks.chooseScope.mockReset();
  mocks.chooseScope.mockResolvedValue({
    kind: "changed",
    filePaths: ["C:/works/試しの作品/原稿/02.txt"],
  });
  stub.createOutputChannel = () => ({
    appendLine: (line: string) => logged.push(line),
    show() {},
    dispose() {},
  });
});

afterEach(() => {
  // ログの出力先は module 側に覚えられているので、捨ててから戻す
  disposeLog();
  stub.createOutputChannel = originalCreateOutputChannel;
});

describe("誤字脱字の対象範囲", () => {
  test("まとめ実行では聞かずに、全体を選んだことにする", async () => {
    const scope = await resolveTypoScope(work, { suiteConfirmed: true });

    expect(mocks.chooseScope).not.toHaveBeenCalled();
    expect(scope).toEqual({ kind: "all" });
  });

  test("飛ばしたことをログへ残す", async () => {
    // **黙って全体にしない。** あとから「なぜ全話ぶん走ったのか」を
    // 追えないと、料金や待ち時間の問い合わせに答えられない
    await resolveTypoScope(work, { suiteConfirmed: true });

    expect(logged.join("\n")).toContain("まとめ実行のため対象は全体");
  });

  test("単独実行では、従来どおり聞く", async () => {
    const scope = await resolveTypoScope(work, {});

    expect(mocks.chooseScope).toHaveBeenCalledWith(work);
    expect(scope).toEqual({
      kind: "changed",
      filePaths: ["C:/works/試しの作品/原稿/02.txt"],
    });
  });

  test("印を渡さずに呼んでも聞く（既定は単独実行）", async () => {
    await resolveTypoScope(work);

    expect(mocks.chooseScope).toHaveBeenCalledTimes(1);
  });

  test("単独実行で取りやめたら、取りやめのまま返す", async () => {
    // ここで `{ kind: "all" }` へ丸めると、Escで閉じたのに検知が走り出す
    mocks.chooseScope.mockResolvedValue(undefined);

    expect(await resolveTypoScope(work, {})).toBeUndefined();
  });
});
