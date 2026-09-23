import { readFileSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FileSystemError, workspace } from "../support/vscodeStub";
import {
  latestSpotlightRequest,
  parseSpotlightRequestLine,
  parseSpotlightRequestLog,
} from "../../../src/core/spotlightRequest";
import { guideSpotlight } from "../../../src/mcp/tools/spotlight";
import {
  exposureOf,
  setExternalClientName,
} from "../../../src/mcp/tools/accessLog";
import { assertExternalAccessAllowed } from "../../../src/mcp/tools/permission";
import { IGNORED_PATHS } from "../../../src/core/workRegistry";
import { SpotlightRequestWatcher } from "../../../src/features/spotlightRequestWatcher";
import type {
  ActionSpotlight,
  SpotlightResult,
} from "../../../src/features/actionSpotlight";
import { findAction, menuEntries } from "../../../src/views/actionList";
import type { WorkEntry } from "../../../src/models/types";

/**
 * AI の答えで、メニュー項目を2回点滅させる（設計書6.104。0.75.6）。
 *
 * **作者の指示（2026-09-22）**：「テストでも製品版でも、AIからの回答で
 * 点滅すると良いと思うので、内部と外部のAIからメニュー操作して2回点滅を
 * 出せるようにしてください」。
 *
 * **作者が承認した例外**——外から呼ぶ口は読む・測る・提案するまで（6.87.7）
 * だが、画面の項目を光らせることだけは許された。**命令は実行しない。**
 *
 * ここで見張るのは4つ。
 *
 * 1. 内部（相談パネル）の受け口・送り口が揃っていること
 * 2. **案内の最中は、答えから勝手に光らせない**（印の奪い合いになる）
 * 3. 外部（MCP `guide.spotlight`）が jsonl へ1行だけ足し、**原稿を触らない**。
 *    許可の無い作品では断られる
 * 4. 見張りが、**新しい行でだけ**光らせる（壊れた行で落ちない）
 */

const work: WorkEntry = {
  id: "w1",
  title: "ためし",
  folderPath: "C:\\works\\w1",
  registeredAt: "2026-09-22T00:00:00.000Z",
};

/** 実在する操作（この試験の前提が変わったら、ここで気づける） */
const REAL_COMMAND = "novelai.checkContradictions";

describe("内部（相談パネル）の繋ぎ目", () => {
  const html = readFileSync("src/views/workChatPanelHtml.ts", "utf8");
  const panel = readFileSync("src/features/workChatPanel.ts", "utf8");

  test("画面が「光らせる」を送り、相談パネルが受けている", () => {
    expect(html, "光らせる札を送っていない").toContain("type: 'spotlight'");
    expect(html, "答えに札を出していない").toContain(
      // 答えの下に付くものは `appendAnswerExtras` にまとまっている（2026-09-23）
      "appendSpotlight(turn, extras.spotlight)"
    );
    expect(panel, "相談パネルが受けていない").toContain(
      'message.type === "spotlight"'
    );
    expect(panel).toContain("this.spotlightCommand(message.command)");
  });

  test("札は押しても無効化しない（何度でも光らせられる）", () => {
    // 目を離している間に選択が動くので、1回きりだと見失ったら戻れない
    const at = html.indexOf("function appendSpotlight(");
    expect(at, "札を出す関数が無い").toBeGreaterThan(-1);
    const body = html.slice(at, html.indexOf("function appendLocate(", at));
    expect(body, "押したら無効化している").not.toContain("disabled = true");
  });

  test("答えの中の名指しから、同じ ActionSpotlight を通している", () => {
    // **写しを作らない。** 案内と答えで瞬き方が変わると、直し漏れが出る
    expect(panel).toContain("findMenuMentions(reply, menuEntries())");
    expect(panel).toContain("this.spotlight.show(mentions[0].command)");
    // **案内中は自動で光らせない**（段の印と奪い合いになる）
    expect(panel).toContain("if (this.tour.isActive()) return mentions;");
    // 答えを送る前に光らせる（読んでいる間にサイドバーが動かないように）
    expect(panel.indexOf("const spotlight = await this.spotlightMentions(")).
      toBeGreaterThan(-1);
  });

  test("画面から届いたコマンドを、実行はしない", () => {
    const at = panel.indexOf("private async spotlightCommand(");
    expect(at).toBeGreaterThan(-1);
    const body = panel.slice(at, at + 1_200);
    // メニューに実在するものだけを通す
    expect(body).toContain("menuEntries().some((entry) => entry.command === command)");
    // **`executeCommand` はここに出てこない**（光らせるだけ）
    expect(body, "コマンドを実行している").not.toContain("executeCommand");
  });
});

