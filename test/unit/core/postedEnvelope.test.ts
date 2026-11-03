import { describe, expect, test } from "vitest";
import {
  parsePostedClipboard,
  planOutlineEpisodeIds,
  planSiteEpisodeId,
  postedTitleMatches,
} from "../../../src/core/postedEnvelope";
import { emptyPostingLedger, type PostingLedger } from "../../../src/models/posting";
import type { LocalOutlineEpisode, OutlineEpisode } from "../../../src/core/chapterOutline";

/**
 * ヘルパーから届く投稿した話の番号（`novelai-posted` v1。設計書6.68.8）。
 *
 * **別プロジェクトとの約束事**なので、欄の形を往復で固める。直して受け取らない——
 * 版違い・番号の桁の崩れ・札の崩れは、理由を言って止まる。
 */

const kakuyomu = {
  "novelai-posted": 1,
  site: "kakuyomu",
  workId: "16816927859000000000",
  episodeId: "16816927859000000123",
  title: "第13話 星の落ちる夜",
  postRef: "k7Qm2xP9",
  readAt: "2026-11-03T21:40:00.000+09:00",
};

function parse(value: unknown) {
  return parsePostedClipboard(JSON.stringify(value));
}

describe("封筒を読む", () => {
  test("カクヨム：欄がそのまま読める（番号は文字列のまま。20桁でも桁が落ちない）", () => {
    const result = parse(kakuyomu);
    expect(result).toEqual({
      ok: true,
      envelope: {
        site: "kakuyomu",
        workId: "16816927859000000000",
        episodeId: "16816927859000000123",
        title: "第13話 星の落ちる夜",
        postRef: "k7Qm2xP9",
        readAt: "2026-11-03T21:40:00.000+09:00",
      },
    });
  });

  test("アルファポリス：札と題は省いてよい", () => {
    const result = parse({
      "novelai-posted": 1,
      site: "alphapolis",
      workId: "123456789",
      episodeId: "987654",
      readAt: "2026-11-03T21:40:00.000+09:00",
    });
    expect(result.ok && result.envelope).toEqual({
      site: "alphapolis",
      workId: "123456789",
      episodeId: "987654",
      readAt: "2026-11-03T21:40:00.000+09:00",
    });
  });

  test("なろう：小説番号が要り、話の番号は省いてよい。作品ID・題・札は読まない", () => {
    const top = parse({ "novelai-posted": 1, site: "narou", novelNo: "1234567", readAt: "x" });
    expect(top.ok && top.envelope).toEqual({ site: "narou", novelNo: "1234567", readAt: "x" });

    const withEpisode = parse({
      "novelai-posted": 1,
      site: "narou",
      novelNo: "1234567",
      episodeId: "8765432",
      workId: "n1234ab",
      title: "題",
      postRef: "abc",
      readAt: "x",
    });
    expect(withEpisode.ok && withEpisode.envelope).toEqual({
      site: "narou",
      novelNo: "1234567",
      episodeId: "8765432",
      readAt: "x",
    });
  });

  test("なろうで小説番号が無い・数字でないときは止まる", () => {
    expect(parse({ "novelai-posted": 1, site: "narou", readAt: "x" }).ok).toBe(false);
    const bad = parse({ "novelai-posted": 1, site: "narou", novelNo: "n1234ab", readAt: "x" });
    expect(bad.ok === false && bad.kind).toBe("invalid");
  });

  test("版が違えば、両方を新しくするよう言って止まる", () => {
    const result = parse({ ...kakuyomu, "novelai-posted": 2 });
    expect(result.ok === false && result.kind === "invalid" && result.reason).toContain("両方を新しく");
  });

  test("知らないサイト（note）は止まる", () => {
    const result = parse({ ...kakuyomu, site: "note" });
    expect(result.ok === false && result.kind).toBe("invalid");
  });

  test("話の番号が数字でない・数値で来た・31桁は止まる", () => {
    for (const episodeId of ["12a", 16816927859000000123, "1".repeat(31), ""]) {
      const result = parse({ ...kakuyomu, episodeId });
      expect(result.ok === false && result.kind, String(episodeId)).toBe("invalid");
    }
  });

  test("カクヨム・アルファポリスで作品ID・話の番号が無ければ止まる", () => {
    const { workId: _w, ...noWork } = kakuyomu;
    const { episodeId: _e, ...noEpisode } = kakuyomu;
    expect(parse(noWork).ok).toBe(false);
    expect(parse(noEpisode).ok).toBe(false);
  });

  test("札の形が崩れていれば封筒ごと断る", () => {
    for (const postRef of ["", "a/b", "x".repeat(65), 12]) {
      const result = parse({ ...kakuyomu, postRef });
      expect(result.ok === false && result.kind, String(postRef)).toBe("invalid");
    }
  });

  test("この封筒でないもの（本文・ほかの封筒・壊れたJSON）は中身に触れずに notFound", () => {
    for (const text of ["本文です", '{"novelai-post":1}', "{壊れた", "[1,2]"]) {
      expect(parsePostedClipboard(text)).toEqual({ ok: false, kind: "notFound" });
    }
  });

  test("題の制御文字は落とし、200字で切る", () => {
    const result = parse({ ...kakuyomu, title: `題\u0007${"あ".repeat(300)}` });
    expect(result.ok && result.envelope.title).toBe(`題${"あ".repeat(199)}`);
  });
});

