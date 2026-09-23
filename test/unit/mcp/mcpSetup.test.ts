import * as fs from "node:fs";
import * as nodePath from "node:path";
import { describe, expect, test, vi } from "vitest";
import { SETUP_STEPS, alreadyRegisteredNotice } from "../../../src/core/setupRequest";
import {
  SETUP_PROMPT_NAME,
  SETUP_PROMPT_TITLE,
  buildSetupGuide,
} from "../../../src/mcp/prompts/setupGuide";
import {
  envWithoutElectronFlag,
  openerCommand,
  setupRequest,
} from "../../../src/mcp/tools/setupRequest";
import { exposureOf } from "../../../src/mcp/tools/accessLog";
import { assertExternalAccessAllowed } from "../../../src/mcp/tools/permission";
import { McpToolError } from "../../../src/mcp/tools/shared";

/**
 * Claude Code から始めるセットアップ（設計書6.87.18）の MCP 側。
 *
 * - 手順書（prompts の `setup`）は、決まり（原稿を書き換えない・許可が無ければ
 *   読めない・インストールや作成は拡張機能の確認に従う）を必ず書く
 * - 道具 `setup.request` は**ファイルを1つも触らず**、拡張機能の画面に
 *   確認を出させる URI を開くだけ
 */

const root = nodePath.join(__dirname, "../../..");
const server = fs.readFileSync(nodePath.join(root, "src/mcp/server.ts"), "utf8");

describe("手順書", () => {
  const guide = buildSetupGuide();

  test("名前は setup、題は作者の言葉", () => {
    expect(SETUP_PROMPT_NAME).toBe("setup");
    expect(SETUP_PROMPT_TITLE).toBe("小説の執筆環境をセットアップ");
  });

  test("サーバーに登録されている", () => {
    expect(server).toMatch(/registerPrompt\(\s*SETUP_PROMPT_NAME/u);
  });

  test("決まりを書く", () => {
    expect(guide).toContain("原稿を書き換えない");
    expect(guide).toContain("許可");
    expect(guide).toContain("拡張機能の確認");
    // ファイルやフォルダーを自分で作らせない（作るのは拡張機能だけ）
    expect(guide).toContain("自分で作らない");
    // 資料は提案として置く
    expect(guide).toContain("novel.propose");
  });

  test("聞き取る項目がそろっている", () => {
    for (const word of [
      "新しく",
      "登録",
      "置き場所",
      "形式",
      "ジャンル",
      "種類",
      "Ollama",
      "LM Studio",
      "クラウド",
      "ベクトル検索",
    ]) {
      expect(guide).toContain(word);
    }
  });

  test("呼ばせる段は、受け口の表にある段だけ（どの段も手順書に載っている）", () => {
    const named = [...guide.matchAll(/step: "([\w-]+)"/gu)].map((m) => m[1]);
    const known = SETUP_STEPS.map((def) => def.step);
    expect(named.length).toBeGreaterThan(0);
    for (const step of named) expect(known).toContain(step);
    for (const step of known) expect(named).toContain(step);
  });

  test("1段ずつ作者の返事を待たせる", () => {
    expect(guide).toContain("返事を待");
  });

  test("登録済みと知らされたら、それで良いとして次の段へ進ませる（2026-09-24）", () => {
    // 手順書が引く言葉は、拡張機能が実際に出す知らせの言葉と同じでなければ、
    // Claude Code は作者から聞いた言葉と結び付けられない
    expect(guide).toContain("すでに登録されています");
    expect(alreadyRegisteredNotice("作品")).toContain("すでに登録されています");
    expect(guide).toMatch(/すでに登録されています[^\n]*次の段へ/u);
  });
});

describe("道具 setup.request", () => {
  test("サーバーに登録され、記録の名前もそろっている", () => {
    expect(server).toContain('registerTool(\n  "setup.request"');
    expect(server).toContain('tool("setup.request"');
  });

  test("原稿は出ない", () => {
    expect(exposureOf("setup.request", { step: "ollama" })).toBe("none");
  });

  test("作品の場所を folder と呼ばないので、門番で断られない", () => {
    // まだ登録していない場所を渡すのが仕事なので、許可の印は無い
    expect(() =>
      assertExternalAccessAllowed(
        { step: "register", path: "C:\\まだ登録していない" },
        "setup.request"
      )
    ).not.toThrow();
  });

  test("確かめた依頼の URI を開く", async () => {
    const open = vi.fn(async () => undefined);
    const result = await setupRequest(
      { step: "create", title: "星の町", kind: "novel" },
      { open }
    );
    expect(open).toHaveBeenCalledTimes(1);
    const uri = String(open.mock.calls[0]?.[0 as never]);
    expect(uri.startsWith("vscode://nonahisa.novel-ai-assistant/setup?")).toBe(true);
    expect(result.opened).toBe(true);
    expect(result.uri).toBe(uri);
  });

  test("知らない段・受けない鍵は、開く前に断る", async () => {
    const open = vi.fn(async () => undefined);
    await expect(
      setupRequest({ step: "ollama", title: "x" }, { open })
    ).rejects.toBeInstanceOf(McpToolError);
    expect(open).not.toHaveBeenCalled();
  });

  test("開けなかったら URI を返して、手で開く道を残す", async () => {
    const result = await setupRequest(
      { step: "ollama" },
      {
        open: async () => {
          throw new Error("no opener");
        },
      }
    );
    expect(result.opened).toBe(false);
    expect(result.uri).toContain("step=ollama");
    expect(result.note).toContain("no opener");
  });
});

describe("URI の開き方", () => {
  test("シェルを通さない（& を含む URI が切れない）", () => {
    const uri = "vscode://nonahisa.novel-ai-assistant/setup?step=create&title=a";
    expect(openerCommand("win32", uri)).toEqual({
      command: "rundll32",
      args: ["url.dll,FileProtocolHandler", uri],
    });
    expect(openerCommand("darwin", uri)).toEqual({ command: "open", args: [uri] });
    expect(openerCommand("linux", uri)).toEqual({ command: "xdg-open", args: [uri] });
  });

  test("ELECTRON_RUN_AS_NODE を子へ渡さない（呼び起こした VS Code が Node として立ち上がる）", () => {
    const env = envWithoutElectronFlag({
      ELECTRON_RUN_AS_NODE: "1",
      PATH: "x",
    });
    expect(env).toEqual({ PATH: "x" });
  });
});
