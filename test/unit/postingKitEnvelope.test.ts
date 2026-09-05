import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { postNewEpisode } from "../../src/features/postingKit";
import { parsePostingEnvelope } from "../../src/core/postingEnvelope";
import type { AIRegistry } from "../../src/ai/registry";
import type { EpisodeFile, WorkEntry } from "../../src/models/types";
import { env, FileSystemError, Uri, window, workspace } from "./support/vscodeStub";

/**
 * 「貼り込み係へ渡す形でコピー」（設計書6.79.3）の配線。
 *
 * 封筒の組み立てそのものは `postingEnvelope.test.ts` が見ている。ここで
 * 確かめるのは、**投稿キットの案内から実際にその封筒がクリップボードへ
 * 入るか**と、**対応していないサイトでは選択肢が出ないか**である。
 *
 * **サイトへは何も送らない。** この機能が外へ出るのはクリップボードと
 * 「ブラウザで開く」の2つだけで、送信ボタンを押すのは作者である。
 */

const work: WorkEntry = {
  id: "work_envelope",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "envelope"),
  registeredAt: "2026-09-05T00:00:00.000Z",
};

const ledgerPath = Uri.file(
  path.join(work.folderPath, "設定", "投稿状態.json")
).fsPath;

const episodePath = path.join(work.folderPath, "本文", "013_邂逅.txt");

const narouUrl =
  "https://syosetu.com/usernovelmanage/isnoveluploadmenu/ncode/n1234ab/";
const kakuyomuUrl = "https://kakuyomu.jp/my/works/16816927859/episodes/new";
const noteUrl = "https://note.com/notes/new";

const body = ['「引くな」と彼は言った。', "", "そして——歩き出した。"].join("\n");

const episode: EpisodeFile = {
  filePath: episodePath,
  fileName: "013_邂逅.txt",
  ext: ".txt",
  chapterStart: 13,
  chapterEnd: 13,
  subtitle: "邂逅",
  kind: "本編",
  isInitialName: false,
  counts: { gross: 0, net: 0, paragraphs: 0, manuscriptLines: 0 },
  hasMetadata: false,
  metaTitle: null,
  declaredCharCount: null,
  metaUpdatedAt: null,
  hasConflictMarkers: false,
};

interface PickItem {
  label: string;
  [key: string]: unknown;
}

const disk = new Map<string, Uint8Array>();
const informed: string[] = [];

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/**
 * 投稿サイトを登録済みの台帳。カクヨムには作品IDも入れてある。
 *
 * **3サイト並べてある**——貼り込み係へ渡せるのはカクヨムだけで、
 * なろうとnoteでは選択肢が出ないことを1度に確かめるため（6.79.1）。
 * サイトを回る順は `POSTING_SITES` の並び（なろう→カクヨム→note）。
 */
function writeLedger(): void {
  disk.set(
    ledgerPath,
    utf8(
      JSON.stringify({
        schemaVersion: "1",
        sites: [
          { site: "narou", newEpisodeUrl: narouUrl },
          { site: "kakuyomu", newEpisodeUrl: kakuyomuUrl },
          { site: "note", newEpisodeUrl: noteUrl },
        ],
        siteProfiles: [{ site: "kakuyomu", workId: "16816927859" }],
        posts: [],
        rankings: [],
      })
    )
  );
}

