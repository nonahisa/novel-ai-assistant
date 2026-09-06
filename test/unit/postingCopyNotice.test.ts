import { afterEach, describe, expect, it } from "vitest";
import { FileSystemError, window, workspace } from "./support/vscodeStub";
import { showPostingCopyNotice } from "../../src/features/postingCopyNotice";
import type { NoteMarkdownResult } from "../../src/core/noteMarkdown";

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
      otherwise: () => expect.unreachable("noteの知らせが出ていない"),
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
      otherwise: () => expect.unreachable("noteの知らせが出ていない"),
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
      otherwise: () => expect.unreachable("noteの知らせが出ていない"),
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
      otherwise: () => expect.unreachable("noteの知らせが出ていない"),
      sourcePath: "c:\\works\\a\\第1話.md",
    });

    expect(captured.items).not.toContain("画像のフォルダーを開く");
  });
});
