import { describe, expect, it } from "vitest";
import { buildManuscriptEditorHtml } from "../../../src/views/manuscriptEditorHtml";
import { MANUSCRIPT_POSTING_ACTIONS, postingActionCommand } from "../../../src/core/manuscriptKeys";

/**
 * 原稿エディターの上の列を多段にする（作者の決定 2026-11-08。設計書6.25）。
 *
 * 1段目は［入力］［出力］［補助］［表示］の4つだけ。押すと、読み上げの段と同じく
 * 下に2段目が開く。開くのは1つずつで、同じ言葉を押し直すと閉じ、ほかの言葉を
 * 押すと切り替わる。**今ある機能は並べ替えるだけ**（ボタンの id も動きも変えない）。
 * テキストファイルと Word は 0.147.0 から、バックアップと PDF（この話）は 0.150.0 から動く
 * （押すと拡張機能へ入口を送る）。次の版で作る入口（button.soon）は、いまは1つも無い。
 *
 * 画面へ渡る本物の HTML とスクリプトを切り出して確かめる
 * （manuscriptEditorProofMenu.test.ts と同じやり方）。
 */

const html = buildManuscriptEditorHtml("NONCE123", "vscode-resource:");
const code = html.slice(html.indexOf("<script"));
const markup = html.slice(html.indexOf("<body"), html.indexOf("<script"));

/** `<div id="…">` から、行頭の `</div>` までの中身 */
function block(id: string): string {
  const match = new RegExp(`<div id="${id}"[^>]*>([\\s\\S]*?)\\n</div>`).exec(markup);
  expect(match, `<div id="${id}"> が見つからない`).not.toBeNull();
  return match ? match[1] : "";
}

/** 中のボタンを並び順に（id と字） */
function buttons(source: string): Array<[string, string]> {
  return [...source.matchAll(/<button id="([^"]+)"[^>]*>([^<]*)<\/button>/g)].map((m) => [m[1], m[2]]);
}

function markedBlock(name: string): string {
  const start = code.indexOf(`/* ${name}:start */`);
  const end = code.indexOf(`/* ${name}:end */`);
  expect(start, `${name} の区切りが画面に無い`).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return code.slice(start, end);
}

function functionSource(name: string, until: string): string {
  const start = code.indexOf(`function ${name}(`);
  const end = code.indexOf(until, start);
  expect(start, `${name} が見つからない`).toBeGreaterThan(0);
  expect(end, `${name} の終わりが見つからない`).toBeGreaterThan(start);
  return code.slice(start, end);
}

describe("上の列（1段目）", () => {
  it("［入力］［出力］［補助］［表示］の4つだけが並ぶ", () => {
    expect(buttons(block("bar")).map(([, label]) => label)).toEqual(["入力", "出力", "補助", "表示"]);
  });

  it("どの言葉も、開く段を名乗る（読み上げソフトにも開いているかが伝わる）", () => {
    for (const [id, tray] of [
      ["trayInput", "input"],
      ["trayOutput", "output"],
      ["trayAssist", "assist"],
      ["trayView", "view"],
    ]) {
      const tag = new RegExp(`<button id="${id}"[^>]*>`).exec(block("bar"))?.[0] ?? "";
      expect(tag, id).toContain(`data-tray="${tray}"`);
      expect(tag, id).toContain('aria-expanded="false"');
      expect(tag, id).toContain("title=");
    }
  });
});