function readLedger(): { posts: Array<Record<string, unknown>> } {
  const bytes = disk.get(ledgerPath);
  if (!bytes) throw new Error("台帳が書かれていません");
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** 選択画面の答え方。渡された項目と案内文を覚えてから、1つ返す */
function stubQuickPick(
  answers: Array<(items: PickItem[]) => unknown>
): Array<{ items: PickItem[]; placeHolder: string }> {
  const captured: Array<{ items: PickItem[]; placeHolder: string }> = [];
  let index = 0;
  Object.assign(window, {
    showQuickPick: async (
      items: PickItem[],
      options?: { placeHolder?: string }
    ) => {
      captured.push({ items, placeHolder: options?.placeHolder ?? "" });
      const answer = answers[index++];
      return answer ? answer(items) : undefined;
    },
  });
  return captured;
}

/** 選択肢を答えの印（`answer`）で探す */
function byAnswer(items: PickItem[], answer: string): PickItem | undefined {
  return items.find((item) => item.answer === answer);
}

describe("貼り込み係へ渡す形でコピー", () => {
  beforeEach(() => {
    disk.clear();
    informed.length = 0;
    env.clipboard.text = "";
    env.opened.length = 0;
    workspace.textDocuments = [];
    workspace.fs = {
      createDirectory: async () => undefined,
      readFile: async (uri: { fsPath: string }) => {
        const bytes = disk.get(uri.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        return bytes;
      },
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
        disk.set(uri.fsPath, bytes);
      },
      rename: async (
        from: { fsPath: string },
        to: { fsPath: string },
        options?: { overwrite?: boolean }
      ) => {
        const bytes = disk.get(from.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        if (!options?.overwrite && disk.has(to.fsPath)) {
          throw new FileSystemError("exists", "FileExists");
        }
        disk.set(to.fsPath, bytes);
        disk.delete(from.fsPath);
      },
      delete: async (uri: { fsPath: string }) => {
        disk.delete(uri.fsPath);
      },
      stat: async (uri: { fsPath: string }) => {
        if (!disk.has(uri.fsPath)) {
          throw new FileSystemError("missing", "FileNotFound");
        }
        return { type: 1, ctime: 0, mtime: 0, size: 0 };
      },
    } as unknown as typeof workspace.fs;

    Object.assign(window, {
      showInformationMessage: async (message: string) => {
        informed.push(message);
        return undefined;
      },
      showWarningMessage: async (message: string) => undefined,
      showErrorMessage: async (message: string) => undefined,
    });

    writeLedger();
    disk.set(Uri.file(episodePath).fsPath, utf8(body));
  });

  test("カクヨムでは封筒が出て、なろう・noteでは選択肢に出ない", async () => {
    const picks = stubQuickPick([
      // なろう：貼り込み係が受け取らないので飛ばす
      (items) => byAnswer(items, "skip"),
      // カクヨム：封筒でコピー → もう一度出る画面で「投稿しました」
      (items) => byAnswer(items, "envelope"),
      (items) => byAnswer(items, "posted"),
      // note：貼り込み係に対応していないので飛ばす
      (items) => byAnswer(items, "skip"),
      // 更新告知は作らない
      () => undefined,
    ]);

    const result = await postNewEpisode(
      work,
      {} as unknown as AIRegistry,
      episode
    );

    expect(result.changed).toBe(true);

    // カクヨムの画面には貼り込み係の項目がある
    expect(byAnswer(picks[1].items, "envelope")?.label).toContain("貼り込み係");
    /*
      **なろうとnoteには出さない**（6.79.1）。どちらも規約の判断が
      済んでおらず、貼り込み係の側も受け取らない——押せる形で置くと、
      投稿画面で待っても何も起きない理由が作者に分からない
    */
    expect(byAnswer(picks[0].items, "envelope")).toBeUndefined();
    expect(byAnswer(picks[3].items, "envelope")).toBeUndefined();
    /*
      コピーしたあとの案内で、**次に何をするか**と**送信は作者が押す**ことを
      言う（6.79.2の2）。ここを落とすと、貼り込み係が勝手に投稿すると
      読まれかねない
    */
    expect(picks[2].placeHolder).toContain("貼り込み係");
    expect(picks[2].placeHolder).toContain("送信はご自身で");

    // 記録は残る（貼り込み係へ渡しても、投稿したのは作者である）
    expect(readLedger().posts).toHaveLength(1);
  });

  test("封筒には、変換済みの本文・題名・台帳の作品IDが入る", async () => {
    let copied = "";
    stubQuickPick([
      // なろうは飛ばして、カクヨムで封筒を選ぶ
      (items) => byAnswer(items, "skip"),
      (items) => byAnswer(items, "envelope"),
      () => {
        // 封筒を選んだ直後のクリップボードを覗く（次の画面が出た時点）
        copied = env.clipboard.text;
        return undefined;
      },
    ]);

    await postNewEpisode(work, {} as unknown as AIRegistry, episode);

    const envelope = parsePostingEnvelope(copied);
    expect(envelope).not.toBeNull();
    expect(envelope?.site).toBe("kakuyomu");
    // 題名の欄へ入るのはサブタイトル（「サブタイトルをコピー」と同じ値）
    expect(envelope?.title).toBe("邂逅");
    // 取り違え照合に使う作品ID（6.79.6の2）
    expect(envelope?.workId).toBe("16816927859");
    // 本文はサイト向けに変換したもの。改行も引用符もそのまま通る
    expect(envelope?.body).toBe(body);
  });

  test("作品IDを入れていない作品では、作品IDの欄を作らない", async () => {
    disk.set(
      ledgerPath,
      utf8(
        JSON.stringify({
          schemaVersion: "1",
          sites: [{ site: "kakuyomu", newEpisodeUrl: kakuyomuUrl }],
          posts: [],
          rankings: [],
        })
      )
    );

    let copied = "";
    stubQuickPick([
      (items) => byAnswer(items, "envelope"),
      () => {
        copied = env.clipboard.text;
        return undefined;
      },
    ]);

    await postNewEpisode(work, {} as unknown as AIRegistry, episode);

    expect("workId" in (JSON.parse(copied) as Record<string, unknown>)).toBe(
      false
    );
  });
});
