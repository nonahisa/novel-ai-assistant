import { describe, expect, it } from "vitest";
import { tryRegisterAsCollection } from "../../../src/features/addCollection";
import type { WorkRegistry } from "../../../src/core/workRegistry";

/**
 * 「1作品だと分かっている」ときは、書庫かどうかを訊かない（設計書5.7・6.99）。
 *
 * **ZIPからの取り込みは、自分でその作品フォルダーを作った**（`本文/` と
 * `設定/` を置いたのは取り込み自身である）。それを書庫かもしれないと
 * 見に行くと、作者には「作品にも書庫にも見えます」という選択が出る——
 * しかも**既定は「中の1件を登録する」のほう**なので、そのままEnterを
 * 押すと壊れた登録になる（2026-09-19、作者の実機確認）。
 *
 * 「フォルダから追加」は本当に書庫かもしれないので、これまでどおり訊く。
 * **その違いが消えていないこと**もここで見る。
 */

/**
 * 中を調べ始めたら分かる registry。
 *
 * `tryRegisterAsCollection` は登録済みの場所を引いてから走査に入るので、
 * `list()` が呼ばれた時点で「訊く道に入った」ことになる。
 */
function trippingRegistry(): WorkRegistry {
  return {
    list(): never {
      throw new Error("書庫かどうかを調べに行ってしまった");
    },
  } as unknown as WorkRegistry;
}

describe("作品だと分かっているフォルダーの登録", () => {
  it("1作品だと分かっていれば、中を調べずに呼び出し側へ返す", async () => {
    const result = await tryRegisterAsCollection(
      trippingRegistry(),
      "c:/小説/星を継ぐ者たち",
      { knownSingleWork: true }
    );

    expect(result).toEqual({ handled: false });
  });

  it("分かっていなければ、これまでどおり中を調べる", async () => {
    // 走査に入ること自体が期待どおりの振る舞いなので、
    // 「調べに行った」印（例外）が出ることを確かめる
    await expect(
      tryRegisterAsCollection(trippingRegistry(), "c:/小説")
    ).rejects.toThrow("書庫かどうかを調べに行ってしまった");
  });
});
