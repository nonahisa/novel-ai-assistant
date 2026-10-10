import { describe, expect, test, beforeEach } from "vitest";
import { buildProposalPanelHtml } from "../../../src/views/proposalPanelHtml";

/**
 * 移す案（語り手の取り違え。設計書6.5.12、0.102.3）の行の移し先の選び口。
 *
 * - 名指しできた案は、その人を最初から選んである（「反映する」を押せる）
 * - 名指しできない案は、選ぶまで「反映する」を押せない（既定では選ばない）
 * - 選びは ✕ の印と同じ集合に `moveTo:` の頭で入り、「まとめて適用」でも届く
 *
 * WebView のスクリプトから関数を取り出して実際に走らせる
 * （`proposalPanelDropEntry.test.ts` と同じ手口）。
 */

const html = buildProposalPanelHtml("test-nonce", "vscode-webview:");

function extractFunction(source: string, name: string): string {
  const head = source.indexOf("function " + name + "(");
  expect(head, name + " が見つからない").toBeGreaterThanOrEqual(0);
  let depth = 0;
  let started = false;
  for (let i = head; i < source.length; i++) {
    if (source[i] === "{") {
      depth++;
      started = true;
    } else if (source[i] === "}") {
      depth--;
      if (started && depth === 0) return source.slice(head, i + 1);
    }
  }
  throw new Error(name + " の終わりが見つからない");
}

function extractConst(source: string, name: string): string {
  const head = source.indexOf("const " + name + " =");
  expect(head, name + " が見つからない").toBeGreaterThanOrEqual(0);
  return source.slice(head, source.indexOf(";", head) + 1);
}

interface Loaded {
  renderRecordUpdate: (item: unknown) => string;
  droppedEntries: Map<string, Set<string>>;
  applyAllMessage: () => { drops: { id: string; dropKeys: string[] }[] };
  setMoveChoice: (id: string, value: string) => void;
}

const loaded = ((): Loaded => {
  const body = [
    extractConst(html, "droppedEntries"),
    extractConst(html, "MOVE_PREFIX"),
    extractConst(html, "MOVE_REMOVE_ONLY"),
    extractFunction(html, "escapeHtml"),
    extractFunction(html, "diffSide"),
    extractFunction(html, "dropSetOf"),
    extractFunction(html, "applyAllMessage"),
    extractFunction(html, "renderEntries"),
    extractFunction(html, "renderRecordChanges"),
    extractFunction(html, "moveChoiceOf"),
    extractFunction(html, "setMoveChoice"),
    extractFunction(html, "renderMoveChoice"),
    extractFunction(html, "canApplyRecordUpdate"),
    extractFunction(html, "doneLabel"),
    extractFunction(html, "renderRecordUpdate"),
    "return { renderRecordUpdate: renderRecordUpdate, droppedEntries: droppedEntries," +
      " applyAllMessage: applyAllMessage, setMoveChoice: setMoveChoice };",
  ].join("\n");
  return new Function(body)() as Loaded;
})();

function moveRow(id: string, selected: string | null) {
  return {
    id,
    name: "アジャーノ",
    status: "pending",
    source: "移す案：役割「皇子」（第12話）",
    changes: ["いまの値：皇子（第12話）", "第12話は、ほかの語り手の場面だけの話です。"],
    moveChoice: { options: [{ id: "char_016", name: "殿下" }], selected },
  };
}

function applyButton(rendered: string): string {
  return rendered.match(/<button data-action="apply"[^>]*>/)?.[0] ?? "";
}

beforeEach(() => {
  loaded.droppedEntries.clear();
});

describe("移し先の選び口", () => {
  test("名指しできた案は、その人を選んだ状態で出て、反映を押せる", () => {
    const rendered = loaded.renderRecordUpdate(moveRow("move-1", "char_016"));
    expect(rendered).toContain('<option value="char_016" selected>殿下</option>');
    expect(rendered).toContain("外すだけ");
    expect(applyButton(rendered)).not.toContain("disabled");
    // 「まとめて適用」にも選びが載る
    expect(loaded.applyAllMessage().drops).toEqual([{ id: "move-1", dropKeys: ["moveTo:char_016"] }]);
  });

  test("名指しできない案は、選ぶまで反映を押せない", () => {
    const rendered = loaded.renderRecordUpdate(moveRow("move-2", null));
    expect(rendered).toContain("（選んでください）");
    expect(applyButton(rendered)).toContain("disabled");
    expect(loaded.applyAllMessage().drops).toEqual([]);

    loaded.setMoveChoice("move-2", "-");
    const after = loaded.renderRecordUpdate(moveRow("move-2", null));
    expect(after).toContain('<option value="-" selected>');
    expect(applyButton(after)).not.toContain("disabled");
    expect(loaded.applyAllMessage().drops).toEqual([{ id: "move-2", dropKeys: ["moveTo:-"] }]);
  });

  test("選び直しは前の選びを置き換える（2つ載らない）", () => {
    loaded.renderRecordUpdate(moveRow("move-3", "char_016"));
    loaded.setMoveChoice("move-3", "-");
    expect(loaded.applyAllMessage().drops).toEqual([{ id: "move-3", dropKeys: ["moveTo:-"] }]);
  });
});
