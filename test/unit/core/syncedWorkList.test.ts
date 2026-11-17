import { describe, expect, test } from "vitest";
import {
  cleanRemoteUrl,
  comparisonKey,
  mergeLocalWorks,
  readSyncedWorkList,
  removeSyncedWork,
  toStoredList,
  worksMissingHere,
  type SyncedWork,
} from "../../../src/core/syncedWorkList";

/**
 * 作品の一覧を VS Code の設定の同期で運ぶ（設計書5.5.11.1）。
 *
 * 運ぶのは作品の名前と GitHub の URL だけ。鍵・トークン・フォルダーの場所は運ばない。
 * 同期は最後に書いた機械が勝つので、届いている一覧へこの機械の分を足す（和集合）。
 */

const A: SyncedWork = {
  title: "星の海",
  remoteUrl: "https://github.com/nonahisa/hoshi.git",
  addedAt: "2026-11-01T00:00:00.000Z",
};
const B: SyncedWork = {
  title: "別の機械の作品",
  remoteUrl: "https://github.com/nonahisa/betsu",
  addedAt: "2026-11-02T00:00:00.000Z",
};

describe("URL の清め", () => {
  test("トークン入りの URL から資格情報を外す", () => {
    expect(cleanRemoteUrl("https://user:ghp_secret123@github.com/owner/repo.git")).toBe(
      "https://github.com/owner/repo.git"
    );
    expect(cleanRemoteUrl("https://ghp_secret123@github.com/owner/repo")).toBe(
      "https://github.com/owner/repo"
    );
  });

  test("GitHub Enterprise のホストはそのまま残す。末尾の / は外す", () => {
    expect(cleanRemoteUrl("https://ghe.example.co.jp/team/novel/")).toBe(
      "https://ghe.example.co.jp/team/novel"
    );
  });

  test("SSH・http・形の違うものは載せない", () => {
    expect(cleanRemoteUrl("git@github.com:owner/repo.git")).toBeUndefined();
    expect(cleanRemoteUrl("ssh://git@github.com/owner/repo.git")).toBeUndefined();
    expect(cleanRemoteUrl("http://github.com/owner/repo.git")).toBeUndefined();
    expect(cleanRemoteUrl("https://github.com/owner")).toBeUndefined();
    expect(cleanRemoteUrl("https://github.com/group/sub/repo")).toBeUndefined();
    expect(cleanRemoteUrl("https://github.com/owner/repo?token=abc")).toBeUndefined();
    expect(cleanRemoteUrl("C:\\novels\\work")).toBeUndefined();
    expect(cleanRemoteUrl("")).toBeUndefined();
  });

  test("比べる鍵は、ホスト＋所有者＋名前を小文字にし、末尾の .git と / を外した形", () => {
    expect(comparisonKey("https://GitHub.com/Owner/Repo.git")).toBe("github.com/owner/repo");
    expect(comparisonKey("https://github.com/owner/repo/")).toBe("github.com/owner/repo");
    expect(comparisonKey("https://u:t@github.com/owner/repo")).toBe("github.com/owner/repo");
  });

  test("比べるときだけは SSH の形も鍵にする（この機械に SSH で置いた作品を、ほかの機械の作品と見ない）", () => {
    expect(comparisonKey("git@github.com:Owner/Repo.git")).toBe("github.com/owner/repo");
    expect(comparisonKey("ssh://git@github.com/owner/repo.git")).toBe("github.com/owner/repo");
    expect(comparisonKey("C:\\novels\\work")).toBeUndefined();
  });
});

