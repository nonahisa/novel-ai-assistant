import * as path from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AIRegistry } from "../../../src/ai/registry";
import type { EpisodeFile, WorkEntry } from "../../../src/models/types";
import { env, Uri, window, workspace } from "../support/vscodeStub";
import { memoryFs } from "../support/memoryDisk";
import { postingTextHash, postingTitleHash } from "../../../src/core/postingBodyHash";
import { parseEpisodeFileName } from "../../../src/core/episodeParser";

/**
 * 本文を .md にしただけの話を、「投稿後に直しています」と言わない（設計書6.68.7・6.12.4）。
 *
 * .md 化（`convertOne`）は名前を変え、中のルビ・傍点を投稿サイトの書き方
 * （`｜漢字《かんじ》`・`《《強調》》`）からこの拡張機能の書き方（`{漢字|かんじ}`・`{{強調}}`）へ直す。
 * 本文のバイトは変わるが、読者が読む本文は変わっていない。
 *
 * 再現（0.126.3）：投稿キットで投稿した話を .md 化すると、次の「新話投稿」で
 * 「第1話は投稿後に直しています。出し直しますか」と促していた——投稿したときの印が、
 * ルビの書き方の違いまで「直した」に数えていたため。
 *
 * 投稿の記録は、製品と同じ道（`postNewEpisode`）で作る。印の取り方をテストの側で
 * 決め打ちすると、記録の取り方を変えたときに何を確かめたのか分からなくなる。
 */

const work: WorkEntry = {
  id: "work_md_convert",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "mdconvert"),
  registeredAt: "2026-09-05T00:00:00.000Z",
};

const ledgerPath = Uri.file(path.join(work.folderPath, "設定", "投稿状態.json")).fsPath;

function episodeFile(name: string): EpisodeFile {
  return {
    filePath: path.join(work.folderPath, "本文", name),
    fileName: name,
    ext: path.extname(name),
    chapterStart: 1,
    chapterEnd: 1,
    subtitle: null,
    kind: "本編",
    isInitialName: false,
    counts: { gross: 0, net: 0, lines: 0, paragraphs: 0, manuscriptLines: 0 },
    hasMetadata: false,
    metaTitle: null,
    declaredCharCount: null,
    metaUpdatedAt: null,
    hasConflictMarkers: false,
    collectedCount: null,
  };
}

const episodes: { list: EpisodeFile[] } = { list: [] };

vi.mock("../../../src/core/scanner", () => ({
  scanWork: async () => ({ episodes: episodes.list }),
}));

const { postNewEpisode } = await import("../../../src/features/postingKit");
const { convertOne } = await import("../../../src/features/markdownConvert");
const { setEpisodeRenameWorkLookup } = await import("../../../src/features/episodeLedgers");

const kakuyomuUrl = "https://kakuyomu.jp/my/works/16816927859/episodes/new";

const disk = new Map<string, Uint8Array>();

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function readDisk(filePath: string): string {
  const bytes = disk.get(Uri.file(filePath).fsPath);
  if (!bytes) throw new Error(`${filePath} がありません`);
  return new TextDecoder().decode(bytes);
}

interface PickItem {
  label: string;
  [key: string]: unknown;
}

interface Captured {
  items: PickItem[];
  title: string;
  placeHolder: string;
}

function stubQuickPick(answers: Array<(items: PickItem[]) => unknown>): Captured[] {
  const captured: Captured[] = [];
  let index = 0;
  Object.assign(window, {
    showQuickPick: async (items: PickItem[], options?: { placeHolder?: string; title?: string }) => {
      captured.push({ items, title: options?.title ?? "", placeHolder: options?.placeHolder ?? "" });
      const answer = answers[index++];
      return answer ? answer(items) : undefined;
    },
  });
  return captured;
}

/** 投稿サイトの書き方のルビ・傍点が入った本文（縦線あり・縦線なし・カクヨムの傍点・ルビでの代用） */
const SITE_TEXT = [
  "【タイトル】",
  "｜雪《ゆき》の朝",
  "",
  "【本文】",
  "　｜白銀《しろがね》の街に、雪《ゆき》が降っていた。",
  "　《《それ》》は、｜誰《・》も知らない約束だった。",
].join("\r\n");

