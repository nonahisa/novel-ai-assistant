import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  FileSystemError,
  FileType,
  window,
  workspace,
} from "./support/vscodeStub";
import type { WorkEntry } from "../../src/models/types";

/**
 * 編集部の提案を採る（設計書5.6）。実機確認 A-3 の2件に当たる。
 *
 * - 採ったあと、本文の**その1か所だけ**が変わっているか
 * - 提案が届いてから本文を直した場合、**書き換えずに理由が出るか**
 *
 * ## なぜここを固めるか
 *
 * 提案が届いてから作者が本文を直していることがある。**編集部の申し出は、
 * そのときの本文を指している。** 位置だけを信じて当てると、
 * いま書いてある別の場所を書き換えることになる。しかも作者は
 * 「提案を採った」としか思っていないので、**どこが変わったのか分からない**。
 *
 * **同じ語が1行に何度も出ることもある。** 「かもしれない」が2つある行で
 * 2つ目を直す提案を、1つ目へ当ててしまう類の事故は、この作品で実際に起きた
 * （0.34.3、提案パネルの「戻す」）。
 *
 * **本物のファイルシステムで走らせる**——確かめたいのは「何がファイルに
 * 書かれたか」なので、作り物の円盤では確かめたことにならない。
 */

vi.mock("../../src/core/gitAttribution", () => ({
  tryGitUserName: vi.fn(async () => "編集部"),
}));

const { acceptProposal } = await import("../../src/features/reviewProposals");

const BODY = nodePath.join("本文", "001.txt");

