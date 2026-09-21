import { describe, expect, test } from "vitest";
import { applyChatEdit } from "../../src/features/applyChatEdit";
import type { WorkEntry } from "../../src/models/types";

/**
 * 相談からの書き込みを「取り消す」ときに、**空へ戻してよい対象かどうか**
 * （設計書6.4.7）。
 *
 * **対象ごとに答えが違う。** `plot.md` は見出しを残して中身だけ空にできるが、
 * **各話あらすじの台帳は非空を前提に検証している**ので、空を書くと
 * **保存は通るのに、次の読み込みで台帳ごと読めなくなる**
 * （`synopsisStore.test.ts` が台帳側から見張っている）。
 *
 * だから `applyToEpisodeSynopsis` は、**書きに行く前に断る**。
 * ここが抜けると、**取り消しを1回押しただけで全話のあらすじを失う。**
 *
 * **I/O へ届く前の関門**なので、作り物のファイルは要らない——届いて
 * しまったら、それ自体が不具合である。
 */

const work = {
  id: "w_a",
  title: "たゆたう鉛",
  folderPath: "C:/確認用コピー/たゆたう鉛_確認用",
} as WorkEntry;

describe("各話あらすじは、空へ戻せない", () => {
  test("空で書きに行こうとすると、書く前に断る", async () => {
    await expect(
      applyChatEdit(
        work,
        { target: { kind: "episodeSynopsis", chapter: 3 }, content: "" },
        // **取り消しの経路**（ここが立つのは戻すときだけ）
        { allowEmpty: true }
      )
    ).rejects.toThrow("空にできません");
  });

  test("断りに、話数と理由と次の手が入っている", async () => {
    // **「できません」だけでは、作者は行き止まりに立つ。**
    // どの話か・なぜか・どうすればよいかを1文で言う
    await expect(
      applyChatEdit(
        work,
        { target: { kind: "episodeSynopsis", chapter: 12 }, content: "" },
        { allowEmpty: true }
      )
    ).rejects.toThrow(/第12話.*台帳が読めなくなる.*手で書き換えて/s);
  });

  test("allowEmpty を渡さなくても、同じく断る", async () => {
    // 普通の書き込みでは `parseChatEdit` が空を弾くが、**関門はここにも要る**
    // ——弾く側を通らない呼び出しが増えたときに、静かに壊れる
    await expect(
      applyChatEdit(work, {
        target: { kind: "episodeSynopsis", chapter: 1 },
        content: "",
      })
    ).rejects.toThrow("空にできません");
  });
});
