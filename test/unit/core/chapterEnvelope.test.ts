import { describe, expect, it } from "vitest";
import {
  CHAPTERS_ENVELOPE_VERSION,
  CHAPTERS_MARKER,
  parseChaptersClipboard,
} from "../../../src/core/chapterEnvelope";
import { outlineSections } from "../../../src/core/chapterOutline";
import {
  CHAPTERS_IMPORT_URI_PATH,
  readerStatsUriAction,
} from "../../../src/core/readerStatsHelperLink";

/**
 * ヘルパーから届く章立て（`novelai-chapters` v1。残課題 B7）。
 *
 * カクヨムのバックアップには章が入っていない。章は作品管理の画面の「大見出し」にだけ
 * あるので、ヘルパー（Chrome 拡張）がその画面を読んでクリップボードへ置き、
 * `vscode://…/import-chapters` で VS Code を前に出す。**データはリンクに載らない。**
 *
 * 題は架空。
 */

function envelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    [CHAPTERS_MARKER]: CHAPTERS_ENVELOPE_VERSION,
    site: "kakuyomu",
    workId: "1177354054000000000",
    pageUrl: "https://kakuyomu.jp/my/works/1177354054000000000",
    readAt: "2026-09-24T09:00:00.000+09:00",
    episodes: [
      { heading: "１話　潮の匂い", part: "第一章『岬』" },
      { heading: "２話　古い地図", part: "第一章『岬』" },
      { heading: "３話　嵐の夜", part: "第二章『灯』" },
    ],
    ...overrides,
  });
}

describe("章立ての封筒を読む", () => {
  it("話の並びと章の題を、バックアップと同じ形（OutlineEpisode）にする", () => {
    const parsed = parseChaptersClipboard(envelope());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.site).toBe("kakuyomu");
    expect(parsed.workId).toBe("1177354054000000000");
    expect(parsed.outline[2]).toEqual({
      label: "３話　嵐の夜",
      number: 3,
      title: "嵐の夜",
      part: "第二章『灯』",
    });
    expect(outlineSections(parsed.outline).map((section) => section.name)).toEqual([
      "第一章『岬』",
      "第二章『灯』",
    ]);
  });

  it("封筒でないものは notFound（中身には触れない）", () => {
    expect(parseChaptersClipboard("ただの文章").ok).toBe(false);
    expect(parseChaptersClipboard('{"novelai-stats":1}')).toEqual({
      ok: false,
      kind: "notFound",
    });
  });

  it("版が違う・知らないサイト・形が崩れている封筒は、理由を言って止める（直して読まない）", () => {
    for (const bad of [
      envelope({ [CHAPTERS_MARKER]: 2 }),
      envelope({ site: "somewhere" }),
      envelope({ episodes: "三話" }),
      envelope({ episodes: [{ heading: 3, part: null }] }),
    ]) {
      const parsed = parseChaptersClipboard(bad);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.kind).toBe("invalid");
    }
  });

  it("話が1つも無い封筒は、取り込むものが無いと言う", () => {
    const parsed = parseChaptersClipboard(envelope({ episodes: [] }));
    expect(parsed).toMatchObject({ ok: false, kind: "invalid" });
  });

  it("制御文字は落とし、長すぎる題は切る（誰が作ったか分からない文字列）", () => {
    const parsed = parseChaptersClipboard(
      envelope({
        episodes: [{ heading: "１話\u0007　潮の匂い", part: "章".repeat(500) }],
      })
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.outline[0].title).toBe("潮の匂い");
    expect((parsed.outline[0].part ?? "").length).toBeLessThanOrEqual(200);
  });
});

describe("受け口のパス", () => {
  it("/import-chapters は章立ての合図", () => {
    expect(CHAPTERS_IMPORT_URI_PATH).toBe("/import-chapters");
    expect(readerStatsUriAction("/import-chapters")).toBe("chapters");
    expect(readerStatsUriAction("/import-chapters/")).toBe("chapters");
    expect(readerStatsUriAction("/Import-Chapters")).toBeUndefined();
  });
});