describe("外部（MCP guide.spotlight）", () => {
  let folder: string;

  beforeEach(() => {
    folder = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-spotlight-"));
    setExternalClientName("テストの呼び出し元");
  });

  afterEach(() => {
    fs.rmSync(folder, { recursive: true, force: true });
    setExternalClientName("");
  });

  const logPath = (): string =>
    nodePath.join(folder, ".aiwriter", "history", "spotlight.jsonl");

  test("jsonl へ1行だけ追記する", () => {
    const result = guideSpotlight({ folder, command: REAL_COMMAND });
    expect(result.requested).toBe(true);
    expect(result.command).toBe(REAL_COMMAND);
    // **いつ光るのかを誤解させない**（閉じていれば次に開いたとき）
    expect(result.note).toContain("次に開いたとき");

    const entries = parseSpotlightRequestLog(
      fs.readFileSync(logPath(), "utf8")
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].command).toBe(REAL_COMMAND);
    expect(entries[0].client).toBe("テストの呼び出し元");
  });

  test("2回頼めば2行になる（追記だけ。前の行を消さない）", () => {
    guideSpotlight({ folder, command: REAL_COMMAND });
    guideSpotlight({ folder, label: "推敲" });
    const entries = parseSpotlightRequestLog(
      fs.readFileSync(logPath(), "utf8")
    );
    expect(entries).toHaveLength(2);
  });

  test("原稿も設定資料も作らない・触らない", () => {
    fs.mkdirSync(nodePath.join(folder, "本文"));
    const episode = nodePath.join(folder, "本文", "episode_0001.md");
    fs.writeFileSync(episode, "もとの本文", "utf8");

    guideSpotlight({ folder, command: REAL_COMMAND });

    expect(fs.readFileSync(episode, "utf8")).toBe("もとの本文");
    // 足したのは依頼のファイル1つだけ
    expect(fs.readdirSync(nodePath.join(folder, ".aiwriter", "history"))).toEqual(
      ["spotlight.jsonl"]
    );
    expect(fs.existsSync(nodePath.join(folder, "設定"))).toBe(false);
  });

  test("何を光らせるか分からない呼び出しは断る", () => {
    // **受け取って捨てない。** 呼んだ側からは「届いたのに光らない」に見える
    expect(() => guideSpotlight({ folder })).toThrow(/command か label/);
    expect(() => guideSpotlight({ folder: "", command: REAL_COMMAND })).toThrow(
      /folder/
    );
    expect(fs.existsSync(logPath())).toBe(false);
  });

  test("許可が無ければ、道具が動く前に断られる", () => {
    // 印（`.aiwriter/external-access.json`）が無い＝既定の拒否
    expect(() =>
      assertExternalAccessAllowed(
        { folder, command: REAL_COMMAND },
        "guide.spotlight"
      )
    ).toThrow(/許可されていません/);

    // 許可すれば通る。**鍵は道具の名前**（feature を取らない道具のため）
    fs.mkdirSync(nodePath.join(folder, ".aiwriter"), { recursive: true });
    fs.writeFileSync(
      nodePath.join(folder, ".aiwriter", "external-access.json"),
      JSON.stringify({
        clients: [
          {
            name: "テストの呼び出し元",
            tools: ["guide.spotlight"],
            sampling: false,
          },
        ],
      }),
      "utf8"
    );
    expect(() =>
      assertExternalAccessAllowed(
        { folder, command: REAL_COMMAND },
        "guide.spotlight"
      )
    ).not.toThrow();
  });

  test("ほかの道具を許しても、この道具は別に許可が要る", () => {
    fs.mkdirSync(nodePath.join(folder, ".aiwriter"), { recursive: true });
    fs.writeFileSync(
      nodePath.join(folder, ".aiwriter", "external-access.json"),
      JSON.stringify({
        clients: [
          { name: "テストの呼び出し元", tools: ["typo"], sampling: false },
        ],
      }),
      "utf8"
    );
    expect(() =>
      assertExternalAccessAllowed({ folder }, "guide.spotlight")
    ).toThrow(/許可されていません/);
  });

  test("原稿は1文字も外へ出ない（記録の扱い）", () => {
    expect(exposureOf("guide.spotlight", { command: REAL_COMMAND })).toBe(
      "none"
    );
  });

  test("依頼のファイルは同期しない（その場限りの頼みのため）", () => {
    expect(IGNORED_PATHS).toContain(".aiwriter/history/spotlight.jsonl");
    // 隣の記録（原稿がどこまで外へ出たか）は**同期する**
    expect(IGNORED_PATHS).not.toContain(".aiwriter/history/external.jsonl");
  });

  test("サーバーに登録してあり、記録も取られる", () => {
    const source = readFileSync("src/mcp/server.ts", "utf8");
    expect(source).toContain('registerTool(\n  "guide.spotlight"');
    expect(source).toContain('tool("guide.spotlight"');
  });
});