describe("合わせ方（和集合）", () => {
  test("別の機械の分は消えず、この機械の分が足される", () => {
    const merged = mergeLocalWorks(
      [B],
      [{ title: "星の海", remoteUrl: "https://github.com/nonahisa/hoshi.git" }],
      "2026-11-17T00:00:00.000Z"
    );
    expect(merged.map((work) => work.title)).toEqual(["別の機械の作品", "星の海"]);
    expect(merged[1].addedAt).toBe("2026-11-17T00:00:00.000Z");
  });

  test("同じ鍵があれば名前だけこの機械の名前に替える（足した日時と URL は保つ）", () => {
    const merged = mergeLocalWorks(
      [A, B],
      [{ title: "星の海（改題）", remoteUrl: "https://u:tok@GITHUB.com/nonahisa/hoshi/" }],
      "2026-11-17T00:00:00.000Z"
    );
    expect(merged).toEqual([{ ...A, title: "星の海（改題）" }, B]);
  });

  test("この機械に無いものを消さない（登録を外しても一覧には残る）", () => {
    expect(mergeLocalWorks([A, B], [], "2026-11-17T00:00:00.000Z")).toEqual([A, B]);
  });

  test("トークン入り・SSH の作品は、清めた形で載るか、載らないか", () => {
    const merged = mergeLocalWorks(
      [],
      [
        { title: "鍵つき", remoteUrl: "https://x:ghp_abc@github.com/o/keyed.git" },
        { title: "SSH", remoteUrl: "git@github.com:o/ssh.git" },
      ],
      "2026-11-17T00:00:00.000Z"
    );
    expect(merged).toEqual([
      { title: "鍵つき", remoteUrl: "https://github.com/o/keyed.git", addedAt: "2026-11-17T00:00:00.000Z" },
    ]);
    expect(JSON.stringify(merged)).not.toContain("ghp_abc");
  });

  test("1つのリポジトリに作品が複数（書庫）なら、最初の作品の名前に「ほかN作品」を添えて1行にする", () => {
    const merged = mergeLocalWorks(
      [],
      [
        { title: "一作目", remoteUrl: "https://github.com/o/library.git" },
        { title: "二作目", remoteUrl: "https://github.com/o/library.git" },
        { title: "三作目", remoteUrl: "https://github.com/o/library" },
      ],
      "2026-11-17T00:00:00.000Z"
    );
    expect(merged.map((work) => work.title)).toEqual(["一作目ほか2作品"]);
  });

  test("何度当てても同じ結果になる（書き直しのたびに当て直すため）", () => {
    const local = [{ title: "星の海", remoteUrl: "https://github.com/nonahisa/hoshi.git" }];
    const once = mergeLocalWorks([B], local, "2026-11-17T00:00:00.000Z");
    const twice = mergeLocalWorks(once, local, "2026-11-18T00:00:00.000Z");
    expect(twice).toEqual(once);
  });

  test("［一覧から外す］は鍵で外す", () => {
    expect(removeSyncedWork([A, B], "https://github.com/NONAHISA/hoshi")).toEqual([B]);
  });
});

describe("この機械に無い作品", () => {
  test("この機械の作品のリモートに無いものだけを選ぶ（SSH で置いた作品も、ある方に数える）", () => {
    expect(worksMissingHere([A, B], ["git@github.com:nonahisa/hoshi.git"])).toEqual([B]);
    expect(worksMissingHere([A, B], [])).toEqual([A, B]);
  });

  test("別の機械が書いた行でも、清めの通らない URL は並べない", () => {
    const tainted: SyncedWork = { ...B, remoteUrl: "git@github.com:o/x.git" };
    expect(worksMissingHere([tainted], [])).toEqual([]);
  });
});

describe("読み込みと壊れた中身", () => {
  test("まだ何も無ければ空として読める", () => {
    expect(readSyncedWorkList(undefined)).toEqual({ ok: true, works: [] });
  });

  test("正しい形なら読める", () => {
    expect(readSyncedWorkList(toStoredList([A, B]))).toEqual({ ok: true, works: [A, B] });
  });

  test.each([
    ["文字列", "壊れた"],
    ["配列", []],
    ["works が無い", { version: 1 }],
    ["新しいバージョンが書いた一覧", { version: 2, works: [] }],
    ["行の形が違う", { version: 1, works: [{ title: 1, remoteUrl: "x", addedAt: "" }] }],
    ["行に資格情報が入っている", { version: 1, works: [{ ...A, remoteUrl: "https://u:t@github.com/o/r" }] }],
  ])("%s は読めないと返す（空と扱い、書き戻さない）", (_label, value) => {
    const result = readSyncedWorkList(value);
    expect(result.ok).toBe(false);
  });
});