describe("2段目の中身", () => {
  it("入力：テキストファイルから・バックアップから・Word から・口述（［整える］［やめる］は口述中だけ）", () => {
    expect(buttons(block("rowInput"))).toEqual([
      ["importText", "テキストファイルから"],
      ["importBackup", "バックアップから"],
      ["importWord", "Word から"],
      ["dictate", "口述"],
      ["dictateClean", "整える"],
      ["dictateCancel", "やめる"],
    ]);
    // 口述中だけ出す動きは今のまま
    expect(block("rowInput")).toMatch(/<button id="dictateClean" class="dictate-on"/);
    expect(html).toContain("body.dictating .dictate-on { display: inline-block; }");
  });

  it("出力：投稿・読み上げ・PDF・音声に書き出す（読み上げを押すと、今の読み上げの段が開く）", () => {
    expect(buttons(block("rowOutput"))).toEqual([
      ["posting", "投稿"],
      ["aloudToggle", "読み上げ"],
      ["exportPagePdf", "PDF（この話）"],
      ["exportVoice", "音声に書き出す"],
    ]);
    expect(block("rowOutput")).toMatch(/<button id="posting" aria-haspopup="menu"/);
    // 読み上げの段は今のまま（［音声に書き出す］も含む）
    expect(block("aloud")).toContain('id="aloudVoiceExport"');
  });

  it("補助：校正・単話プロット・ルビ・傍点", () => {
    expect(buttons(block("rowAssist")).map(([id]) => id)).toEqual(["proof", "episodePlot", "ruby", "emph"]);
  });

  it("表示：縦書き／横書き・書体・ー・＋・note風・貼り付け後（note の2つは note の作品のときだけ）", () => {
    expect(buttons(block("rowView")).map(([id]) => id)).toEqual([
      "dir",
      "font",
      "smaller",
      "bigger",
      "noteStyle",
      "notePv",
    ]);
    expect(block("rowView")).toMatch(/<button id="noteStyle" class="note-only"/);
    expect(block("rowView")).toMatch(/<button id="notePv" class="note-only"/);
  });

  it("今ある操作のボタンは、どれか1つの段に1回だけある（なくしても、2つにもしない）", () => {
    const rows = ["rowInput", "rowOutput", "rowAssist", "rowView"].map(block).join("\n");
    for (const id of [
      "dir", "ruby", "emph", "aloudToggle", "episodePlot", "proof", "noteStyle", "notePv",
      "font", "smaller", "bigger", "dictate", "dictateClean", "dictateCancel",
    ]) {
      expect(markup.split(`<button id="${id}"`).length - 1, id).toBe(1);
      expect(rows, id).toContain(`<button id="${id}"`);
    }
  });

  it("段は畳んで始まり、狭い窓では折り返す（はみ出さない）", () => {
    expect(html).toMatch(/\.tray \{[^}]*display: none;[^}]*flex-wrap: wrap;/);
    expect(html).toContain(".tray.open { display: flex; }");
    // 区切りの線も段の中で引く
    expect(html).toMatch(/#bar \.sep,\s*\.tray \.sep \{/);
  });
});

/** 段の出し入れの仕掛け（trays の区切り）を、偽の部品で動かす */
function trayHarness(options: { aloudOpen?: boolean } = {}) {
  const env = {
    aligned: 0,
    aloudClosed: 0,
    bodyClasses: new Set<string>(options.aloudOpen ? ["aloud"] : []),
    toggles: [] as Array<{ tray: string; on: boolean; expanded: string; click: () => void }>,
    rows: [] as Array<{ tray: string; open: boolean }>,
  };
  for (const tray of ["input", "output", "assist", "view"]) {
    env.toggles.push({ tray, on: false, expanded: "false", click: () => undefined });
    env.rows.push({ tray, open: false });
  }
  const api = new Function(
    "env",
    `
    function scheduleAlignMarks() { env.aligned += 1; }
    function aloudCloseRow() { env.aloudClosed += 1; env.bodyClasses.delete("aloud"); }
    const document = {
      body: { classList: { contains(name) { return env.bodyClasses.has(name); } } },
      querySelectorAll(selector) {
        if (selector === "#bar .tray-toggle") {
          return env.toggles.map((toggle) => ({
            dataset: { tray: toggle.tray },
            classList: { toggle(name, on) { if (name === "on") toggle.on = on; } },
            setAttribute(name, value) { if (name === "aria-expanded") toggle.expanded = value; },
            addEventListener(type, fn) { if (type === "click") toggle.click = fn; },
          }));
        }
        if (selector === ".tray") {
          return env.rows.map((row) => ({
            dataset: { tray: row.tray },
            classList: { toggle(name, on) { if (name === "open") row.open = on; } },
          }));
        }
        return [];
      },
    };
    ${markedBlock("trays")}
    return { trayShow, opened: () => trayOpen };
    `
  )(env) as { trayShow: (name: string) => void; opened: () => string };
  const press = (tray: string) => env.toggles.find((toggle) => toggle.tray === tray)?.click();
  const openRows = () => env.rows.filter((row) => row.open).map((row) => row.tray);
  return { env, api, press, openRows };
}

describe("段の出し入れ", () => {
  it("押すと開き、同じ言葉をもう一度押すと閉じる", () => {
    const { env, press, openRows } = trayHarness();
    press("assist");
    expect(openRows()).toEqual(["assist"]);
    expect(env.toggles.find((t) => t.tray === "assist")).toMatchObject({ on: true, expanded: "true" });
    press("assist");
    expect(openRows()).toEqual([]);
    expect(env.toggles.find((t) => t.tray === "assist")).toMatchObject({ on: false, expanded: "false" });
  });

  it("ほかの言葉を押すと切り替わる（開くのは1つずつ）", () => {
    const { env, press, openRows } = trayHarness();
    press("input");
    press("view");
    expect(openRows()).toEqual(["view"]);
    expect(env.toggles.filter((t) => t.on).map((t) => t.tray)).toEqual(["view"]);
  });

  it("開け閉めのたびに用語の色の位置を測り直す（本文の面の高さが変わるため）", () => {
    const { env, press } = trayHarness();
    press("input");
    press("input");
    press("view");
    expect(env.aligned).toBe(3);
  });

  it("出力の段を離れるとき、読み上げの段も畳む（見えない段が声を出し続けないように）", () => {
    const { env, press } = trayHarness({ aloudOpen: true });
    press("output");
    expect(env.aloudClosed).toBe(0);
    press("view");
    expect(env.aloudClosed).toBe(1);
  });

  it("読み上げが開いていなければ、出力を離れても何も止めない", () => {
    const { env, press } = trayHarness();
    press("output");
    press("output");
    expect(env.aloudClosed).toBe(0);
  });

  it("拡張機能へは何も送らない（段の出し入れは画面の中で終える）", () => {
    expect(markedBlock("trays")).not.toContain("postMessage");
  });
});