describe("依頼の読み書き", () => {
  test("指し先の無い行・時刻の無い行は捨てる", () => {
    expect(
      parseSpotlightRequestLine('{"at":"2026-09-22T00:00:00.000Z"}')
    ).toBeUndefined();
    expect(
      parseSpotlightRequestLine('{"command":"novelai.x"}')
    ).toBeUndefined();
    expect(parseSpotlightRequestLine("{壊れている")).toBeUndefined();
    expect(parseSpotlightRequestLine("")).toBeUndefined();
  });

  test("新しいものが先に並ぶ", () => {
    const text = [
      '{"at":"2026-09-22T01:00:00.000Z","command":"a","label":"","client":""}',
      "{壊れている",
      '{"at":"2026-09-22T02:00:00.000Z","command":"b","label":"","client":""}',
    ].join("\n");
    const entries = parseSpotlightRequestLog(text);
    expect(entries.map((one) => one.command)).toEqual(["b", "a"]);
  });

  test("捌いた時刻より後のものだけを拾う", () => {
    const entries = parseSpotlightRequestLog(
      [
        '{"at":"2026-09-22T01:00:00.000Z","command":"a","label":"","client":""}',
        '{"at":"2026-09-22T02:00:00.000Z","command":"b","label":"","client":""}',
      ].join("\n")
    );
    expect(latestSpotlightRequest(entries, "")?.command).toBe("b");
    expect(
      latestSpotlightRequest(entries, "2026-09-22T01:30:00.000Z")?.command
    ).toBe("b");
    expect(
      latestSpotlightRequest(entries, "2026-09-22T02:00:00.000Z")
    ).toBeUndefined();
  });
});

/** 光らせた先を溜めるだけ */
class FakeSpotlight implements ActionSpotlight {
  readonly shown: string[] = [];
  constructor(private readonly result: SpotlightResult = {
    shown: true,
    view: "steps",
  }) {}
  async show(command: string): Promise<SpotlightResult> {
    this.shown.push(command);
    return this.result;
  }
  clear(): void {}
}

/** `globalState` の代役。**記憶の中だけで持つ** */
function fakeContext(): {
  globalState: { get: (key: string) => unknown; update: (key: string, value: unknown) => Promise<void> };
} {
  const store = new Map<string, unknown>();
  return {
    globalState: {
      get: (key: string) => store.get(key),
      update: async (key: string, value: unknown) => {
        store.set(key, value);
      },
    },
  };
}

