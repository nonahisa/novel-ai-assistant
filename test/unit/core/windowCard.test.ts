import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import {
  WINDOW_CARD_DIRECTORY,
  WINDOW_CARD_HEARTBEAT_MS,
  WINDOW_CARD_SCHEMA,
  WINDOW_CARD_STALE_AFTER_MS,
  buildWindowCard,
  describeWindowCards,
  parseWindowCard,
  serializeWindowCard,
  shortMachineName,
  windowCardFileName,
  worksOpenInWindow,
  type WindowCard,
} from "../../../src/core/windowCard";
import { GLOBAL_STORAGE_ENV, mcpGlobalStorageRoot } from "../../../src/mcp/globalStorage";
import { ADVICE_STORAGE_ENV } from "../../../src/mcp/adviceProfileMirror";
import { mcpMachineName, windowsList } from "../../../src/mcp/tools/windows";
import { exposureOf } from "../../../src/mcp/tools/accessLog";
import { assertExternalAccessAllowed } from "../../../src/mcp/tools/permission";

/**
 * 窓の札と MCP の道具 `windows.list`（作者の依頼、2026-09-22）。
 *
 * **見張りたいのは3つ。**
 *
 * 1. **閉じ損ねた札に印が付くこと。** `deactivate` は待たれないことがあり、
 *    消せなかった札が「開いている窓」として並ぶと、実機確認で別の窓を
 *    相手にしてしまう
 * 2. **1枚壊れていても一覧が止まらないこと**
 * 3. **保管庫の場所を、助言方針の控えと同じ道で決めていること**（写しを作らない）
 */

const NOW = new Date("2026-09-23T10:00:00.000Z");

function card(overrides: Partial<WindowCard> = {}): WindowCard {
  return {
    ...buildWindowCard({
      pid: 1234,
      extensionVersion: "0.75.11",
      vscodeVersion: "1.138.0",
      appName: "Visual Studio Code",
      workspaceName: "書庫",
      developmentHost: false,
      folders: ["C:/works/書庫"],
      startedAt: new Date("2026-09-23T09:00:00.000Z"),
      now: new Date("2026-09-23T09:58:00.000Z"),
    }),
    ...overrides,
  };
}

describe("札の組み立て（buildWindowCard）", () => {
  it("決めた項目がすべて入る", () => {
    const built = buildWindowCard({
      pid: 42,
      extensionVersion: "0.75.11",
      vscodeVersion: "1.138.0",
      appName: "Visual Studio Code",
      workspaceName: undefined,
      developmentHost: true,
      folders: ["C:/a", "C:/b"],
      startedAt: new Date("2026-09-23T09:00:00.000Z"),
      now: NOW,
    });
    expect(built).toEqual({
      schema: WINDOW_CARD_SCHEMA,
      pid: 42,
      extensionVersion: "0.75.11",
      vscodeVersion: "1.138.0",
      appName: "Visual Studio Code",
      // **フォルダーを開いていない窓は null**（JSON から項目ごと消さない）
      workspaceName: null,
      developmentHost: true,
      folders: ["C:/a", "C:/b"],
      // 渡さなければ「取れなかった」「作品を開いていない」
      machineName: null,
      works: [],
      startedAt: "2026-09-23T09:00:00.000Z",
      updatedAt: "2026-09-23T10:00:00.000Z",
    });
    expect(JSON.parse(serializeWindowCard(built))).toHaveProperty(
      "workspaceName",
      null
    );
  });

  it("ファイル名はプロセス番号だけで決まる（1窓1ファイル）", () => {
    expect(windowCardFileName(4321)).toBe("4321.json");
  });

  it("置き場は保管庫の .aiwriter/windows", () => {
    expect([...WINDOW_CARD_DIRECTORY]).toEqual([".aiwriter", "windows"]);
  });
});