function ledgerWith(posts: PostingLedger["posts"]): PostingLedger {
  return { ...emptyPostingLedger(), posts };
}

describe("番号を入れてよいか", () => {
  const post = (episodePath: string, siteEpisodeId?: string) => ({
    episodePath,
    site: "kakuyomu" as const,
    postedAt: "2026-11-03T00:00:00.000Z",
    ...(siteEpisodeId ? { siteEpisodeId } : {}),
  });

  test("番号の無い話には入れる・同じなら書かない・別の番号なら替えない", () => {
    expect(planSiteEpisodeId(ledgerWith([post("本文/013.txt")]), "本文/013.txt", "kakuyomu", "5").kind).toBe("add");
    expect(planSiteEpisodeId(ledgerWith([post("本文/013.txt", "5")]), "本文/013.txt", "kakuyomu", "5").kind).toBe("same");
    expect(planSiteEpisodeId(ledgerWith([post("本文/013.txt", "4")]), "本文/013.txt", "kakuyomu", "5")).toEqual({
      kind: "replace",
      existing: "4",
    });
  });

  test("同じ番号を別の話が持っていれば書かない（取り違えの疑い）", () => {
    const plan = planSiteEpisodeId(
      ledgerWith([post("本文/012.txt", "5"), post("本文/013.txt")]),
      "本文/013.txt",
      "kakuyomu",
      "5"
    );
    expect(plan).toEqual({ kind: "taken", holder: "本文/012.txt" });
  });

  test("投稿の記録が無ければ付ける先が無い", () => {
    expect(planSiteEpisodeId(ledgerWith([]), "本文/013.txt", "kakuyomu", "5").kind).toBe("noPost");
  });
});

describe("題で照らす", () => {
  test("空白と全角半角の違いだけ揃え、ちょうど同じ題だけを拾う", () => {
    const candidates = [
      { id: 1, titles: ["第13話　星の落ちる夜"] },
      { id: 2, titles: ["第14話 星の落ちる夜明け"] },
    ];
    expect(postedTitleMatches(candidates, "第１３話 星の落ちる夜").map((c) => c.id)).toEqual([1]);
    expect(postedTitleMatches(candidates, "星の落ちる")).toEqual([]);
    expect(postedTitleMatches(candidates, undefined)).toEqual([]);
  });
});

describe("章立ての番号を投稿の記録へ写す計画", () => {
  const outline: OutlineEpisode[] = [
    { label: "1話", number: 1, title: "潮", part: null, episodeId: "101" },
    { label: "2話", number: 2, title: "地図", part: null, episodeId: "102" },
    { label: "3話", number: 3, title: "嵐", part: null, episodeId: "103" },
    { label: "4話", number: 4, title: "船", part: null },
    { label: "5話", number: 5, title: "灯", part: null, episodeId: "105" },
  ];
  const local = (n: number): LocalOutlineEpisode => ({
    relPath: `本文/00${n}.txt`,
    indexInFile: 0,
    number: n,
    title: null,
    label: `第${n}話`,
  });

  test("番号の無い話へ入れ、別の番号は替えずに分け、記録の無い・照らせない話は数える", () => {
    const ledger = ledgerWith([
      { episodePath: "本文/001.txt", site: "kakuyomu", postedAt: "x" },
      { episodePath: "本文/002.txt", site: "kakuyomu", postedAt: "x", siteEpisodeId: "102" },
      { episodePath: "本文/003.txt", site: "kakuyomu", postedAt: "x", siteEpisodeId: "99" },
    ]);
    const plan = planOutlineEpisodeIds(
      outline,
      [local(1), local(2), local(3), local(4), undefined],
      ledger,
      "kakuyomu"
    );
    expect(plan.add.map((entry) => entry.episodeId)).toEqual(["101"]);
    expect(plan.same).toBe(1);
    expect(plan.replace).toEqual([
      { target: "本文/003.txt", label: "第3話", episodeId: "103", existing: "99" },
    ]);
    expect(plan.noPost).toBe(0);
    expect(plan.unmatched).toBe(1);
  });

  test("合本の中の話は、投稿キットと同じ鍵（話数）で指す", () => {
    const ledger = ledgerWith([
      { episodePath: "本文/合本.txt", site: "kakuyomu", postedAt: "x", chapter: 2 },
    ]);
    const collected: LocalOutlineEpisode = {
      relPath: "本文/合本.txt",
      indexInFile: 1,
      number: 2,
      title: null,
      label: "合本の2話",
      collected: { chapter: 2, order: 2 },
    };
    const plan = planOutlineEpisodeIds([outline[1]], [collected], ledger, "kakuyomu");
    expect(plan.add).toHaveLength(1);
    expect(plan.add[0].target).toEqual({ episodePath: "本文/合本.txt", chapter: 2, order: 2 });
  });

  test("同じ封筒の中で同じ番号が2つの話に来たら、あとの方は書かない", () => {
    const ledger = ledgerWith([
      { episodePath: "本文/001.txt", site: "kakuyomu", postedAt: "x" },
      { episodePath: "本文/002.txt", site: "kakuyomu", postedAt: "x" },
    ]);
    const plan = planOutlineEpisodeIds(
      [
        { ...outline[0], episodeId: "7" },
        { ...outline[1], episodeId: "7" },
      ],
      [local(1), local(2)],
      ledger,
      "kakuyomu"
    );
    expect(plan.add).toHaveLength(1);
    expect(plan.taken).toHaveLength(1);
  });
});
