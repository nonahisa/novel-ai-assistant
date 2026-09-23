import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import {
  backupIdentityOf,
  matchBackupToWorks,
  normalizeWorkTitle,
  type BackupIdentity,
  type BackupMatchCandidate,
} from "../../../src/core/backupMatch";
import { inspectWorkBackup } from "../../../src/core/workZip";

/**
 * 持ち込まれたバックアップが、どの登録済み作品のものかを決める
 * （作者の依頼、2026-09-23）。
 *
 * **当たる・当たらない・曖昧の3つを必ず並べて試す。** 当たるほうだけを
 * 試すと、「いつも当たったことにする」実装が満点になる。
 */

function work(
  id: string,
  title: string,
  siteIds: BackupMatchCandidate["siteIds"] = [],
  folderName = title
): BackupMatchCandidate {
  return { id, title, folderName, siteIds };
}

const NAROU: BackupIdentity = {
  site: "narou",
  workId: "n5078ji",
  title: "コールドスリープから目覚めたら、少子化が解決していました",
};

describe("作品IDで照らす", () => {
  it("台帳のNコードが一致すれば、題が違っても当たる", () => {
    const match = matchBackupToWorks(NAROU, [
      work("a", "別の作品"),
      work("b", "コールドスリープ", [{ site: "narou", workId: "N5078JI" }]),
    ]);

    expect(match).toEqual({
      kind: "matched",
      by: "id",
      workId: "b",
      differentId: [],
    });
  });

  it("同じNコードが2作品に書いてあれば、決めずに選ばせる", () => {
    const match = matchBackupToWorks(NAROU, [
      work("a", "コールドスリープ", [{ site: "narou", workId: "n5078ji" }]),
      work("b", "コールドスリープ（写し）", [{ site: "narou", workId: "N5078JI" }]),
    ]);

    expect(match.kind).toBe("ambiguous");
    if (match.kind !== "ambiguous") return;
    expect(match.by).toBe("id");
    expect(match.workIds).toEqual(["a", "b"]);
  });

  it("別のサイトの作品IDは見ない（カクヨムの行にNコードが書いてあっても当てない）", () => {
    const match = matchBackupToWorks(NAROU, [
      work("a", "まったく別の題", [{ site: "kakuyomu", workId: "n5078ji" }]),
    ]);

    expect(match.kind).toBe("none");
  });
});