describe("札を読む（parseWindowCard）", () => {
  it("書いたものをそのまま読み戻せる", () => {
    const original = card();
    expect(parseWindowCard(serializeWindowCard(original))).toEqual(original);
  });

  it("壊れた札は投げずに undefined", () => {
    expect(parseWindowCard("")).toBeUndefined();
    expect(parseWindowCard("{書きかけ")).toBeUndefined();
    expect(parseWindowCard("[]")).toBeUndefined();
    expect(parseWindowCard("null")).toBeUndefined();
    // 知らない版
    expect(
      parseWindowCard(JSON.stringify({ ...card(), schema: 99 }))
    ).toBeUndefined();
    // 項目の型が違う
    expect(
      parseWindowCard(JSON.stringify({ ...card(), pid: "1234" }))
    ).toBeUndefined();
    expect(
      parseWindowCard(JSON.stringify({ ...card(), folders: "C:/a" }))
    ).toBeUndefined();
    expect(
      parseWindowCard(JSON.stringify({ ...card(), developmentHost: "yes" }))
    ).toBeUndefined();
  });
});

describe("古い札に印を付ける（describeWindowCards）", () => {
  it("打ち直し3回ぶんより古い札は「たぶん閉じた」", () => {
    expect(WINDOW_CARD_STALE_AFTER_MS).toBe(3 * WINDOW_CARD_HEARTBEAT_MS);
    const fresh = card({ pid: 1, updatedAt: "2026-09-23T09:58:00.000Z" });
    const edge = card({
      pid: 2,
      updatedAt: new Date(NOW.getTime() - WINDOW_CARD_STALE_AFTER_MS).toISOString(),
    });
    const stale = card({ pid: 3, updatedAt: "2026-09-23T09:30:00.000Z" });
    const views = describeWindowCards([stale, fresh, edge], NOW);
    const byPid = new Map(views.map((view) => [view.pid, view]));
    expect(byPid.get(1)?.probablyClosed).toBe(false);
    expect(byPid.get(1)?.minutesSinceUpdate).toBe(2);
    // ちょうど境目はまだ開いている扱い（1回遅れた程度で閉じたと言わない）
    expect(byPid.get(2)?.probablyClosed).toBe(false);
    expect(byPid.get(3)?.probablyClosed).toBe(true);
    expect(byPid.get(3)?.minutesSinceUpdate).toBe(30);
  });

  it("新しく打ち直した窓が先に並ぶ", () => {
    const views = describeWindowCards(
      [
        card({ pid: 1, updatedAt: "2026-09-23T09:00:00.000Z" }),
        card({ pid: 2, updatedAt: "2026-09-23T09:59:00.000Z" }),
        card({ pid: 3, updatedAt: "壊れた時刻" }),
        card({ pid: 4, updatedAt: "2026-09-23T09:30:00.000Z" }),
      ],
      NOW
    );
    expect(views.map((view) => view.pid)).toEqual([2, 4, 1, 3]);
  });

  it("読めない時刻は「たぶん閉じた」側へ倒す", () => {
    const [view] = describeWindowCards([card({ updatedAt: "?" })], NOW);
    expect(view.probablyClosed).toBe(true);
    expect(view.minutesSinceUpdate).toBeNull();
  });

  it("先の時刻（時計のずれ）は、いま打ち直したとみなす", () => {
    const [view] = describeWindowCards(
      [card({ updatedAt: "2026-09-23T10:05:00.000Z" })],
      NOW
    );
    expect(view.probablyClosed).toBe(false);
    expect(view.minutesSinceUpdate).toBe(0);
  });
});

