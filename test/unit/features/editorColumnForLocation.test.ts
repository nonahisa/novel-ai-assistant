import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 指摘の場所から**開いていない話**へ飛ぶとき、話を提案パネルの列へ開かない
 * （ノートPC・VS Code 1.141.0 の E2E、2026-10-11。`findingJumpVertical` が全件のときだけ落ちた）。
 *
 * ## 何が起きていたか
 *
 * 列が「1列目＝第1話の原稿／2列目＝提案パネル（前に出ている）」の並びで、
 * 提案パネルの「002_夜.txt N行目」を押すと、第2話が**2列目**に開いて
 * 提案パネルを裏へ回した。作者は飛んだあと続けてパネルの次の指摘を押すので、
 * パネルが隠れると続けて押せない。
 *
 * `columnForLocation` は「**前面の列**がパネルか」だけで避けるかを決めていた。
 * 拡張機能から見た前面の列（`isActive`）が1列目のままだと「列は指定なし」を返し、
 * VS Code は実際に前面にある2列目へ開く。前面の列の見え方は焦点の動きのタイミングで
 * 揺れるので、単独では通り、全件のときだけ落ちた。
 *
 * ## 直したあと
 *
 * 前面の列ではなく、**列ごとに前に出ているタブ**（と提案・シーンメモのパネルの居場所）で
 * 避ける列を決め、避けた先の列を名指しする。
 */

class TabInputWebview {
  constructor(public readonly viewType: string) {}
}
class TabInputText {
  constructor(public readonly uri: unknown) {}
}
class TabInputCustom {
  constructor(public readonly uri: unknown) {}
}
class TabInputNotebook {
  constructor(public readonly uri: unknown) {}
}

type FakeTab = { input: unknown };
type FakeGroup = { viewColumn: number; isActive: boolean; tabs: FakeTab[]; activeTab?: FakeTab };

let tabGroups: FakeGroup[] = [];

vi.mock("vscode", () => ({
  TabInputWebview,
  TabInputText,
  TabInputCustom,
  TabInputNotebook,
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
  window: {
    get tabGroups() {
      return { all: tabGroups };
    },
  },
}));

// 場所の比べ方はこのテストの関心ではない（手元のファイルだけを扱う）
vi.mock("../../../src/core/paths", () => ({
  fromUri: (uri: { fsPath: string }) => uri.fsPath,
  pathKeyForComparison: (location: string) => location.toLowerCase(),
}));

const { columnForLocation } = await import("../../../src/features/editorColumn");

const BESIDE = -2;
const FIRST = "C:/work/本文/001_朝.txt";
const SECOND = "C:/work/本文/002_夜.txt";

function file(location: string): FakeTab {
  return { input: new TabInputCustom({ scheme: "file", fsPath: location }) };
}
function webview(viewType: string): FakeTab {
  return { input: new TabInputWebview(`mainThreadWebview-${viewType}`) };
}
function group(viewColumn: number, tabs: FakeTab[], front: FakeTab, isActive: boolean): FakeGroup {
  return { viewColumn, isActive, tabs, activeTab: front };
}

describe("開いていない話へ飛ぶとき、提案パネルの列へ開かない", () => {
  beforeEach(() => {
    tabGroups = [];
  });

  it("拡張機能から見た前面が原稿の列でも、提案パネルが前に出ている列へは開かない（全件のときの形）", () => {
    const manuscript = file(FIRST);
    const proposals = webview("novelai.proposals");
    tabGroups = [
      group(1, [manuscript], manuscript, true),
      group(2, [proposals], proposals, false),
    ];
    expect(columnForLocation(SECOND).column).toBe(1);
  });

  it("前面の列が分からないとき（どの列も isActive でない）も、提案パネルの列を避ける", () => {
    const manuscript = file(FIRST);
    const proposals = webview("novelai.proposals");
    tabGroups = [
      group(1, [manuscript], manuscript, false),
      group(2, [proposals], proposals, false),
    ];
    expect(columnForLocation(SECOND).column).toBe(1);
  });

  it("提案パネルの列が前面のときも、原稿の列へ開く（これまでどおり）", () => {
    const manuscript = file(FIRST);
    const proposals = webview("novelai.proposals");
    tabGroups = [
      group(1, [manuscript], manuscript, false),
      group(2, [proposals], proposals, true),
    ];
    expect(columnForLocation(SECOND).column).toBe(1);
  });

  it("提案パネルが裏に回っていても、編集の面を持たない列なら避ける", () => {
    const manuscript = file(FIRST);
    const proposals = webview("novelai.proposals");
    const other = { input: { kind: "出力" } };
    tabGroups = [
      group(1, [manuscript], manuscript, false),
      group(2, [proposals, other], other, true),
    ];
    expect(columnForLocation(SECOND).column).toBe(1);
  });

  it("原稿の列の裏に提案パネルがあっても、原稿の列を追い出さない", () => {
    const manuscript = file(FIRST);
    const proposals = webview("novelai.proposals");
    tabGroups = [group(1, [proposals, manuscript], manuscript, true)];
    expect(columnForLocation(SECOND).column).not.toBe(BESIDE);
  });

  it("列が提案パネルの1つだけなら、その横へ開く（パネルの上に重ねない）", () => {
    const proposals = webview("novelai.proposals");
    tabGroups = [group(1, [proposals], proposals, false)];
    expect(columnForLocation(SECOND).column).toBe(BESIDE);
  });

  it("既に開いている話は、その列のまま（パネルの列でも動かさない）", () => {
    const manuscript = file(FIRST);
    const second = file(SECOND);
    const proposals = webview("novelai.proposals");
    tabGroups = [
      group(1, [manuscript], manuscript, true),
      group(2, [proposals, second], proposals, false),
    ];
    expect(columnForLocation(SECOND).column).toBe(2);
  });

  it("パネルがどこにも無ければ、列は決めない（下段の提案パネルから飛ぶ道）", () => {
    const manuscript = file(FIRST);
    tabGroups = [group(1, [manuscript], manuscript, true)];
    expect(columnForLocation(SECOND).column).toBeUndefined();
  });

  it("避けた先が複数あるときは、前面の列を好む（無ければ左の列）", () => {
    const a = file(FIRST);
    const b = file("C:/work/本文/003_昼.txt");
    const memo = webview("novelai.sceneMemos");
    tabGroups = [
      group(1, [a], a, false),
      group(2, [b], b, true),
      group(3, [memo], memo, false),
    ];
    expect(columnForLocation(SECOND).column).toBe(2);
    tabGroups[1].isActive = false;
    expect(columnForLocation(SECOND).column).toBe(1);
  });
});

describe("避けるパネルの種類は、パネルの側の名前と同じ", () => {
  // `editorColumn.ts` は輪を避けるため viewType を自前で持つ。パネルの側で名前を
  // 変えたときに、こちらだけ古い名前で探し続けないよう見張る
  it("提案・シーンメモの viewType", async () => {
    const { readFileSync } = await import("node:fs");
    const column = readFileSync("src/features/editorColumn.ts", "utf8");
    expect(readFileSync("src/features/proposalPanel.ts", "utf8")).toContain(
      'export const PROPOSALS_PANEL_TYPE = "novelai.proposals";'
    );
    expect(readFileSync("src/features/sceneMemoPanel.ts", "utf8")).toContain(
      'export const SCENE_MEMO_VIEW_TYPE = "novelai.sceneMemos";'
    );
    expect(column).toContain('const SIDE_PANEL_TYPES = ["novelai.proposals", "novelai.sceneMemos"];');
  });
});