describe("本文を .md にしただけの話は、出し直しを促さない", () => {
  beforeEach(() => {
    disk.clear();
    env.clipboard.text = "";
    env.opened.length = 0;
    workspace.textDocuments = [];
    workspace.fs = memoryFs(disk);
    // 名前を変えた話の台帳を付け替えるときに、どの作品かを引く口（拡張機能の起動時に結ぶもの）
    setEpisodeRenameWorkLookup(() => work);
    Object.assign(window, {
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
    });
  });

  test("投稿キットで投稿した .txt を .md にしても、次の新話投稿で「投稿後に直しています」と出さない", async () => {
    const txt = episodeFile("001.txt");
    episodes.list = [txt];
    disk.set(Uri.file(txt.filePath).fsPath, utf8(SITE_TEXT));
    disk.set(
      ledgerPath,
      utf8(
        JSON.stringify({
          schemaVersion: "1",
          rankings: [],
          sites: [{ site: "kakuyomu", newEpisodeUrl: kakuyomuUrl }],
          posts: [],
        })
      )
    );

    // 1回目：未投稿の第1話をカクヨムへ投稿したと記録する（告知は作らない）
    stubQuickPick([(items) => items.find((item) => item.answer === "posted"), () => undefined]);
    await postNewEpisode(work, {} as unknown as AIRegistry);
    const afterPost = JSON.parse(readDisk(ledgerPath)) as { posts: Array<{ bodyHash?: string }> };
    expect(afterPost.posts).toHaveLength(1);
    expect(afterPost.posts[0].bodyHash).toBeTruthy();

    // .md にする（名前を変え、中のルビ・傍点をこの拡張機能の書き方へ直す）
    const mdPath = await convertOne(txt.filePath);
    expect(mdPath).toBe(path.join(work.folderPath, "本文", "001.md"));
    const converted = readDisk(mdPath!);
    // 中身が本当に変わったこと（変わっていなければ、このテストは何も確かめていない）
    expect(converted).toContain("{白銀|しろがね}");
    expect(converted).toContain("{雪|ゆき}の朝");
    expect(converted).toContain("{{それ}}");
    expect(converted).toContain("{{誰}}");
    // 台帳は新しい名前を指している（6.68.2。0.125.4）
    expect(readDisk(ledgerPath)).toContain("本文/001.md");

    // 2回目：作品から投稿を始める。直した話は無いので、出し直しを促さない
    episodes.list = [episodeFile("001.md")];
    const picks = stubQuickPick([() => undefined]);
    await postNewEpisode(work, {} as unknown as AIRegistry);
    expect(picks.map((pick) => pick.title)).not.toContain("投稿のあとに直した話があります");
    expect(picks.some((pick) => pick.placeHolder.includes("投稿後に直しています"))).toBe(false);
  });

  test("0.126.3 までの記録（v2: の印。書き換えない）でも、.md にしただけの話は促さない", async () => {
    // ファイル名の題は .md にしても変わらない（拡張子は題に入らない）
    expect(parseEpisodeFileName("001_雪の朝.txt").subtitle).toBe(parseEpisodeFileName("001_雪の朝.md").subtitle);
    const txt = { ...episodeFile("001.txt"), subtitle: "雪の朝" };
    /*
      古い記録は、今の本文を投稿サイトの書き方へ戻した写しと比べる。戻せるのは縦線ありの
      `｜漢字《かんじ》`（.txt でルビを振ったときの形）と、傍点のどちらか1通りで揃った本文。
      縦線なしや傍点の混在は戻せず、これまでどおり促す（出し直せば v3: の印になる）
    */
    const body = "　｜白銀《しろがね》の街に、｜雪《ゆき》が降っていた。\n　《《それ》》は約束だった。";
    disk.set(Uri.file(txt.filePath).fsPath, utf8(body));
    const v2 = postingTextHash("雪の朝", body);
    const ledgerText = JSON.stringify({
      schemaVersion: "1",
      rankings: [],
      sites: [{ site: "kakuyomu", newEpisodeUrl: kakuyomuUrl }],
      posts: [
        {
          episodePath: "本文/001.txt",
          site: "kakuyomu",
          postedAt: "2026-11-04T00:00:00.000Z",
          bodyHash: v2,
          titleHash: postingTitleHash("雪の朝"),
        },
      ],
    });
    disk.set(ledgerPath, utf8(ledgerText));

    await convertOne(txt.filePath);
    // 台帳の印は書き換えていない（作者の記録。付け替えたのは話の道だけ）
    expect(readDisk(ledgerPath)).toContain(v2);

    episodes.list = [{ ...episodeFile("001.md"), subtitle: "雪の朝" }];
    const picks = stubQuickPick([() => undefined]);
    await postNewEpisode(work, {} as unknown as AIRegistry);
    expect(picks.map((pick) => pick.title)).not.toContain("投稿のあとに直した話があります");
  });

  test("見逃さない：.md にしたあと本文を1字直した話は、促す", async () => {
    const txt = episodeFile("001.txt");
    episodes.list = [txt];
    disk.set(Uri.file(txt.filePath).fsPath, utf8(SITE_TEXT));
    disk.set(
      ledgerPath,
      utf8(
        JSON.stringify({
          schemaVersion: "1",
          rankings: [],
          sites: [{ site: "kakuyomu", newEpisodeUrl: kakuyomuUrl }],
          posts: [],
        })
      )
    );
    stubQuickPick([(items) => items.find((item) => item.answer === "posted"), () => undefined]);
    await postNewEpisode(work, {} as unknown as AIRegistry);

    const mdPath = await convertOne(txt.filePath);
    const edited = readDisk(mdPath!).replace("降っていた", "舞っていた");
    disk.set(Uri.file(mdPath!).fsPath, utf8(edited));

    episodes.list = [episodeFile("001.md")];
    const picks = stubQuickPick([() => undefined]);
    await postNewEpisode(work, {} as unknown as AIRegistry);
    expect(picks.some((pick) => pick.placeHolder.includes("第1話"))).toBe(true);
  });
});