describe("MCP の道具 windows.list", () => {
  let storage: string;
  let previousEnv: string | undefined;

  beforeEach(() => {
    storage = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-windows-"));
    previousEnv = process.env[GLOBAL_STORAGE_ENV];
    process.env[GLOBAL_STORAGE_ENV] = storage;
  });

  afterEach(() => {
    if (previousEnv === undefined) delete process.env[GLOBAL_STORAGE_ENV];
    else process.env[GLOBAL_STORAGE_ENV] = previousEnv;
    fs.rmSync(storage, { recursive: true, force: true });
  });

  function place(name: string, text: string): void {
    const directory = nodePath.join(storage, ...WINDOW_CARD_DIRECTORY);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(nodePath.join(directory, name), text, "utf8");
  }

  it("札を一覧で返し、古い札に印を付ける", () => {
    place(
      "100.json",
      serializeWindowCard(
        card({ pid: 100, developmentHost: true, updatedAt: "2026-09-23T09:59:00.000Z" })
      )
    );
    place(
      "200.json",
      serializeWindowCard(card({ pid: 200, updatedAt: "2026-09-23T08:00:00.000Z" }))
    );
    const result = windowsList(NOW);
    expect(result.storage).toBe(nodePath.join(storage, ...WINDOW_CARD_DIRECTORY));
    expect(result.windows.map((view) => [view.pid, view.probablyClosed])).toEqual([
      [100, false],
      [200, true],
    ]);
    expect(result.windows[0].developmentHost).toBe(true);
    expect(result.unreadable).toEqual([]);
  });

  it("壊れた札があっても止めず、読めなかったものを添える", () => {
    place("100.json", serializeWindowCard(card({ pid: 100 })));
    place("300.json", "{書きかけ");
    const result = windowsList(NOW);
    expect(result.windows.map((view) => view.pid)).toEqual([100]);
    expect(result.unreadable).toEqual([
      { file: "300.json", reason: "札の形になっていません" },
    ]);
  });

  it("書きかけの一時ファイルは札として数えない", () => {
    place("100.json", serializeWindowCard(card({ pid: 100 })));
    place("100.json.novelai-1-abc.tmp", "{");
    const result = windowsList(NOW);
    expect(result.windows).toHaveLength(1);
    expect(result.unreadable).toEqual([]);
  });

  it("札が1枚も無くても失敗にしない", () => {
    const result = windowsList(NOW);
    expect(result.windows).toEqual([]);
    expect(result.note).toContain("札が1枚もありません");
  });

  it("札を1バイトも書き換えない（読むだけ）", () => {
    const text = serializeWindowCard(card({ pid: 100, updatedAt: "2026-09-23T01:00:00.000Z" }));
    place("100.json", text);
    windowsList(NOW);
    expect(
      fs.readFileSync(
        nodePath.join(storage, ...WINDOW_CARD_DIRECTORY, "100.json"),
        "utf8"
      )
    ).toBe(text);
  });
});

describe("保管庫の場所は、助言方針の控えと同じ道で決める", () => {
  it("環境変数の名前は1つ（写しを作らない）", () => {
    expect(ADVICE_STORAGE_ENV).toBe(GLOBAL_STORAGE_ENV);
  });

  it("束の居場所を読む処理は globalStorage.ts だけにある", () => {
    // 2か所で別々に決めると、片方だけが別の場所を指す日が来る
    const mcpDir = nodePath.join(__dirname, "../../../src/mcp");
    const advice = fs.readFileSync(nodePath.join(mcpDir, "adviceProfileMirror.ts"), "utf8");
    const windows = fs.readFileSync(nodePath.join(mcpDir, "tools/windows.ts"), "utf8");
    expect(advice).not.toMatch(/process\.argv/);
    expect(windows).not.toMatch(/process\.argv/);
    expect(advice).toContain("mcpGlobalStorageRoot");
    expect(windows).toContain("mcpGlobalStorageRoot");
  });

  it("環境変数が無ければ、束の居場所の親フォルダー", () => {
    const previous = process.env[GLOBAL_STORAGE_ENV];
    delete process.env[GLOBAL_STORAGE_ENV];
    try {
      expect(mcpGlobalStorageRoot()).toBe(
        nodePath.dirname(nodePath.resolve(process.argv[1]))
      );
    } finally {
      if (previous !== undefined) process.env[GLOBAL_STORAGE_ENV] = previous;
    }
  });
});

