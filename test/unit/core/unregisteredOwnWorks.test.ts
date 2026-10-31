import { describe, expect, test } from "vitest";
import {
  backupEntryFor,
  checkBackupAgainstOwnWork,
  hideUnregisteredOwnWork,
  looksLikeBackupOf,
  narouBackupIdFrom,
  noteUnregisteredOwnWorks,
  readUnregisteredOwnWorks,
  registeredSiteWorkKeys,
  setNarouBackupId,
  visibleUnregisteredOwnWorks,
  type UnregisteredOwnWork,
} from "../../../src/core/unregisteredOwnWorks";
import type { ReaderStatsEnvelope } from "../../../src/core/readerStatsEnvelope";
import { emptyPostingLedger, withSiteProfile } from "../../../src/models/posting";

/**
 * ヘルパーで「自分の作品」と読んだが未登録の作品を、作品一覧に枠だけ出す
 * （作者の指示 2026-11-01。設計書6.99.8）。
 *
 * - 枠に出るのは、本人しか開けない画面（`ownedVia: "owner-page"`）で読んだものだけ
 * - 登録済み（台帳のサイトと作品IDが同じ）・出さないを選んだものは出ない
 * - バックアップの入口の URL はサイトごとに正しい。なろうの数字ID が無ければ訊く
 * - 届いたファイルは、この作品のバックアップらしい名前のものだけ拾う
 * - 取り込む前に中身を照らし、食い違えば止める
 */

function envelope(over: Partial<ReaderStatsEnvelope> = {}): ReaderStatsEnvelope {
  return {
    format: "novelai-stats",
    version: 1,
    site: "kakuyomu",
    workId: "16818093000000000001",
    readAt: "2026-11-01T10:00:00.000Z",
    title: "氷の街の約束",
    ownedVia: "owner-page",
    entries: [],
    ...over,
  } as ReaderStatsEnvelope;
}

describe("覚える作品", () => {
  test("本人しか開けない画面で読んだ作品を覚える（数は覚えない）", () => {
    const list = noteUnregisteredOwnWorks([], [envelope()]);
    expect(list).toEqual([
      {
        site: "kakuyomu",
        workId: "16818093000000000001",
        title: "氷の街の約束",
        ownedVia: "owner-page",
        lastSeenAt: "2026-11-01T10:00:00.000Z",
      },
    ]);
  });

  test("作者が認めただけの作品（approved）・覚えた理由の無い封筒・Narou.fun からの封筒は覚えない", () => {
    expect(noteUnregisteredOwnWorks([], [envelope({ ownedVia: "approved" })])).toEqual([]);
    expect(noteUnregisteredOwnWorks([], [envelope({ ownedVia: undefined })])).toEqual([]);
    expect(
      noteUnregisteredOwnWorks([], [envelope({ site: "narou", source: "narou.fun" })])
    ).toEqual([]);
    expect(noteUnregisteredOwnWorks([], [envelope({ workId: undefined })])).toEqual([]);
  });

  test("同じ作品が届き直したら、最後に見た日時と題だけを新しくする（出さないの印・数字IDは残す）", () => {
    let list = noteUnregisteredOwnWorks([], [envelope({ site: "narou", workId: "n1234ab" })]);
    list = setNarouBackupId(list, "narou", "n1234ab", "1702430");
    list = hideUnregisteredOwnWork(list, "narou", "N1234AB");
    const next = noteUnregisteredOwnWorks(list, [
      envelope({ site: "narou", workId: "N1234AB", title: "新しい題", readAt: "2026-11-02T00:00:00.000Z" }),
    ]);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      title: "新しい題",
      lastSeenAt: "2026-11-02T00:00:00.000Z",
      hidden: true,
      narouBackupId: "1702430",
    });
  });

  test("変わらなければ同じ配列を返す（保管庫へ書かずに済む）", () => {
    const list = noteUnregisteredOwnWorks([], [envelope()]);
    expect(noteUnregisteredOwnWorks(list, [envelope()])).toBe(list);
    // 古い封筒で巻き戻さない
    expect(noteUnregisteredOwnWorks(list, [envelope({ readAt: "2026-10-01T00:00:00.000Z" })])).toBe(list);
  });

  test("保管庫の値の形が違う項目は捨てる（全体は捨てない）", () => {
    expect(
      readUnregisteredOwnWorks([
        { site: "kakuyomu", workId: "1", ownedVia: "owner-page", lastSeenAt: "2026-11-01" },
        { site: "x", workId: "2", ownedVia: "owner-page", lastSeenAt: "2026-11-01" },
        { site: "kakuyomu", workId: "3", ownedVia: "approved", lastSeenAt: "2026-11-01" },
        "壊れた",
      ]).map((entry) => entry.workId)
    ).toEqual(["1"]);
    expect(readUnregisteredOwnWorks(undefined)).toEqual([]);
  });
});

