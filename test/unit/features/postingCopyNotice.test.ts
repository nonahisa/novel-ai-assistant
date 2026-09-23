import * as nodePath from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileSystemError,
  Uri,
  env,
  statusBarMessages,
  window,
  workspace,
} from "./support/vscodeStub";
import { showPostingCopyNotice } from "../../src/features/postingCopyNotice";
import type { NoteMarkdownResult } from "../../src/core/noteMarkdown";
import type { WorkEntry } from "../../src/models/types";

/**
 * noteへコピーしたあとの知らせ（設計書6.84）。
 *
 * ここで見るのは**「画像のフォルダーを開く」を出してよいか**の判断である。
 * 押しても何も起きないボタンは、押した作者に「壊れている」としか見えない。
 */

const NOTE: NoteMarkdownResult = {
  body: "【画像：猫（cat.png）】",
  images: [{ alt: "猫", path: "画像\\cat.png", line: 1 }],
  embeds: [],
  warnings: [],
};

/** 出た知らせのボタンを覗く。押さない（undefined を返す） */
function captureButtons(): { items: string[] } {
  const captured = { items: [] as string[] };
  window.showInformationMessage = async (
    _message: string,
    ...items: unknown[]
  ) => {
    captured.items = items.map(String);
    return undefined;
  };
  return captured;
}

/** その場所だけが「ある」ことにする */
function onlyExisting(existing: readonly string[]): void {
  workspace.fs.stat = ((uri: { fsPath: string }) => {
    const found = existing.some(
      (path) => path.toLowerCase() === uri.fsPath.toLowerCase()
    );
    if (found) return Promise.resolve({ type: 1 });
    return Promise.reject(new FileSystemError("ない", "FileNotFound"));
  }) as unknown as (...args: never[]) => unknown;
}

afterEach(() => {
  window.showInformationMessage = async () => undefined;
  workspace.fs = {} as Record<string, (...args: never[]) => unknown>;
});

describe("画像のフォルダーを開くボタン", () => {
  it("画像が実在するときだけ出す", async () => {
    const captured = captureButtons();
    onlyExisting(["c:\\works\\a\\画像\\cat.png"]);

    await showPostingCopyNotice({
      conversion: { text: "本文", note: NOTE },
      summary: "noteの知らせが出ていれば、この文は使われない",
      sourcePath: "c:\\works\\a\\第1話.md",
    });

    expect(captured.items).toContain("画像のフォルダーを開く");
  });

  /**
   * **無いものへの入口は出さない。** 本文に書いたパスが間違っている・
   * まだ用意していないことはふつうにあり、そのとき開いても空振りする。
   */
  it("画像が見つからなければ出さない", async () => {
    const captured = captureButtons();
    onlyExisting([]);

    await showPostingCopyNotice({
      conversion: { text: "本文", note: NOTE },
      summary: "noteの知らせが出ていれば、この文は使われない",
      sourcePath: "c:\\works\\a\\第1話.md",
    });

    expect(captured.items).not.toContain("画像のフォルダーを開く");
  });

  /**
   * **Windowsの絶対パスは、URLではない。** `C:\…` を「`C:` という仕組み
   * （scheme）」と読むと、手元にある画像を「外のURLだから開かない」と
   * 断ってしまう。
   */
  it("Windowsの絶対パス（C:\\…）を、外のURLと読み違えない", async () => {
    const captured = captureButtons();
    onlyExisting(["c:\\画像\\cat.png"]);

    await showPostingCopyNotice({
      conversion: {
        text: "本文",
        note: {
          ...NOTE,
          images: [{ alt: "猫", path: "c:\\画像\\cat.png", line: 1 }],
        },
      },
      summary: "noteの知らせが出ていれば、この文は使われない",
      sourcePath: "c:\\works\\a\\第1話.md",
    });

    expect(captured.items).toContain("画像のフォルダーを開く");
  });

  /** 外のURLは、手元にファイルが無いので開けない（これまでどおり） */
  it("http のURLでは出さない", async () => {
    const captured = captureButtons();
    onlyExisting(["c:\\works\\a\\画像\\cat.png"]);

    await showPostingCopyNotice({
      conversion: {
        text: "本文",
        note: {
          ...NOTE,
          images: [
            { alt: "猫", path: "https://example.com/cat.png", line: 1 },
          ],
        },
      },
      summary: "noteの知らせが出ていれば、この文は使われない",
      sourcePath: "c:\\works\\a\\第1話.md",
    });

    expect(captured.items).not.toContain("画像のフォルダーを開く");
  });
});