describe("拡張機能側の見張り", () => {
  const files = new Map<string, string>();
  /**
   * `.aiwriter/history/spotlight.jsonl` の絶対パス（見張りが組むものと同じ）。
   *
   * **小文字に揃えて持つ。** `Uri.file` はドライブ文字を小文字へ倒すので、
   * 大文字のまま鍵にすると、置いた作り物が見つからない
   */
  const target = nodePath
    .join(work.folderPath, ".aiwriter", "history", "spotlight.jsonl")
    .toLowerCase();

  beforeEach(() => {
    files.clear();
    workspace.fs = {
      readFile: vi.fn(async (uri: { fsPath: string }) => {
        const text = files.get(uri.fsPath.toLowerCase());
        if (text === undefined) {
          throw new FileSystemError("missing", "FileNotFound");
        }
        return new TextEncoder().encode(text);
      }),
    } as unknown as typeof workspace.fs;
  });

  afterEach(() => {
    workspace.fs = {} as typeof workspace.fs;
  });

  function line(over: Record<string, string>): string {
    return JSON.stringify({
      at: "2026-09-22T03:00:00.000Z",
      client: "claude-code",
      command: "",
      label: "",
      ...over,
    });
  }

  function watcher(spotlight: ActionSpotlight): SpotlightRequestWatcher {
    return new SpotlightRequestWatcher(
      fakeContext() as never,
      () => [work],
      spotlight
    );
  }

  test("新しい依頼で、同じ ActionSpotlight を通して光らせる", async () => {
    files.set(target, `${line({ command: REAL_COMMAND })}\n`);
    const spotlight = new FakeSpotlight();
    await watcher(spotlight).check(work);
    expect(spotlight.shown).toEqual([REAL_COMMAND]);
  });

  test("一度捌いた依頼は、もう光らせない", async () => {
    files.set(target, `${line({ command: REAL_COMMAND })}\n`);
    const spotlight = new FakeSpotlight();
    const seen = watcher(spotlight);
    await seen.check(work);
    await seen.check(work);
    expect(spotlight.shown, "同じ依頼で2回光った").toEqual([REAL_COMMAND]);
  });

  test("あとから来た依頼は光らせる", async () => {
    files.set(target, `${line({ command: REAL_COMMAND })}\n`);
    const spotlight = new FakeSpotlight();
    const seen = watcher(spotlight);
    await seen.check(work);
    files.set(
      target,
      `${line({ command: REAL_COMMAND })}\n${line({
        at: "2026-09-22T04:00:00.000Z",
        command: "novelai.checkTypos",
      })}\n`
    );
    await seen.check(work);
    expect(spotlight.shown).toEqual([REAL_COMMAND, "novelai.checkTypos"]);
  });

  test("表示名で頼まれても引ける（対応表は拡張機能側だけが持つ）", async () => {
    const label = findAction(REAL_COMMAND)?.label;
    expect(label, "矛盾検知が一覧に無い").toBeDefined();
    files.set(target, `${line({ label: label! })}\n`);
    const spotlight = new FakeSpotlight();
    await watcher(spotlight).check(work);
    expect(spotlight.shown).toEqual([REAL_COMMAND]);
  });

  test("壊れた行・知らない指し先では、落ちずに何も光らせない", async () => {
    files.set(
      target,
      [
        "{壊れている",
        line({ command: "novelai.存在しない操作" }),
        line({ at: "2026-09-22T02:00:00.000Z", label: "そんな項目はない" }),
      ].join("\n")
    );
    const spotlight = new FakeSpotlight();
    await expect(watcher(spotlight).check(work)).resolves.toBeUndefined();
    expect(spotlight.shown).toEqual([]);
  });

  test("依頼のファイルがまだ無くても、落ちない", async () => {
    const spotlight = new FakeSpotlight();
    await expect(watcher(spotlight).check(work)).resolves.toBeUndefined();
    expect(spotlight.shown).toEqual([]);
  });

  test("どちらのメニューにも無ければ、知らせだけ出さずに済ませる", async () => {
    // **落ちないこと**が要（画面に出せない依頼で拡張機能を止めない）
    files.set(target, `${line({ command: REAL_COMMAND })}\n`);
    const spotlight = new FakeSpotlight({ shown: false });
    await expect(watcher(spotlight).check(work)).resolves.toBeUndefined();
    expect(spotlight.shown).toEqual([REAL_COMMAND]);
  });

  test("照合先の一覧が、両方のメニューを覆っている", () => {
    // 簡単ステップメニューは実体を持たず、詳細メニューの木を参照している
    const entries = menuEntries();
    expect(entries.some((one) => one.command === REAL_COMMAND)).toBe(true);
    expect(entries.some((one) => one.command === "novelai.postNewEpisode")).toBe(
      true
    );
  });
});
