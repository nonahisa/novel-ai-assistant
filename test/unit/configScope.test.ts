import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * 接続先と実行ファイルの設定を、作品リポジトリから差し替えられないようにする番人。
 *
 * VS Codeの設定は既定で `window` スコープ——**ワークスペースの
 * `.vscode/settings.json` からも書ける**。作品フォルダーはGitHubで同期され、
 * 編集部とも共有する。そこに `novelai.gemini.endpoint` を1行書ければ、
 * **APIキーと原稿が任意のホストへ送られる**。`ollama.executablePath` なら、
 * 「Ollamaを起動」を押した瞬間に任意の実行ファイルが動く。
 *
 * そのため、宛先と実行ファイルに関わる設定は `machine`
 * （ユーザー設定からしか読まない）に固定する。
 */

const manifest = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "package.json"
    ),
    "utf8"
  )
) as {
  contributes: {
    configuration: {
      properties: Record<string, { scope?: string }>;
    };
  };
  capabilities?: {
    untrustedWorkspaces?: {
      supported?: string | boolean;
      description?: string;
      restrictedConfigurations?: string[];
    };
  };
};

const properties = manifest.contributes.configuration.properties;

/**
 * ユーザー設定からしか読まない設定の一覧。
 *
 * 入れるのは**接続先（endpoint）と実行ファイル（path）**、そして
 * **できる操作を切り替える設定（`novelai.mode`）**である。
 *
 * `mode` は名前に endpoint も path も入らないが、共有リポジトリの
 * `.vscode/settings.json` が `"author"` と書ければ、編集者の環境で
 * **本文を書き換える操作が開いてしまう**——編集者モード（設計書5.6）の
 * 迂回路になる。切り替えは「モードを切り替える」操作が
 * ユーザー設定へ書くので、machineにしても普段の使い方は変わらない。
 *
 * 表示の好み・字数目標・待ち時間などは、作品ごとに変えられてよい。
 */
const MACHINE_SCOPED_KEYS = [
  "novelai.gemini.endpoint",
  "novelai.lmstudio.cliPath",
  "novelai.lmstudio.endpoint",
  "novelai.mode",
  "novelai.ollama.endpoint",
  "novelai.ollama.executablePath",
  "novelai.openai.endpoint",
  "novelai.sakura.endpoint",
];

describe("接続先・実行ファイルの設定スコープ", () => {
  test.each(MACHINE_SCOPED_KEYS)(
    "%s はワークスペースから上書きできない（machine）",
    (key) => {
      expect(properties[key]).toBeDefined();
      expect(properties[key].scope).toBe("machine");
    }
  );

  test("宛先・実行ファイルらしい設定を足したら、一覧に入れるまで落ちる", () => {
    // **新しい設定を足す人に、ここで一度考えさせる**のが狙い。
    // 名前に endpoint / path が入るものは、まず宛先か実行ファイルである。
    // 一覧にはそれ以外（`novelai.mode`）も入るので、名前で拾えるものが
    // **すべて一覧に含まれているか**を見る
    const suspects = Object.keys(properties).filter((key) =>
      /endpoint|path/i.test(key)
    );

    expect(suspects.length).toBeGreaterThan(0);
    for (const key of suspects) {
      expect(MACHINE_SCOPED_KEYS).toContain(key);
    }
  });
});

describe("信頼していないフォルダーでの扱い", () => {
  test("limited として宣言し、理由を日本語で書く", () => {
    const declared = manifest.capabilities?.untrustedWorkspaces;

    expect(declared?.supported).toBe("limited");
    // 制限モードのバナーから読まれる説明。作者に伝わる言葉で書く
    expect(declared?.description).toMatch(/信頼/);
  });

  test("machineにした設定は、すべて restrictedConfigurations に並ぶ", () => {
    // `machine` はワークスペース設定を無効にするが、こちらは
    // 「信頼していないフォルダーでは読まない」という宣言。
    // 両方を揃えておくと、あとから scope を緩めても穴が開かない
    const restricted =
      manifest.capabilities?.untrustedWorkspaces?.restrictedConfigurations ?? [];

    expect([...restricted].sort()).toEqual([...MACHINE_SCOPED_KEYS].sort());
  });
});