/**
 * 投稿ページを開くボタン（作者の依頼、2026-09-23）。
 *
 * コピーの次にするのは、そのサイトの投稿欄を開いて貼ることなので、
 * 知らせから開けるようにする。**押したときだけ開く**（勝手に開かない）。
 * URLの決め方そのものは `postingSiteUrls.test.ts` で見る。ここで見るのは
 * 「台帳から引いて、ボタンを出し、押すと既定のブラウザへ渡す」の配線。
 */
describe("投稿ページを開くボタン", () => {
  const work: WorkEntry = {
    id: "work_test",
    title: "氷の街",
    folderPath: nodePath.join("C:", "novels", "work"),
    registeredAt: "2026-09-04T00:00:00.000Z",
  };
  const ledgerPath = Uri.file(
    nodePath.join(work.folderPath, "設定", "投稿状態.json")
  ).fsPath;
  const KAKUYOMU_POST =
    "https://kakuyomu.jp/my/works/1177354054934574437/episodes/new";
  const NOTE_POST = "https://note.com/notes/new";
  const disk = new Map<string, Uint8Array>();

  function ledger(value: unknown): void {
    disk.set(ledgerPath, new TextEncoder().encode(JSON.stringify(value)));
  }

  /** 押すボタンを決めて、出たボタンを覗く */
  function pressing(label: string | undefined): {
    items: string[];
    calls: number;
  } {
    const captured = { items: [] as string[], calls: 0 };
    window.showInformationMessage = async (
      _message: string,
      ...items: unknown[]
    ) => {
      captured.calls += 1;
      captured.items = items.map(String);
      return label && captured.items.includes(label) ? label : undefined;
    };
    return captured;
  }

  /** 押されたあとの処理は待たずに走るので、終わるまで回す */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  beforeEach(() => {
    disk.clear();
    env.opened.length = 0;
    statusBarMessages.length = 0;
    workspace.textDocuments = [];
    workspace.fs = {
      createDirectory: async () => undefined,
      readFile: async (uri: { fsPath: string }) => {
        const bytes = disk.get(uri.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        return bytes;
      },
      stat: async (uri: { fsPath: string }) => {
        if (!disk.has(uri.fsPath)) {
          throw new FileSystemError("missing", "FileNotFound");
        }
        return { type: 1, ctime: 0, mtime: 0, size: 0 };
      },
    } as unknown as typeof workspace.fs;
  });

  it("台帳に投稿ページがあれば、ボタンを出し、押すとそのURLを開く", async () => {
    ledger({
      sites: [{ site: "kakuyomu", newEpisodeUrl: KAKUYOMU_POST }],
      posts: [],
    });
    const captured = pressing("カクヨムの投稿ページを開く");

    await showPostingCopyNotice({
      conversion: { text: "本文" },
      summary: "本文全体をカクヨムの書き方に変換して…",
      site: "kakuyomu",
      work,
    });
    await settle();

    expect(captured.items).toEqual(["カクヨムの投稿ページを開く"]);
    expect(env.opened).toEqual([KAKUYOMU_POST]);
  });

  it("押さなければ開かない（勝手に開かない）", async () => {
    ledger({
      sites: [{ site: "kakuyomu", newEpisodeUrl: KAKUYOMU_POST }],
      posts: [],
    });
    const captured = pressing(undefined);

    await showPostingCopyNotice({
      conversion: { text: "本文" },
      summary: "コピーしました",
      site: "kakuyomu",
      work,
    });
    await settle();

    expect(captured.items).toContain("カクヨムの投稿ページを開く");
    expect(env.opened).toEqual([]);
  });

  it("カクヨムは、投稿ページが無くても作品IDから開ける", async () => {
    // 投稿先から外しても、作品情報（siteProfiles）は残る
    ledger({
      sites: [],
      siteProfiles: [{ site: "kakuyomu", workId: "1177354054934574437" }],
      posts: [],
    });
    pressing("カクヨムの投稿ページを開く");

    await showPostingCopyNotice({
      conversion: { text: "本文" },
      summary: "コピーしました",
      site: "kakuyomu",
      work,
    });
    await settle();

    expect(env.opened).toEqual([KAKUYOMU_POST]);
  });

  /**
   * **開けないときは、これまでどおりの知らせ。** 文言も出し方も変えない
   * ——ボタンが無いのに通知で出すと、読み捨ててよい報告が積み上がる。
   */
  it("開ける先が無ければ、ボタンを出さずステータスバーで知らせる", async () => {
    ledger({
      sites: [],
      siteProfiles: [{ site: "narou", workId: "n1234ab" }],
      posts: [],
    });
    const captured = pressing(undefined);

    await showPostingCopyNotice({
      conversion: { text: "本文" },
      summary: "本文全体を小説家になろうの書き方に変換して…",
      site: "narou",
      work,
    });

    expect(captured.calls).toBe(0);
    expect(statusBarMessages.map((entry) => entry.text).join("\n")).toContain(
      "本文全体を小説家になろうの書き方に変換して…"
    );
  });

  it("作品一覧の右クリックは、ボタンが無くても通知で出す（以前のまま）", async () => {
    const captured = pressing(undefined);

    await showPostingCopyNotice({
      conversion: { text: "本文" },
      summary: "本文をコピーしました",
      withoutButtons: "popup",
      site: "kakuyomu",
      work,
    });

    expect(captured.calls).toBe(1);
    expect(captured.items).toEqual([]);
  });

  it("記法だけの書き出し先（HTMLなど）では、台帳にURLがあっても出さない", async () => {
    ledger({
      sites: [{ site: "kakuyomu", newEpisodeUrl: KAKUYOMU_POST }],
      posts: [],
    });
    const captured = pressing(undefined);

    await showPostingCopyNotice({
      conversion: { text: "本文" },
      summary: "コピーしました",
      work,
    });

    expect(captured.calls).toBe(0);
  });

  it("作品が引けなければ出さない（コピーの知らせは出る）", async () => {
    const captured = pressing(undefined);

    await showPostingCopyNotice({
      conversion: { text: "本文" },
      summary: "コピーしました",
      site: "kakuyomu",
    });

    expect(captured.calls).toBe(0);
    expect(statusBarMessages.map((entry) => entry.text).join("\n")).toContain(
      "コピーしました"
    );
  });

  it("台帳が壊れていても、知らせは出る（ボタンが無いだけ）", async () => {
    disk.set(ledgerPath, new TextEncoder().encode("{ sites: 壊れている"));
    const captured = pressing(undefined);

    await showPostingCopyNotice({
      conversion: { text: "本文" },
      summary: "コピーしました",
      site: "kakuyomu",
      work,
    });

    expect(captured.calls).toBe(0);
    expect(statusBarMessages.map((entry) => entry.text).join("\n")).toContain(
      "コピーしました"
    );
  });

  it("noteでは、題名・画像のボタンを残したまま、投稿ページのボタンを並べる", async () => {
    ledger({
      sites: [{ site: "note", newEpisodeUrl: NOTE_POST }],
      posts: [],
    });
    const imagePath = nodePath.join(work.folderPath, "画像", "cat.png");
    disk.set(Uri.file(imagePath).fsPath, new Uint8Array());
    const captured = pressing("noteの投稿ページを開く");

    await showPostingCopyNotice({
      conversion: { text: "本文", note: { ...NOTE, title: "氷の街" } },
      summary: "noteの知らせが出ていれば、この文は使われない",
      sourcePath: nodePath.join(work.folderPath, "第1話.md"),
      site: "note",
      work,
    });
    await settle();

    expect(captured.items).toEqual([
      "題名をコピー",
      "画像のフォルダーを開く",
      "noteの投稿ページを開く",
    ]);
    expect(env.opened).toEqual([NOTE_POST]);
  });

  it("noteで題名を押したときは、開かずに題名をコピーする（これまでどおり）", async () => {
    ledger({
      sites: [{ site: "note", newEpisodeUrl: NOTE_POST }],
      posts: [],
    });
    pressing("題名をコピー");

    await showPostingCopyNotice({
      conversion: { text: "本文", note: { ...NOTE, title: "氷の街" } },
      summary: "使われない",
      site: "note",
      work,
    });
    await settle();

    expect(env.clipboard.text).toBe("氷の街");
    expect(env.opened).toEqual([]);
  });
});
