import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FileType, window, workspace } from "../support/vscodeStub";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 作者が選ぶ置き場（`chooseDestination`）と、原稿エディターの校閲中の控え。
 * レビュー2回目（2026-10-29）の1・8・5。
 */

let pickedParent = "";
vi.mock("../../../src/features/pickFolder", () => ({
  pickNewFolderParent: vi.fn(async () => pickedParent),
  defaultParentForNewFolder: vi.fn(async () => undefined),
}));

const { chooseDestination } = await import("../../../src/features/shareWithEditor");

describe("置き場を選ぶ", () => {
  let base = "";
  const errors: string[] = [];
  const work = (): WorkEntry => ({
    id: "w",
    title: "氷の街",
    folderPath: nodePath.join(base, "書庫", "氷の街"),
    registeredAt: "2026-10-29T00:00:00.000Z",
  });

  beforeEach(async () => {
    base = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "novelai-dest-"));
    await fsp.mkdir(nodePath.join(base, "書庫", "氷の街"), { recursive: true });
    errors.length = 0;
    workspace.fs = {
      stat: async (uri: { fsPath: string }) => {
        const stat = await fsp.stat(uri.fsPath);
        return {
          type: stat.isDirectory() ? FileType.Directory : FileType.File,
          size: stat.size,
        };
      },
    } as unknown as typeof workspace.fs;
    Object.assign(window, {
      showErrorMessage: vi.fn(async (text: string) => {
        errors.push(text);
        return undefined;
      }),
    });
  });
  afterEach(async () => {
    workspace.fs = {} as typeof workspace.fs;
    await fsp.rm(base, { recursive: true, force: true }).catch(() => undefined);
  });

  const answerName = (name: string) => {
    Object.assign(window, { showInputBox: vi.fn(async () => name) });
  };

  test("新しい名前の場所なら通る", async () => {
    pickedParent = base;
    answerName("新しい編集用");
    expect(await chooseDestination(work(), [work()])).toBe(nodePath.join(base, "新しい編集用"));
  });

  test("1：すでにある場所は断る（clone の失敗の後始末や reset が中身を消さないように）", async () => {
    pickedParent = base;
    await fsp.mkdir(nodePath.join(base, "既にあるフォルダー"), { recursive: true });
    answerName("既にあるフォルダー");

    expect(await chooseDestination(work(), [work()])).toBeUndefined();
    expect(errors.join("\n")).toContain("すでに存在します");
  });

  test("8：書庫そのもの（作品を含む場所）は断る", async () => {
    pickedParent = base;
    // 「書庫」は作品を含む。既にあるフォルダーとしても断られるが、含む判定で先に断る
    answerName("書庫");

    expect(await chooseDestination(work(), [work()])).toBeUndefined();
    expect(errors.join("\n")).toContain("作品を含むフォルダー");
  });

  test("作品フォルダーの中は、これまでどおり断る", async () => {
    pickedParent = nodePath.join(base, "書庫", "氷の街");
    answerName("編集用");

    expect(await chooseDestination(work(), [work()])).toBeUndefined();
    expect(errors.join("\n")).toContain("作品フォルダーの中には置けません");
  });
});

describe("原稿エディターの校閲中の分岐（源の形の見張り）", () => {
  // `resolveCustomTextEditor` を代役で組むには依存が多すぎるので、源の形で見張る
  // （`manuscriptConflictSendNow.test.ts` と同じやり方）
  const source = readFileSync("src/features/manuscriptEditor.ts", "utf8");

  test("5：校閲中の分岐は、読み取り専用の道と同じく拡張機能の側へ控え、拒否を覚える", () => {
    const start = source.indexOf("if (await this.lockedByEditor(document)) {");
    const end = source.indexOf('return "conflict";', start);
    expect(start).toBeGreaterThan(-1);
    const branch = source.slice(start, end);
    expect(branch).toContain("putReadonlyRescue(");
    expect(branch).toContain("makeReadonlyRescue(");
    expect(branch).toContain("ledger.rememberRejected(");
    expect(branch).toContain("sendNow();");
  });
});