describe("枠に出す作品", () => {
  const list: UnregisteredOwnWork[] = [
    { site: "kakuyomu", workId: "111", title: "登録済みの作品", ownedVia: "owner-page", lastSeenAt: "x" },
    { site: "kakuyomu", workId: "222", title: "未登録の作品", ownedVia: "owner-page", lastSeenAt: "x" },
    { site: "narou", workId: "n5555aa", title: "出さない作品", ownedVia: "owner-page", lastSeenAt: "x", hidden: true },
    { site: "narou", workId: "N7777BB", title: "なろうの作品", ownedVia: "owner-page", lastSeenAt: "x" },
  ];

  test("登録済み（台帳のサイトと作品IDが同じ）・出さないを選んだものは出ない", () => {
    const registered = registeredSiteWorkKeys([
      withSiteProfile(emptyPostingLedger(), "kakuyomu", { workId: "111" }),
      // なろうの大文字小文字は台帳の照合と同じくそろえる
      withSiteProfile(emptyPostingLedger(), "narou", { workId: "n7777bb" }),
    ]);
    expect(visibleUnregisteredOwnWorks(list, registered).map((entry) => entry.title)).toEqual([
      "未登録の作品",
    ]);
  });

  test("別のサイトの同じ番号は登録済みと見ない", () => {
    const registered = registeredSiteWorkKeys([
      withSiteProfile(emptyPostingLedger(), "alphapolis", { workId: "222" }),
    ]);
    expect(visibleUnregisteredOwnWorks(list, registered).map((entry) => entry.workId)).toContain("222");
  });
});

describe("バックアップの入口", () => {
  test("アルファポリスは9桁の作品IDで書き出しの URL（押すとそのまま落ちる）", () => {
    expect(backupEntryFor("alphapolis", "123456789")).toEqual({
      kind: "download",
      url: "https://www.alphapolis.co.jp/mypage/novel/export/123456789/UTF-8/LF",
    });
    expect(backupEntryFor("alphapolis", "12345678").kind).toBe("unsupported");
  });

  test("カクヨムは作品管理の画面（メニューの「小説をバックアップ」から）", () => {
    const entry = backupEntryFor("kakuyomu", "16818093000000000001");
    expect(entry).toEqual({
      kind: "page",
      url: "https://kakuyomu.jp/my/works/16818093000000000001",
      hint: "メニューの「小説をバックアップ」から",
    });
    expect(backupEntryFor("kakuyomu", "abc").kind).toBe("unsupported");
  });

  test("なろうは数字ID が無ければ訊く。あればバックアップの画面", () => {
    expect(backupEntryFor("narou", "n1234ab")).toEqual({ kind: "needNarouId" });
    expect(backupEntryFor("narou", "n1234ab", "1702430")).toEqual({
      kind: "download",
      url: "https://syosetu.com/backup/top/ncode/1702430/",
    });
  });

  test("note にはバックアップが無い", () => {
    expect(backupEntryFor("note", "abc").kind).toBe("unsupported");
  });

  test("なろうの数字ID は数字かなろうのアドレスから読む。Nコードや別のサイトは受けない", () => {
    expect(narouBackupIdFrom("1702430")).toBe("1702430");
    expect(narouBackupIdFrom("　１７０２４３０　")).toBe("1702430");
    expect(narouBackupIdFrom("https://syosetu.com/backup/top/ncode/1702430/")).toBe("1702430");
    expect(narouBackupIdFrom("https://syosetu.com/usernovelmanage/top/ncode/1702430/")).toBe("1702430");
    expect(narouBackupIdFrom("n1234ab")).toBeUndefined();
    expect(narouBackupIdFrom("https://example.com/ncode/1702430/")).toBeUndefined();
    expect(narouBackupIdFrom("")).toBeUndefined();
  });
});

