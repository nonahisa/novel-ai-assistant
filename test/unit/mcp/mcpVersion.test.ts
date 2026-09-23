import * as fs from "fs";
import * as path from "path";
import { describe, expect, test } from "vitest";
import { SERVER_NAME, SERVER_VERSION } from "../../src/mcp/version";

/**
 * 外から呼ぶ束（MCPサーバー）の版が、拡張機能の版と揃っているか。
 *
 * **束は作った時点の写しである**（設計書6.87.6 の4）。版が動いたのに
 * 束ね直していなければ、**直したはずの不具合が再現する。** 版を名乗らせて
 * おけば、作者が `mcp.version` を見て気づける——が、そもそも名乗る値が
 * ずれていては意味が無いので、ここで突き合わせる。
 *
 * `showVersion.test.ts`（CHANGELOG・README・設計書の版）と同じ考え。
 */
const root = path.join(__dirname, "..", "..");

function packageJson(): { version: string; name: string } {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
}

describe("MCPサーバーの版", () => {
  test("`SERVER_VERSION` が package.json の版と一致する", () => {
    // 落ちたら：`src/mcp/version.ts` の `SERVER_VERSION` を直す
    // （CLAUDE.md の「版は5つの文書で揃える」と同じ作業の中で）
    expect(SERVER_VERSION).toBe(packageJson().version);
  });

  test("`.mcp.json` の登録名と、名乗る名前が一致する", () => {
    // 名前がずれると、Claude Code の一覧に出るツールの前置きと
    // サーバーの名乗りが食い違う（どのサーバーか追えなくなる）
    const config = JSON.parse(
      fs.readFileSync(path.join(root, ".mcp.json"), "utf8")
    );
    expect(Object.keys(config.mcpServers)).toContain(SERVER_NAME);
  });

  test("`.mcp.json` が束（dist/mcp-server.mjs）を指している", () => {
    const config = JSON.parse(
      fs.readFileSync(path.join(root, ".mcp.json"), "utf8")
    );
    const entry = config.mcpServers[SERVER_NAME];
    expect(entry.command).toBe("node");
    // **ビルドの出し先と揃っているか。** `esbuild.js` の3つ目の束が
    // ここへ出るので、片方だけ直すとサーバーが起動しない
    expect(entry.args).toEqual(["dist/mcp-server.mjs"]);
    const esbuild = fs.readFileSync(path.join(root, "esbuild.js"), "utf8");
    expect(esbuild).toContain('outfile: "dist/mcp-server.mjs"');
  });
});
