import { describe, expect, it } from "vitest";
import { buildManuscriptEditorHtml } from "../../../src/views/manuscriptEditorHtml";
import { proofCheckCommand } from "../../../src/core/manuscriptKeys";

/**
 * 原稿エディターの上の列の［校正］（作者の判断 2026-11-02「校正ボタンで校正パネルが
 * ひらけるようにしましょう」）。
 *
 * 押すと品書きに「誤字脱字・推敲・表記ゆれ・まとめて校正」と、区切りの下に
 * 「校正・メモパネルを開く」が並ぶ。画面へ渡る本物のスクリプトを切り出して
 * 動かす（manuscriptEditorClipboardMenu.test.ts と同じやり方）。
 */

const html = buildManuscriptEditorHtml("NONCE123", "vscode-resource:");
const code = html.slice(html.indexOf("<script"));

function functionSource(name: string, until: string): string {
  const start = code.indexOf(`function ${name}(`);
  const end = code.indexOf(until, start);
  expect(start, `${name} が見つからない`).toBeGreaterThan(0);
  expect(end, `${name} の終わりが見つからない`).toBeGreaterThan(start);
  return code.slice(start, end);
}

interface MenuItem {
  kind: "item" | "rule";
  label: string;
  title: string;
  click?: () => void;
}

interface ProofMenuRun {
  items: MenuItem[];
  posted: unknown[];
  closed: number;
  style: Record<string, string>;
}

/**
 * @param faceWidth 面の幅（document.documentElement.clientWidth）
 * @param naturalWidth 品書きが字の幅まで広がったときの幅。置く側が決めた最大幅で頭打ちになる
 */
function runOpenProofMenu(faceWidth = 300, naturalWidth = 200): ProofMenuRun {
  const source = functionSource("openProofMenu", "function openMenu(");
  const place = functionSource("placeMenu", "function termAtCaret(");
  const env: ProofMenuRun & { faceWidth: number; naturalWidth: number } = {
    items: [],
    posted: [],
    closed: 0,
    style: {},
    faceWidth,
    naturalWidth,
  };
  const open = new Function(
    "env",
    `
    const vscode = { postMessage(message) { env.posted.push(message); } };
    const window = { innerWidth: env.faceWidth, innerHeight: 400 };
    let menuTerm = null;
    let menuOwner = "";
    function closeMenu() { env.closed += 1; }
    function keyHandOver() { env.posted.push("handOver"); }
    const menu = {
      set innerHTML(value) { env.items.length = 0; },
      classList: { add() {} },
      style: env.style,
      // 本物の箱と同じく、最大幅（縁取り込み）を超えては広がらない
      getBoundingClientRect() {
        const max = parseFloat(env.style.maxWidth ?? "Infinity");
        return { width: Math.min(env.naturalWidth, max), height: 150 };
      },
      appendChild(node) { env.items.push(node.item); },
    };
    const document = {
      documentElement: { clientWidth: env.faceWidth },
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
    ${source}
    ${place}
    return openProofMenu;
    `
  )(env) as (anchor: { left: number; bottom: number }) => void;
  open({ left: 28, bottom: 30 });
  return env;
}

describe("上の列の［校正］", () => {
  it("上の列に［校正］があり、別の［校正・メモパネル］ボタンは作らない", () => {
    const bar = html.slice(html.indexOf('<div id="bar">'), html.indexOf('<div id="aloud">'));
    expect(bar).toContain('<button id="proof"');
    expect(bar).toContain(">校正</button>");
    expect(bar).not.toContain(">校正・メモパネル</button>");
  });

  it("押した click で品書きがすぐ閉じないよう、ボタンでは伝わりを止める", () => {
    const start = code.indexOf('getElementById("proof").addEventListener("click"');
    expect(start).toBeGreaterThan(0);
    expect(code.slice(start, start + 300)).toContain("event.stopPropagation()");
  });

  it("4つの校正と、区切りの下に校正・メモパネル", () => {
    const { items } = runOpenProofMenu();
    expect(items.map((item) => (item.kind === "rule" ? "―" : item.label))).toEqual([
      "誤字脱字（この話）",
      "推敲",
      "表記ゆれ（作品全体）",
      "まとめて校正（作品全体）",
      "―",
      "校正・メモパネルを開く",
    ]);
    // 押す前に何をするか分かるよう、どれにも説明を付ける
    for (const item of items.filter((entry) => entry.kind === "item")) {
      expect(item.title, item.label).not.toBe("");
    }
  });

  it("面が品書きの最小幅より狭くても、縁取りまで面の中に収める（作者の裁定 2026-11-02。幅 400px の窓で面は約 188px）", () => {
    const { style } = runOpenProofMenu(188, 260);
    const left = parseFloat(style.left);
    const width = Math.min(260, parseFloat(style.maxWidth));
    expect(parseFloat(style.minWidth), "最小幅が面より広いままです").toBeLessThanOrEqual(188);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left + width, `品書きの右端が面の外に出ます（${JSON.stringify(style)}）`).toBeLessThanOrEqual(188);
  });

  it("広い面では最小幅 190px のまま、ボタンの下に出す", () => {
    const { style } = runOpenProofMenu(1000, 200);
    expect(style.minWidth).toBe("190px");
    expect(style.left).toBe("28px");
    expect(style.top).toBe("32px");
  });

  it("押すと品書きを閉じ、キーと同じ命令の名前で拡張機能へ頼む", () => {
    const env = runOpenProofMenu();
    const labels = env.items.filter((item) => item.kind === "item");
    for (const item of labels) item.click?.();
    expect(env.closed).toBe(labels.length);
    // 校正の前には、キーの道と同じく打ちかけの字を送る（handOver）
    expect(env.posted).toEqual([
      "handOver",
      { type: "runProofCheck", check: "typos" },
      "handOver",
      { type: "runProofCheck", check: "proofread" },
      "handOver",
      { type: "runProofCheck", check: "notation" },
      "handOver",
      { type: "runProofCheck", check: "suite" },
      { type: "openMemos" },
    ]);
    // 画面が送る名前は、拡張機能側の表にすべてある（受け取られずに黙らない）
    const runs = env.posted.filter(
      (message): message is { type: string; check: string } =>
        typeof message === "object" && (message as { type?: string }).type === "runProofCheck"
    );
    for (const message of runs) {
      expect(proofCheckCommand(message.check), message.check).toBeDefined();
    }
  });
});
