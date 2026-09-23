import { describe, expect, test } from "vitest";
import {
  emptyPostingLedger,
  isPosted,
  parsePostingLedger,
  postingEpisodeKey,
  unpostedSites,
  withBaselinePosts,
  withPost,
  withSites,
  type PostingLedger,
} from "../../src/models/posting";

/**
 * 投稿の記録を「話単位」で引く（設計書6.68.2・6.12.1）。
 *
 * 合本（1ファイルに全話）からは**1話だけ**をコピーして投稿するのに、
 * 台帳はファイル単位だった。第3話だけ出したあと同じ合本を選ぶと
 * 「すべてのサイトへ投稿済みです」と出て、第4話が出せなかった。
 *
 * **古い記録（ファイル単位）は「そのファイルの全話を投稿済み」と読む。**
 * 0.48.1 より前は実際に全話ぶんの本文をコピーしていたので、その読みが
 * 当時の事実と合う。
 */

const url = {
  narou: "https://syosetu.com/usernovelmanage/isnoveluploadmenu/ncode/n1234ab/",
  kakuyomu: "https://kakuyomu.jp/my/works/1177354054892/episodes/new",
};

const registered: PostingLedger = withSites(emptyPostingLedger(), [
  { site: "narou", newEpisodeUrl: url.narou },
  { site: "kakuyomu", newEpisodeUrl: url.kakuyomu },
]);

const at = "2026-09-12T00:00:00.000Z";
const collected = "本文/全話.txt";

describe("話単位の鍵", () => {
  /**
   * **合本でないファイルの鍵は、これまでと同じ文字列のまま。**
   * ここが変わると、既にある台帳の記録が別の話を指すことになる。
   */
  test("ファイルまるごとの鍵は、相対パスそのもの", () => {
    expect(postingEpisodeKey("本文/001.txt")).toBe("本文/001.txt");
    expect(postingEpisodeKey({ episodePath: "本文/001.txt" })).toBe(
      "本文/001.txt"
    );
  });

  test("パスの区切りは揃えて引く（台帳の読みと同じ正規化）", () => {
    expect(postingEpisodeKey("本文\\001.txt")).toBe("本文/001.txt");
  });

  test("合本の中の話は、ファイルの鍵とも、ほかの話とも別になる", () => {
    const third = postingEpisodeKey({ episodePath: collected, chapter: 3 });
    const fourth = postingEpisodeKey({ episodePath: collected, chapter: 4 });

    expect(third).not.toBe(postingEpisodeKey(collected));
    expect(third).not.toBe(fourth);
  });

  /**
   * 話数が読めない話（「プロローグ」など）は並び順で引く。
   * **並び順を話数として名乗らせない**——「3番目」と「第3話」は別物で、
   * プロローグのある作品では1つずれる。
   */
  test("話数が読めない話は並び順で引き、同じ数字の話数とは別の鍵になる", () => {
    const byOrder = postingEpisodeKey({
      episodePath: collected,
      chapter: null,
      order: 3,
    });
    const byChapter = postingEpisodeKey({ episodePath: collected, chapter: 3 });

    expect(byOrder).not.toBe(byChapter);
    expect(byOrder).not.toBe(postingEpisodeKey(collected));
  });
});

describe("合本の投稿の記録", () => {
  const third = { episodePath: collected, chapter: 3 };
  const fourth = { episodePath: collected, chapter: 4 };

  test("第3話を出しても、第4話は未投稿のまま", () => {
    let ledger = registered;
    for (const site of ["narou", "kakuyomu"] as const) {
      ledger = withPost(ledger, third, site, at);
    }

    expect(unpostedSites(ledger, third)).toEqual([]);
    expect(unpostedSites(ledger, fourth)).toEqual(["narou", "kakuyomu"]);
  });

  test("話単位の記録は、ファイルまるごとを投稿済みにはしない", () => {
    const ledger = withPost(registered, third, "narou", at);

    expect(isPosted(ledger, third, "narou")).toBe(true);
    expect(isPosted(ledger, collected, "narou")).toBe(false);
  });

  test("同じ話を2度記録しても1件（日時は新しいほう）", () => {
    let ledger = withPost(registered, third, "narou", at);
    ledger = withPost(ledger, third, "narou", "2026-09-13T00:00:00.000Z");

    expect(ledger.posts).toHaveLength(1);
    expect(ledger.posts[0].postedAt).toBe("2026-09-13T00:00:00.000Z");
  });

  test("記録には話数が入る（台帳を開いた作者にも、どの話か分かる）", () => {
    const ledger = withPost(registered, third, "narou", at);

    expect(ledger.posts[0].episodePath).toBe(collected);
    expect(ledger.posts[0].chapter).toBe(3);
  });

  test("話数が読めない話は、並び順で記録する（話数は名乗らない）", () => {
    const ledger = withPost(
      registered,
      { episodePath: collected, chapter: null, order: 2 },
      "narou",
      at
    );

    expect(ledger.posts[0].chapter).toBeUndefined();
    expect(ledger.posts[0].order).toBe(2);
  });
});

/**
 * **古い台帳がそのまま読めること。** 0.48.1 までの記録はファイル単位で、
 * そのときは合本の全話ぶんの本文をコピーして投稿していた。だから
 * 「そのファイルの全話を投稿済み」と読むのが当時の事実と合う。
 */
describe("古い記録（ファイル単位）の読み替え", () => {
  test("ファイル単位の記録は、合本のどの話も投稿済みと読む", () => {
    const ledger = withPost(registered, collected, "narou", at);

    expect(isPosted(ledger, { episodePath: collected, chapter: 3 }, "narou")).toBe(
      true
    );
    expect(isPosted(ledger, { episodePath: collected, chapter: 9 }, "narou")).toBe(
      true
    );
    expect(
      isPosted(
        ledger,
        { episodePath: collected, chapter: null, order: 1 },
        "narou"
      )
    ).toBe(true);
  });

  test("基準線（導入時にまとめて入れた記録）も、全話を投稿済みと読む", () => {
    const ledger = withBaselinePosts(
      registered,
      [collected],
      ["narou", "kakuyomu"],
      at
    );

    expect(unpostedSites(ledger, { episodePath: collected, chapter: 5 })).toEqual(
      []
    );
  });

  test("話数の欄が無い台帳のJSONは、これまでどおり読める", () => {
    const ledger = parsePostingLedger({
      schemaVersion: "1",
      sites: [{ site: "narou", newEpisodeUrl: url.narou }],
      posts: [{ episodePath: collected, site: "narou", postedAt: at }],
    });

    expect(ledger.posts[0].chapter).toBeUndefined();
    expect(ledger.posts[0].order).toBeUndefined();
    expect(isPosted(ledger, { episodePath: collected, chapter: 3 }, "narou")).toBe(
      true
    );
  });

  test("話単位の記録は、書いて読み直しても話数が残る", () => {
    const saved = withPost(
      registered,
      { episodePath: collected, chapter: 3 },
      "narou",
      at
    );
    const ledger = parsePostingLedger(JSON.parse(JSON.stringify(saved)));

    expect(ledger.posts[0].chapter).toBe(3);
    expect(isPosted(ledger, { episodePath: collected, chapter: 3 }, "narou")).toBe(
      true
    );
    expect(isPosted(ledger, { episodePath: collected, chapter: 4 }, "narou")).toBe(
      false
    );
  });

  test("壊れた話数（小数・負）は直さずに止める", () => {
    expect(() =>
      parsePostingLedger({
        posts: [
          { episodePath: collected, site: "narou", postedAt: at, chapter: 3.5 },
        ],
      })
    ).toThrow();
  });
});
