import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { guideSpotlight } from "../../../src/mcp/tools/spotlight";
import { chatValidate } from "../../../src/mcp/tools/chat";
import { EDITOR_SHARE_MANIFEST_FILE } from "../../../src/core/editingRepo";
import { MENU_PATH_START, renderMenuPathText } from "../../../src/core/menuPath";

/**
 * 外部AI（MCP）の返事にも、相談パネルと同じ「メニューの場所の図」を添える（設計書6.118）。
 *
 * **図を組む関数は1か所**（`core/menuPath.ts` の `renderMenuPathText`）。ここでは、MCP の返事が
 * その関数の出力と同じものを返すことを見る（写しを作ると、片方だけ古い図になる）。
 */

let folder: string;

beforeEach(() => {
  folder = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-menupath-"));
});

afterEach(() => {
  fs.rmSync(folder, { recursive: true, force: true });
});

/** 編集者へ渡した写しの印を置く（`editorGuard.ts` がこれで編集者モードと読む） */
function markAsEditorCopy(): void {
  fs.mkdirSync(nodePath.join(folder, ".aiwriter"), { recursive: true });
  fs.writeFileSync(nodePath.join(folder, ".aiwriter", EDITOR_SHARE_MANIFEST_FILE), "{}", "utf8");
}

describe("guide.spotlight の返事", () => {
  test("コマンドで頼んだら、作者モードの図を添える", () => {
    const result = guideSpotlight({ folder, command: "novelai.viewEditorProposals" });
    expect(result.menuPath).toBe(renderMenuPathText("novelai.viewEditorProposals", "author"));
    expect(result.menuPath?.startsWith(MENU_PATH_START)).toBe(true);
  });

  test("名前で頼んでも、図のためにだけ解いて添える（依頼の行は名前のまま）", () => {
    const result = guideSpotlight({ folder, label: "編集者へ渡す" });
    expect(result.command).toBe("");
    expect(result.menuPath).toContain("編集者へ渡す（ここ）");
  });

  test("編集者へ渡した写しでは、編集者メニューの図になる", () => {
    markAsEditorCopy();
    const result = guideSpotlight({ folder, label: "置いた提案の一覧" });
    // 図は木だけ（作者の裁定 2026-11-07）。編集者メニューの5の中に印が付く
    expect(result.menuPath).toContain("└ 編集者メニュー\n　└ 5. 置いた提案を見直す\n");
    expect(result.menuPath).toContain("置いた提案の一覧（ここ）");
  });

  test("解けない名前なら図を省く（依頼そのものは届ける）", () => {
    const result = guideSpotlight({ folder, label: "存在しない項目" });
    expect(result.requested).toBe(true);
    expect(result.menuPath).toBeUndefined();
  });
});

describe("novel.validate（相談の答えの検算）の返事", () => {
  test("答えで名指しされた項目に、図を添える", () => {
    const response = JSON.stringify({
      reply: "「編集者の提案を見る」を押してください。",
      options: [],
    });
    const result = chatValidate({ response });
    expect(result.menuPaths?.map((card) => card.command)).toEqual([
      "novelai.viewEditorProposals",
    ]);
    expect(result.menuPaths?.[0].path).toBe(
      renderMenuPathText("novelai.viewEditorProposals", "author")
    );
  });

  test("名指しが無ければ添えない", () => {
    const response = JSON.stringify({ reply: "この場面は緊張感があります。", options: [] });
    expect(chatValidate({ response }).menuPaths).toBeUndefined();
  });
});