describe("バックアップから・PDF（この話）（0.150.0）", () => {
  it("2つとも入口の印（soon）が外れ、何が起きるかを説明に書く", () => {
    for (const id of ["importBackup", "exportPagePdf"]) {
      const tag = new RegExp(`<button id="${id}"[^>]*>`).exec(markup)?.[0] ?? "";
      expect(tag, id).not.toContain('class="soon"');
      expect(tag, id).not.toContain("次の版で入ります");
    }
    expect(new RegExp('<button id="importBackup"[^>]*>').exec(markup)?.[0]).toContain("最後に加える");
    expect(new RegExp('<button id="exportPagePdf"[^>]*>').exec(markup)?.[0]).toContain("PDFに保存");
    // 次の版で作る入口は、いまは1つも無い
    expect(markup).not.toContain('class="soon"');
  });

  it("「PDF（この話）」は、打ちかけの字を送ってからカーソルの行を添えて送る（合本ではどの話かを行で知る）", () => {
    const env = { posted: [] as unknown[], clicks: {} as Record<string, () => void> };
    new Function(
      "env",
      `
      const vscode = { postMessage(message) { env.posted.push(message); } };
      function keyHandOver() { env.posted.push("handOver"); }
      function caretLine() { return 12; }
      const document = {
        getElementById(id) {
          return { addEventListener(type, fn) { if (type === "click") env.clicks[id] = fn; } };
        },
      };
      ${markedBlock("pdfButton")}
      `
    )(env);
    env.clicks.exportPagePdf?.();
    expect(env.posted).toEqual(["handOver", { type: "exportEpisodePdf", line: 12 }]);
  });

  it("ブラウザ版（外部プロセスを起動できない）では「PDF（この話）」を隠す。手元では HTML が変わらない", () => {
    const browser = buildManuscriptEditorHtml("NONCE123", "vscode-resource:", undefined, {
      canRunProcesses: false,
    });
    expect(new RegExp('<button id="exportPagePdf"[^>]*>').exec(browser)?.[0]).toContain(" hidden ");
    // 人物の声は手元のエンジンへ繋ぐので、［出力］の［音声に書き出す］もブラウザ版では隠す（実装ルール7）
    expect(new RegExp('<button id="exportVoice"[^>]*>').exec(browser)?.[0]).toContain(" hidden ");
    expect(new RegExp('<button id="exportVoice"[^>]*>').exec(html)?.[0]).not.toContain("hidden");
    // バックアップからはブラウザ版でも使える（番号ずらしだけを中で並べない。0.147.0 と同じ）
    expect(new RegExp('<button id="importBackup"[^>]*>').exec(browser)?.[0]).not.toContain("hidden");
    const desktop = buildManuscriptEditorHtml("NONCE123", "vscode-resource:", undefined, {
      canRunProcesses: true,
    });
    expect(desktop).toBe(html);
  });
});

describe("［入力］の取り込み（テキストファイル・Word。0.147.0）", () => {
  function importHarness() {
    const env = {
      posted: [] as unknown[],
      clicks: {} as Record<string, () => void>,
    };
    new Function(
      "env",
      `
      const vscode = { postMessage(message) { env.posted.push(message); } };
      function keyHandOver() { env.posted.push("handOver"); }
      const document = {
        getElementById(id) {
          return { addEventListener(type, fn) { if (type === "click") env.clicks[id] = fn; } };
        },
      };
      ${markedBlock("importButtons")}
      `
    )(env);
    return env;
  }

  it("押すと、打ちかけの字を送ってから入口（text／word／backup）を拡張機能へ送る", () => {
    const env = importHarness();
    env.clicks.importText?.();
    env.clicks.importWord?.();
    env.clicks.importBackup?.();
    expect(env.posted).toEqual([
      "handOver",
      { type: "importEpisode", source: "text" },
      "handOver",
      { type: "importEpisode", source: "word" },
      "handOver",
      { type: "importEpisode", source: "backup" },
    ]);
  });

  it("入口の印（soon）は外れ、何が起きるかを説明に書く", () => {
    for (const id of ["importText", "importWord"]) {
      const tag = new RegExp(`<button id="${id}"[^>]*>`).exec(markup)?.[0] ?? "";
      expect(tag, id).not.toContain('class="soon"');
      expect(tag, id).not.toContain("次の版で入ります");
      expect(tag, id).toContain("最後に加える");
    }
  });
});

