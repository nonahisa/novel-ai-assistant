import { describe, expect, it } from "vitest";
import {
  MCP_EDITOR_ALLOWED_MESSAGE_HINT,
  describeMcpBlocked,
  workModeFromMarks,
  type FolderMarkState,
} from "../../../src/core/editorMode";

/**
 * 作品フォルダーの印から、編集用の写しかを決める（設計書5.6.5・6.87.25）。
 *
 * **いちばん守りたいのは「印が無い作品は作者」。** ここを取り違えると、
 * 一度も編集部へ渡していない作者の作品で、MCP の書く道具が全部止まる。
 */
describe("workModeFromMarks", () => {
  const states: FolderMarkState[] = ["present", "absent", "unreadable"];

  it("写しの印が無ければ、作者の印がどうであれ作者", () => {
    for (const authorSite of states) {
      expect(workModeFromMarks({ editorCopy: "absent", authorSite }), authorSite).toBe("author");
    }
  });

  it("写しの印があり、作者の印が無い（読めない）なら編集者", () => {
    expect(workModeFromMarks({ editorCopy: "present", authorSite: "absent" })).toBe("editor");
    expect(workModeFromMarks({ editorCopy: "present", authorSite: "unreadable" })).toBe("editor");
  });

  it("両方あるか、写しの印が確かめられないときは分からない", () => {
    expect(workModeFromMarks({ editorCopy: "present", authorSite: "present" })).toBe("unknown");
    for (const authorSite of states) {
      expect(workModeFromMarks({ editorCopy: "unreadable", authorSite }), authorSite).toBe(
        "unknown"
      );
    }
  });
});

describe("describeMcpBlocked", () => {
  it("理由と代わりの道を言う", () => {
    const text = describeMcpBlocked("novel.extract.commit", "editor");
    expect(text).toContain("novel.extract.commit は編集者モードでは使えません");
    expect(text).toContain("作者の原稿と資料を、編集部の側から書き換えないためです");
    expect(text).toContain(MCP_EDITOR_ALLOWED_MESSAGE_HINT);
  });

  it("確かめられなかったときは、そう言う", () => {
    expect(describeMcpBlocked("outbox.import", "unknown")).toContain("確かめられませんでした");
  });
});