describe("編集部の提案を採る", () => {
  let base = "";
  let root = "";

  const work = (): WorkEntry => ({
    id: "work_test",
    title: "氷の街",
    folderPath: root,
    registeredAt: "2026-09-13T00:00:00.000Z",
  });

  const put = async (relative: string, text: string) => {
    const target = nodePath.join(root, relative);
    await fsp.mkdir(nodePath.dirname(target), { recursive: true });
    await fsp.writeFile(target, text, "utf8");
  };

  const body = (): Promise<string> =>
    fsp.readFile(nodePath.join(root, BODY), "utf8");

  beforeEach(async () => {
    base = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "novelai-accept-"));
    root = nodePath.join(base, "氷の街");
    await fsp.mkdir(root, { recursive: true });

    workspace.fs = {
      createDirectory: async (uri: { fsPath: string }) => {
        await fsp.mkdir(uri.fsPath, { recursive: true });
      },
      stat: async (uri: { fsPath: string }) => {
        const stat = await fsp.stat(uri.fsPath);
        return {
          type: stat.isDirectory() ? FileType.Directory : FileType.File,
          size: stat.size,
        };
      },
      /*
        **無いときは、本物と同じ形で断る。**
        Node の素の ENOENT を投げると、製品側の「無いだけか」の見分け
        （`error instanceof vscode.FileSystemError && code === "FileNotFound"`）
        が効かず、**本番では通る道が作り物でだけ失敗する**。
        作り物が本物と違う断り方をすると、実機でしか出ない壊れ方を作る
        （`vscodeStub` の `decodeUriQuery` に書いてあるのと同じ話）。
      */
      readFile: async (uri: { fsPath: string }) => {
        try {
          return new Uint8Array(await fsp.readFile(uri.fsPath));
        } catch {
          throw new FileSystemError(uri.fsPath, "FileNotFound");
        }
      },
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
        await fsp.mkdir(nodePath.dirname(uri.fsPath), { recursive: true });
        await fsp.writeFile(uri.fsPath, bytes);
      },
      readDirectory: async (uri: { fsPath: string }) => {
        const entries = await fsp.readdir(uri.fsPath, { withFileTypes: true });
        return entries.map((entry) => [
          entry.name,
          entry.isDirectory() ? FileType.Directory : FileType.File,
        ]);
      },
      delete: async (
        uri: { fsPath: string },
        options?: { recursive?: boolean }
      ) => {
        await fsp.rm(uri.fsPath, {
          recursive: options?.recursive ?? false,
          force: true,
        });
      },
      rename: async (
        from: { fsPath: string },
        to: { fsPath: string }
      ) => {
        await fsp.rename(from.fsPath, to.fsPath);
      },
      copy: async (from: { fsPath: string }, to: { fsPath: string }) => {
        await fsp.cp(from.fsPath, to.fsPath, { recursive: true, force: true });
      },
    } as unknown as typeof workspace.fs;

    Object.assign(window, {
      showInformationMessage: vi.fn(async () => undefined),
      showWarningMessage: vi.fn(async () => undefined),
      createOutputChannel: () => ({
        appendLine() {},
        show() {},
        dispose() {},
      }),
    });
  });

  afterEach(async () => {
    workspace.fs = {} as typeof workspace.fs;
    try {
      await fsp.rm(base, { recursive: true, force: true });
    } catch {
      // 一時フォルダーなので、消せなくても結果に関わらない
    }
  });

  test("**採ると、その1か所だけが変わる**", async () => {
    const before = [
      "　一行目はそのまま。",
      "　彼は走った。そして走った。",
      "　三行目もそのまま。",
      "",
    ].join("\r\n");
    await put(BODY, before);

    const result = await acceptProposal(work(), {
      id: "p1",
      file: BODY,
      line: 2,
      original: "そして走った。",
      target: "走った",
      suggestion: "駆けた",
    });

    expect(result.ok).toBe(true);
    expect(await body()).toBe(
      ["　一行目はそのまま。", "　彼は走った。そして駆けた。", "　三行目もそのまま。", ""].join(
        "\r\n"
      )
    );
  });

  test("**同じ語が並んでいても、提案が指した側だけを直す**", async () => {
    // 1行に「かもしれない」が2つ。2つ目を直す提案を、1つ目へ当てない
    const before =
      "　返されるかもしれないし、虎の威を借りても返されるかもしれあい。\r\n";
    await put(BODY, before);

    const result = await acceptProposal(work(), {
      id: "p2",
      file: BODY,
      line: 1,
      // 前後の文脈ごと指すことで、どちらの側かが決まる
      original: "borrowed",
      target: "かもしれあい",
      suggestion: "かもしれない",
    });
    // 文脈が本文に無ければ、当てずに断る
    expect(result.ok).toBe(false);
    expect(await body()).toBe(before);

    const second = await acceptProposal(work(), {
      id: "p2",
      file: BODY,
      line: 1,
      original: "虎の威を借りても返されるかもしれあい。",
      target: "かもしれあい",
      suggestion: "かもしれない",
    });
    expect(second.ok).toBe(true);
    expect(await body()).toBe(
      "　返されるかもしれないし、虎の威を借りても返されるかもしれない。\r\n"
    );
  });

  test("**届いてから本文を直していたら、書き換えずに理由を出す**", async () => {
    const before = "　彼は駆けた。\r\n";
    await put(BODY, before);

    const result = await acceptProposal(work(), {
      id: "p3",
      file: BODY,
      line: 1,
      // 提案が届いた時点の本文（もう残っていない）
      original: "彼は走った。",
      target: "走った",
      suggestion: "駆けた",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("本文が変わっている");
    // **1バイトも触らない**
    expect(await body()).toBe(before);
  });

  test("読めないファイルを指していても、理由を出して止まる", async () => {
    const result = await acceptProposal(work(), {
      id: "p4",
      file: nodePath.join("本文", "999.txt"),
      line: 1,
      original: "無い",
      target: "無い",
      suggestion: "ある",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("読み込めません");
  });

  test("改行コードは、採ったあとも元のまま", async () => {
    // CRLF が LF に化けると、次に GitHub で見たとき全行が変更になる
    const before = "　一行目。\r\n　二行目。\r\n";
    await put(BODY, before);

    await acceptProposal(work(), {
      id: "p5",
      file: BODY,
      line: 2,
      original: "二行目。",
      target: "二",
      suggestion: "2",
    });

    expect(await body()).toBe("　一行目。\r\n　2行目。\r\n");
  });
});