describe("許可と記録は mcp.version と同じ扱い", () => {
  it("作品を指さないので、許可の印が無くても断らない", () => {
    expect(() => assertExternalAccessAllowed({}, "windows.list")).not.toThrow();
    expect(() => assertExternalAccessAllowed(undefined, "windows.list")).not.toThrow();
  });

  it("原稿は外へ出ない", () => {
    expect(exposureOf("windows.list", undefined)).toBe("none");
  });
});

describe("道具の数を書いた文書が、登録と揃っている", () => {
  const root = nodePath.join(__dirname, "../../..");
  const server = fs.readFileSync(nodePath.join(root, "src/mcp/server.ts"), "utf8");
  const registered = [...server.matchAll(/registerTool\(\s*"([\w.]+)"/g)].map(
    (match) => match[1]
  );

  it("windows.list が登録されている", () => {
    expect(registered).toContain("windows.list");
  });

  it("server.ts の断り書きの本数", () => {
    const stated = server.match(/\*\*道具は(\d+)本\*\*/);
    expect(stated && Number(stated[1])).toBe(registered.length);
  });

  it("外部AIへ配るスキル（novel-assist.md）の本数", () => {
    const skill = fs.readFileSync(
      nodePath.join(root, "docs/skills/novel-assist.md"),
      "utf8"
    );
    const stated = skill.match(/\*\*道具は(\d+)本で/);
    expect(stated && Number(stated[1])).toBe(registered.length);
    // 早見表に載っていない道具は、外部AIが存在を知らない
    // （全部の道具を突き合わせないのは、`ollama.generate` が早見表に
    // 無いのが意図かどうかをここでは決めないため）
    expect(skill).toContain("`windows.list`");
  });
});

/**
 * 機械の名前と、窓で開いている作品（作者の依頼、2026-09-22 未明「B2」）。
 *
 * 2台（デスクトップとノートPC）で作業していて、**どの窓がどの機械の
 * どの作品を開いているか**を、機械（MCP のクライアント）が見分けたい。
 * 版と開発ホストかは札に既にあった。足りなかったのは次の2つ。
 *
 * - **機械の名前**（`os.hostname()` の短い形）。ドメインは落とし、
 *   ユーザー名やパスは足さない
 * - **開いている作品の名前**。フォルダーの場所（`folders`）だけでは、
 *   書庫を開いた窓でどの作品かが読めない
 *
 * **古い版が書いた札も読めること**を見張る。2台で版がずれていると、
 * 片方の窓は新しい項目の無い札を書く——それを「壊れた札」にすると、
 * 版を確かめたいまさにその窓が一覧から消える。
 */
describe("機械の名前（shortMachineName）", () => {
  it("ドメインを落とし、前後の空白を削る", () => {
    expect(shortMachineName("DESKTOP-AB12CD")).toBe("DESKTOP-AB12CD");
    expect(shortMachineName("  note-pc.local ")).toBe("note-pc");
    expect(shortMachineName("太郎のPC")).toBe("太郎のPC");
  });

  it("取れない・空なら null（空文字を名乗らない）", () => {
    expect(shortMachineName(undefined)).toBeNull();
    expect(shortMachineName("")).toBeNull();
    expect(shortMachineName("   ")).toBeNull();
    expect(shortMachineName(".local")).toBeNull();
  });

  it("長すぎる名前は切る（札が名前で膨れない）", () => {
    expect(shortMachineName("a".repeat(200))).toHaveLength(63);
  });
});

describe("窓で開いている作品（worksOpenInWindow）", () => {
  const works = [
    { title: "教科書チート", folderPath: "C:/書庫/教科書チート" },
    { title: "灯台の子", folderPath: "C:/書庫/灯台の子" },
    { title: "別の置き場", folderPath: "D:/ほか/別の置き場" },
  ];

  it("書庫を開いた窓では、その中の作品を全部挙げる", () => {
    expect(worksOpenInWindow(works, ["C:/書庫"])).toEqual([
      "教科書チート",
      "灯台の子",
    ]);
  });

  it("作品フォルダーそのもの・作品の中のフォルダーを開いた窓も、その作品", () => {
    expect(worksOpenInWindow(works, ["C:/書庫/灯台の子"])).toEqual(["灯台の子"]);
    expect(worksOpenInWindow(works, ["C:/書庫/教科書チート/本文"])).toEqual([
      "教科書チート",
    ]);
  });

  it("名前が前方一致するだけの別フォルダーは含めない", () => {
    expect(
      worksOpenInWindow(
        [{ title: "灯台", folderPath: "C:/書庫/灯台" }],
        ["C:/書庫/灯台の子"]
      )
    ).toEqual([]);
  });

  it("フォルダーを開いていない窓は空", () => {
    expect(worksOpenInWindow(works, [])).toEqual([]);
  });
});

describe("札の新しい項目（machineName・works）", () => {
  it("組み立てると入る", () => {
    const built = buildWindowCard({
      pid: 7,
      extensionVersion: "0.83.1",
      vscodeVersion: "1.138.0",
      appName: "Visual Studio Code",
      workspaceName: "書庫",
      developmentHost: false,
      folders: ["C:/書庫"],
      machineName: "DESKTOP-AB12CD",
      works: ["教科書チート"],
      startedAt: new Date("2026-09-23T09:00:00.000Z"),
      now: NOW,
    });
    expect(built.machineName).toBe("DESKTOP-AB12CD");
    expect(built.works).toEqual(["教科書チート"]);
    expect(parseWindowCard(serializeWindowCard(built))).toEqual(built);
  });

  it("古い版が書いた札（項目が無い）も読める。無いものは null と空で埋める", () => {
    const old = JSON.parse(serializeWindowCard(card())) as Record<string, unknown>;
    delete old.machineName;
    delete old.works;
    const parsed = parseWindowCard(JSON.stringify(old));
    expect(parsed).toBeDefined();
    expect(parsed?.machineName).toBeNull();
    expect(parsed?.works).toEqual([]);
  });

  it("型が違えば壊れた札として扱う", () => {
    expect(
      parseWindowCard(JSON.stringify({ ...card(), machineName: 12 }))
    ).toBeUndefined();
    expect(
      parseWindowCard(JSON.stringify({ ...card(), works: "教科書チート" }))
    ).toBeUndefined();
  });

  it("札にユーザー名や家のフォルダーの場所を足していない", () => {
    // 足したのは機械の名前と作品の名前だけ。`os.userInfo()` や
    // `os.homedir()` を札へ入れる道を作らない
    const source = fs.readFileSync(
      nodePath.join(__dirname, "../../../src/features/windowCard.ts"),
      "utf8"
    );
    expect(source).not.toMatch(/userInfo|homedir/);
  });
});

describe("windows.list と mcp.version が機械の名前を返す", () => {
  it("windows.list の返事に、この機械の名前が入る", () => {
    const result = windowsList(NOW);
    expect(result.machineName).toBe(shortMachineName(os.hostname()));
  });

  it("mcp.version もこの機械の名前を返す（同じ関数を通す）", () => {
    expect(mcpMachineName()).toBe(shortMachineName(os.hostname()));
    const server = fs.readFileSync(
      nodePath.join(__dirname, "../../../src/mcp/server.ts"),
      "utf8"
    );
    const versionTool = server.slice(
      server.indexOf('tool("mcp.version"'),
      server.indexOf('"windows.list"')
    );
    expect(versionTool).toContain("machineName: mcpMachineName()");
  });
});