describe("題で照らす", () => {
  it("全角半角・空白・大文字小文字の違いはそろえてから比べる", () => {
    const identity: BackupIdentity = {
      site: "kakuyomu",
      workId: null,
      title: "ＡＢＣ　物語 ２",
    };

    const match = matchBackupToWorks(identity, [work("a", "abc物語2")]);

    expect(match).toMatchObject({ kind: "matched", by: "title", workId: "a" });
  });

  it("フォルダー名に使えない記号が落ちた題とも当たる", () => {
    const identity: BackupIdentity = {
      site: null,
      workId: null,
      title: "こちら冒険者ギルド生活保護課!!：再",
    };

    const match = matchBackupToWorks(identity, [
      work("a", "こちら冒険者ギルド生活保護課!!再"),
    ]);

    expect(match).toMatchObject({ kind: "matched", workId: "a" });
  });

  it("作品一覧の名前が違っても、フォルダー名が同じなら当たる", () => {
    const match = matchBackupToWorks(NAROU, [
      work("a", "コールドスリープ", [], NAROU.title),
    ]);

    expect(match).toMatchObject({ kind: "matched", by: "title", workId: "a" });
  });

  it("同じ題が2つあれば、決めずに選ばせる", () => {
    const match = matchBackupToWorks(NAROU, [
      work("a", NAROU.title),
      work("b", NAROU.title),
    ]);

    expect(match).toMatchObject({ kind: "ambiguous", by: "title", workIds: ["a", "b"] });
  });

  it("題の一部だけが合う作品は、1つでも当たりにせず選ばせる", () => {
    // 作者の手元に実際にある形：本編と「〜別視点バージョン〜」
    const identity: BackupIdentity = {
      site: "narou",
      workId: null,
      title: "転生した受験生の異世界成り上がり",
    };

    const match = matchBackupToWorks(identity, [
      work("a", "転生した受験生の異世界成り上がり　～別視点バージョン～"),
      work("b", "教科書チート"),
    ]);

    expect(match).toMatchObject({ kind: "ambiguous", by: "partial", workIds: ["a"] });
  });

  it("短すぎる題の部分一致は候補にしない（「夏」がどの題にも入ってしまう）", () => {
    const identity: BackupIdentity = { site: null, workId: null, title: "夏" };

    const match = matchBackupToWorks(identity, [work("a", "夏の終わりの物語")]);

    expect(match.kind).toBe("none");
  });

  it("**台帳のNコードが違えば、題が同じでも別の作品と見る**", () => {
    const match = matchBackupToWorks(NAROU, [
      work("a", NAROU.title, [{ site: "narou", workId: "n1111ir" }]),
    ]);

    expect(match).toEqual({
      kind: "none",
      differentId: [{ workId: "a", by: "title" }],
    });
  });

  /*
    実機（2026-09-23、0.75.13）：題がまったく違う「照合試験_無関係」を
    落としたのに、「『教科書チート』は題が同じですが、…作品IDが違うため」と
    出た。**題を比べる前に**、台帳に別のIDを持つ作品を全部集めていたため、
    作者の環境ではどのなろうのバックアップでも同じ一言が出ていた。
  */
  it("**題が当たらない作品は、IDが違っても「外した」と言わない**", () => {
    const match = matchBackupToWorks(
      { site: "narou", workId: "n0000zy", title: "照合試験_無関係" },
      [
        work("a", "教科書チート", [{ site: "narou", workId: "n2600go" }]),
        work("b", "教科書チート_確認用", [{ site: "narou", workId: "n2600go" }]),
      ]
    );

    expect(match).toEqual({ kind: "none", differentId: [] });
  });

  it("題の一部だけが合ってIDが違う作品は、「一部が合った」として外したと言う", () => {
    const match = matchBackupToWorks(
      { site: "narou", workId: "n0000zy", title: "教科書チート〜別視点バージョン〜" },
      [
        work("a", "教科書チート", [{ site: "narou", workId: "n2600go" }]),
        work("b", "肉片とラジオと心霊現象", [{ site: "narou", workId: "n4190fx" }]),
      ]
    );

    expect(match).toEqual({
      kind: "none",
      differentId: [{ workId: "a", by: "partial" }],
    });
  });

  it("どれにも当たらなければ none", () => {
    const match = matchBackupToWorks(NAROU, [
      work("a", "教科書チート"),
      work("b", "肉片とラジオと心霊現象"),
    ]);

    expect(match).toEqual({ kind: "none", differentId: [] });
  });
});

describe("バックアップから手がかりを取り出す", () => {
  it("なろうの合本から、Nコード（小文字）と【タイトル】を採る", () => {
    const text = [
      "【Nコード】",
      "N5078JI",
      "",
      "【タイトル】",
      "眠りから覚めたら：未来",
      "",
      "------------------------- エピソード1開始 -------------------------",
      "【エピソードタイトル】",
      "１話　目覚め",
      "",
      "【本文】",
      "本文。",
      "",
    ].join("\n");
    const inspection = inspectWorkBackup(
      zipSync({ "N5078JI.txt": new TextEncoder().encode(text) }),
      "N5078JI.zip"
    );

    const identity = backupIdentityOf(inspection);

    expect(identity.site).toBe("narou");
    expect(identity.workId).toBe("n5078ji");
    // 照らすには、記号を落とす前の題を使う
    expect(identity.title).toBe("眠りから覚めたら：未来");
  });

  it("題をそろえた形は、比べるためだけのもの", () => {
    expect(normalizeWorkTitle(" 教科書　チート ")).toBe("教科書チート");
    expect(normalizeWorkTitle("ｶﾀｶﾅ")).toBe("カタカナ");
  });
});
