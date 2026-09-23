import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  FileSystemError,
  FileType,
  commands,
  window,
  workspace,
} from "../support/vscodeStub";
import type { WorkEntry } from "../../../src/models/types";
import { AI_INSTRUCTION_TARGETS } from "../../../src/core/aiInstructions";

/**
 * 許可の画面を、行き止まりにしない（設計書6.87.15）。
 *
 * **作者が実際に詰まった（2026-09-20）。** 「Claude Code にこの作品を
 * 触らせたい」と思って「外部AIの利用を許可する／取り消す」を押すと、
 *
 * > 許可は、外部AIが実際に使おうとしたときに画面でお尋ねします。
 * > 先に決めておく必要はありません。
 *
 * と出て終わっていた。**この文が正しいのは、指示書を置いてある作品だけ
 * である。** 指示書と MCP の登録が無ければ外部AIは道具に繋がらないので、
 * **お尋ねする機会そのものが永遠に来ない。** 本作を含め、本物の作品には
 * 指示書が1つも置かれていなかった。
 *
 * ここで見張りたいのは2つ。
 *
 * 1. **指示書が無ければ、その場で置けること**（探させない）
 * 2. **指示書があれば、これまでの文言のままであること**（あちらは正しい）
 */

const { toggleExternalAccessPermission } = await import(
  "../../../src/features/externalAccessPermission"
);

let root = "";

const work = (): WorkEntry => ({
  id: "work_test",
  title: "氷の街",
  folderPath: root,
  registeredAt: "2026-09-20T00:00:00.000Z",
});

/** 画面に出た知らせ（`showInformationMessage`）の呼び出し */
type Shown = [string, { detail?: string }, ...string[]];

const shown = (): Shown => {
  const calls = (
    window.showInformationMessage as unknown as ReturnType<typeof vi.fn>
  ).mock.calls;
  return calls[calls.length - 1] as Shown;
};

/** 出たボタンの並び（3つめ以降が押せるもの） */
const buttons = (): string[] => shown().slice(2) as string[];

beforeEach(async () => {
  root = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "novelai-guide-"));

  workspace.fs = {
    stat: async (uri: { fsPath: string }) => {
      try {
        const stat = await fsp.stat(uri.fsPath);
        return {
          type: stat.isDirectory() ? FileType.Directory : FileType.File,
          size: stat.size,
        };
      } catch {
        // **本物と同じ形で断る**（素の ENOENT では見分けが効かない）
        throw new FileSystemError(uri.fsPath, "FileNotFound");
      }
    },
    readFile: async (uri: { fsPath: string }) => {
      try {
        return new Uint8Array(await fsp.readFile(uri.fsPath));
      } catch {
        throw new FileSystemError(uri.fsPath, "FileNotFound");
      }
    },
  } as unknown as typeof workspace.fs;

  Object.assign(window, {
    showInformationMessage: vi.fn(async () => undefined),
    showWarningMessage: vi.fn(async () => undefined),
    showQuickPick: vi.fn(async () => undefined),
  });
  commands.executeCommand = vi.fn(async () => undefined) as never;
});

afterEach(async () => {
  workspace.fs = {} as typeof workspace.fs;
  try {
    await fsp.rm(root, { recursive: true, force: true });
  } catch {
    // 一時フォルダーなので、消せなくても結果に関わらない
  }
});

/** 指示書を1つ置く */
const putInstruction = async (relative: string): Promise<void> => {
  const target = nodePath.join(root, relative);
  await fsp.mkdir(nodePath.dirname(target), { recursive: true });
  await fsp.writeFile(target, "# 指示書\n", "utf8");
};

describe("指示書を置いていない作品——出口を出す", () => {
  test("**その場で置けるボタンが出る**（探させない）", async () => {
    await toggleExternalAccessPermission(work());

    const [message, options] = shown();
    expect(message).toContain("まだAI用の指示書を置いていません");
    expect(options.detail).toContain("お尋ねする機会そのものが来ません");
    expect(buttons()).toEqual(["AI用の指示書を置く", "あとで"]);
  });

  test("押すと、指示書を置くコマンドがこの作品で走る", async () => {
    (
      window.showInformationMessage as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue("AI用の指示書を置く");

    await toggleExternalAccessPermission(work());

    const executed = commands.executeCommand as unknown as ReturnType<
      typeof vi.fn
    >;
    expect(executed).toHaveBeenCalledTimes(1);
    const [command, ref] = executed.mock.calls[0] as [
      string,
      { type: string; work: WorkEntry },
    ];
    expect(command).toBe("novelai.writeAiInstructions");
    // **作品を訊き直させない**（押した作品でそのまま進む）
    expect(ref.type).toBe("work");
    expect(ref.work.folderPath).toBe(root);
  });

  test("「あとで」なら、何も起こさない", async () => {
    (
      window.showInformationMessage as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue("あとで");

    await toggleExternalAccessPermission(work());

    expect(commands.executeCommand).not.toHaveBeenCalled();
  });
});

describe("指示書を置いてある作品——これまでの文言のまま", () => {
  /*
    **1つでもあれば「置いてある」と見る。** 相手は複数選べるので、
    どれが置かれているかは作者の選び方次第である。問うているのは
    「ノックしに来る道があるか」だけなので、1つで足りる。
  */
  for (const target of AI_INSTRUCTION_TARGETS) {
    test(`${target.label} の指示書があれば、「先に決めておく必要はありません」`, async () => {
      await putInstruction(target.instructionPath);

      await toggleExternalAccessPermission(work());

      const [message, options] = shown();
      expect(message).toContain("まだ誰にも許可していません");
      expect(options.detail).toContain("先に決めておく必要はありません");
      // 置くボタンは出さない（もう置いてあるので、押させる意味が無い）
      expect(buttons()).toEqual([]);
    });
  }
});