describe("［投稿］の品書き", () => {
  function runOpenPostingMenu() {
    const env = { items: [] as Array<{ kind: string; label: string; title: string; click?: () => void }>, posted: [] as unknown[] };
    const open = new Function(
      "env",
      `
      const vscode = { postMessage(message) { env.posted.push(message); } };
      let menuTerm = null;
      let menuOwner = "";
      function closeMenu() {}
      function keyHandOver() { env.posted.push("handOver"); }
      function caretLine() { return 7; }
      function placeMenu() {}
      const menu = {
        set innerHTML(value) { env.items.length = 0; },
        appendChild(node) { env.items.push(node.item); },
      };
      const document = {
        createElement() {
          const item = { kind: "item", label: "", title: "" };
          return {
            item,
            set className(value) { if (value === "rule") item.kind = "rule"; },
            set textContent(value) { item.label = value; },
            set title(value) { item.title = value; },
            addEventListener(type, fn) { if (type === "click") item.click = fn; },
          };
        },
      };
      ${functionSource("openPostingMenu", "function openMenu(")}
      return openPostingMenu;
      `
    )(env) as (anchor: { left: number; bottom: number }) => void;
    open({ left: 10, bottom: 30 });
    return env;
  }

  it("投稿ヘルパーへ渡す・コピー（投稿サイト用）・投稿サイト設定・投稿と読者の反応が選べる", () => {
    const { items } = runOpenPostingMenu();
    expect(items.map((item) => (item.kind === "rule" ? "―" : item.label))).toEqual([
      "投稿ヘルパーへ渡す",
      "コピー（投稿サイト用）",
      "―",
      "投稿サイト設定",
      "投稿と読者の反応…",
    ]);
    for (const item of items.filter((entry) => entry.kind === "item")) {
      expect(item.title, item.label).not.toBe("");
    }
  });

  it("コピーは今のボタンと同じ便（copyForPosting にカーソルの行を添える）", () => {
    const env = runOpenPostingMenu();
    env.items.find((item) => item.label === "コピー（投稿サイト用）")?.click?.();
    expect(env.posted).toEqual([{ type: "copyForPosting", line: 7 }]);
  });

  it("ヘルパー・設定・読者の反応は、打ちかけの字を送ってから名前で頼む", () => {
    const env = runOpenPostingMenu();
    for (const label of ["投稿ヘルパーへ渡す", "投稿サイト設定", "投稿と読者の反応…"]) {
      env.items.find((item) => item.label === label)?.click?.();
    }
    expect(env.posted).toEqual([
      "handOver",
      { type: "runPosting", action: "helper" },
      "handOver",
      { type: "runPosting", action: "settings" },
      "handOver",
      { type: "runPosting", action: "readers" },
    ]);
  });

  it("押した click で品書きがすぐ閉じないよう、ボタンでは伝わりを止める", () => {
    const start = code.indexOf('getElementById("posting").addEventListener("click"');
    expect(start).toBeGreaterThan(0);
    expect(code.slice(start, start + 300)).toContain("event.stopPropagation()");
  });

  it("画面から届く名前は表で命令へ直し、知らない名前は受け取らない", () => {
    expect(MANUSCRIPT_POSTING_ACTIONS).toEqual({
      helper: "novelai.postThisEpisode",
      settings: "novelai.configurePostingSites",
      readers: "novelai.postingAndReaders",
    });
    expect(postingActionCommand("helper")).toBe("novelai.postThisEpisode");
    expect(postingActionCommand("toString")).toBeUndefined();
    expect(postingActionCommand(undefined)).toBeUndefined();
  });
});

describe("下の欄", () => {
  it("前の話・次の話・最新話・保存の順（最新話は今の口述の所、保存は右端）", () => {
    expect(buttons(block("bottom"))).toEqual([
      ["prev", "← 前の話"],
      ["next", "次の話 →"],
      ["latest", "最新話"],
      ["saveCheck", "保存"],
    ]);
    expect(html).toContain("#saveCheck { margin-left: auto; }");
    expect(html).not.toContain("#latest { margin-left: auto; }");
  });

  it("字数の欄（#foot）には［保存］を置かない", () => {
    const foot = html.slice(html.indexOf('<div id="foot">'), html.indexOf('<div id="menu">'));
    expect(foot).not.toContain('id="saveCheck"');
  });
});