describe("届いたファイルの名前", () => {
  const kakuyomu = { site: "kakuyomu" as const, workId: "1", title: "転生した受験生の異世界成り上がり　～別視点バージョン～" };
  const alphapolis = {
    site: "alphapolis" as const,
    workId: "123456789",
    title: "転生受験生の教科書チート生活　～その知識、学校で習いましたよ？～",
  };
  const narou = { site: "narou" as const, workId: "n4190fx", title: "まったく別の題" };

  test("実物の名前の形を拾う（カクヨムの題の頭＋日付・アルファポリスの題＋重複の印・なろうのNコード）", () => {
    expect(looksLikeBackupOf("転生した受験生の異世界成り上がり　～別視点バージョ_20260919.zip", kakuyomu)).toBe(true);
    expect(looksLikeBackupOf("転生受験生の教科書チート生活　～その知識、学校で習いましたよ？～ (1).txt", alphapolis)).toBe(true);
    expect(looksLikeBackupOf("N4190FX.zip", narou)).toBe(true);
  });

  test("別の名前・書きかけ・取り込めない拡張子は拾わない", () => {
    expect(looksLikeBackupOf("novel-ai-assistant.zip", kakuyomu)).toBe(false);
    expect(looksLikeBackupOf("N1111IR.zip", narou)).toBe(false);
    expect(looksLikeBackupOf("転生した受験生の異世界成り上がり.zip.crdownload", kakuyomu)).toBe(false);
    expect(looksLikeBackupOf("転生した受験生の異世界成り上がり.pdf", kakuyomu)).toBe(false);
    // 題の頭が短すぎる名前では決めない
    expect(looksLikeBackupOf("転生.zip", kakuyomu)).toBe(false);
  });
});

describe("取り込む前に照らす", () => {
  const target = { site: "kakuyomu" as const, workId: "1", title: "氷の街の約束" };

  test("題とサイトが合えば通す", () => {
    expect(checkBackupAgainstOwnWork({ site: "kakuyomu", workId: null, title: "氷の街の約束" }, target)).toEqual({ ok: true });
    // サイトを見分けられなかったバックアップも、題で照らす
    expect(checkBackupAgainstOwnWork({ site: null, workId: null, title: "氷の街の　約束" }, target).ok).toBe(true);
  });

  test("サイトが違えば止める", () => {
    const check = checkBackupAgainstOwnWork({ site: "narou", workId: "n1111aa", title: "氷の街の約束" }, target);
    expect(check.ok).toBe(false);
  });

  test("題が違う・一部だけ同じなら止める", () => {
    expect(checkBackupAgainstOwnWork({ site: "kakuyomu", workId: null, title: "炎の街" }, target).ok).toBe(false);
    const partial = checkBackupAgainstOwnWork(
      { site: "kakuyomu", workId: null, title: "氷の街の約束　～別視点バージョン～" },
      target
    );
    expect(partial.ok).toBe(false);
    if (!partial.ok) expect(partial.reason).toContain("一部だけ");
  });

  test("なろうは Nコードで照らす（題が違っても Nコードが同じなら通し、違えば止める）", () => {
    const narou = { site: "narou" as const, workId: "n1234ab", title: "古い題" };
    expect(checkBackupAgainstOwnWork({ site: "narou", workId: "n1234ab", title: "新しい題" }, narou).ok).toBe(true);
    expect(checkBackupAgainstOwnWork({ site: "narou", workId: "n9999zz", title: "古い題" }, narou).ok).toBe(false);
  });

  test("枠に題が無ければ（なろう以外）照らせないので止める", () => {
    expect(
      checkBackupAgainstOwnWork({ site: "kakuyomu", workId: null, title: "何か" }, { site: "kakuyomu", workId: "1" }).ok
    ).toBe(false);
  });
});
