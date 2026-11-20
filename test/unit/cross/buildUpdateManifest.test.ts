import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * `scripts/buildUpdateManifest.mjs`（GitHub Release に添える更新の札。設計書5.11）の
 * 判断の部分だけを確かめる。ファイルは書かない（入口の番人がある）。
 */
type Manifest = {
  product: string;
  version: string;
  date: string;
  summary: string[];
  assets: { platform: string; name: string; url: string; sha256: string; bytes: number }[];
  minimumFrom: string | null;
};

const script = (await import("../../../scripts/buildUpdateManifest.mjs")) as {
  PRODUCT_ID: string;
  parseManifestArguments(argv: string[]): {
    notesPath?: string;
    versions: string[];
    vsixPath?: string;
  };
  extractChangelogEntry(text: string, version: string): { date?: string; items: string[] };
  readNotesSha256(text: string): string | undefined;
  buildDownloadUrl(repositoryUrl: string, tag: string, assetName: string): string;
  buildUpdateManifest(input: {
    changelogText: string;
    version: string;
    versions?: string[];
    repositoryUrl: string;
    assetName: string;
    sha256: string;
    bytes: number;
    notesSha256?: string;
  }): Manifest;
  formatUpdateManifest(manifest: Manifest): string;
};

const SHA = "3857b23f0f229a2d69189a3885d53061276fc4fbdd39a908acc85c604e35e378";
const REPO = "git+https://github.com/nonahisa/novel-ai-assistant.git";

const CHANGELOG = [
  "# Change Log",
  "",
  "## 1.0.32 - 2026-11-19",
  "",
  "- 変えたこと",
  "  - 呼び名を Rittoku IME にしました",
  "",
  "## 1.0.31 - 2026-11-19",
  "",
  "- 変えたこと",
  "  - README の表を直しました",
  "- 直したこと",
  "  - 画面が1行目のまま動かないことがあったのを直しました",
  "",
  "## 1.0.3 - 2026-01-01",
  "",
  "- 古い形の1行",
  "",
].join("\n");

describe("CHANGELOG から要約を取る", () => {
  test("分類の行を落とし、下の文を一字も変えずに取る", () => {
    expect(script.extractChangelogEntry(CHANGELOG, "1.0.31")).toEqual({
      date: "2026-11-19",
      items: ["README の表を直しました", "画面が1行目のまま動かないことがあったのを直しました"],
    });
  });

  test("字下げの無い古い形は、その行を取る", () => {
    expect(script.extractChangelogEntry(CHANGELOG, "1.0.3").items).toEqual(["古い形の1行"]);
  });

  test("1.0.3 が 1.0.31・1.0.32 の節に当たらない", () => {
    expect(script.extractChangelogEntry(CHANGELOG, "1.0.3").date).toBe("2026-01-01");
  });

  test("節が無ければ止める", () => {
    expect(() => script.extractChangelogEntry(CHANGELOG, "9.9.9")).toThrow(/9\.9\.9 の節がありません/);
  });

  test("本物の CHANGELOG のいまの版から要約が取れる", async () => {
    const root = path.resolve(__dirname, "../../..");
    const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { version: string };
    const entry = script.extractChangelogEntry(changelog, pkg.version);
    expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(entry.items.length).toBeGreaterThan(0);
    // 分類の行（「直したこと」など）だけの行が要約に紛れていない
    expect(entry.items).not.toContain("直したこと");
    expect(entry.items).not.toContain("足したこと");
    expect(entry.items).not.toContain("変えたこと");
  });
});

describe("ノートの SHA-256 を読む", () => {
  test("全角のコロンでも半角でも読む", () => {
    expect(script.readNotesSha256(`- 版：1.0.33\n- SHA-256：${SHA}\n`)).toBe(SHA);
    expect(script.readNotesSha256(`SHA-256: ${SHA.toUpperCase()}\n`)).toBe(SHA);
  });

  test("行が無ければ undefined", () => {
    expect(script.readNotesSha256("- 版：1.0.33\n")).toBeUndefined();
  });
});

describe("札を組み立てる", () => {
  const base = {
    changelogText: CHANGELOG,
    version: "1.0.32",
    repositoryUrl: REPO,
    assetName: "novel-ai-assistant-1.0.32.vsix",
    sha256: SHA,
    bytes: 5928626,
  };

  test("共通の決まりの形で書く", () => {
    expect(script.buildUpdateManifest({ ...base, notesSha256: SHA })).toEqual({
      product: "novel-ai-assistant",
      version: "1.0.32",
      date: "2026-11-19",
      summary: ["呼び名を Rittoku IME にしました"],
      assets: [
        {
          platform: "vscode",
          name: "novel-ai-assistant-1.0.32.vsix",
          url: "https://github.com/nonahisa/novel-ai-assistant/releases/download/v1.0.32/novel-ai-assistant-1.0.32.vsix",
          sha256: SHA,
          bytes: 5928626,
        },
      ],
      minimumFrom: null,
    });
  });

  test("前の版の分も含む Release は、新しい版から順に要約を並べる", () => {
    const manifest = script.buildUpdateManifest({ ...base, versions: ["1.0.31"] });
    expect(manifest.summary).toEqual([
      "呼び名を Rittoku IME にしました",
      "README の表を直しました",
      "画面が1行目のまま動かないことがあったのを直しました",
    ]);
    expect(manifest.date).toBe("2026-11-19");
  });

  test("ノートの SHA-256 が VSIX と違えば止める", () => {
    expect(() =>
      script.buildUpdateManifest({ ...base, notesSha256: "0".repeat(64) })
    ).toThrow(/SHA-256 が VSIX と合いません/);
  });

  test("要約に手元のパスが紛れたら止める", () => {
    const leaky = CHANGELOG.replace("README の表を直しました", "C:\\Users\\someone の表を直しました");
    expect(() =>
      script.buildUpdateManifest({ ...base, changelogText: leaky, versions: ["1.0.31"] })
    ).toThrow(/forbidden/);
  });

  test("GitHub でない repository.url は止める", () => {
    expect(() => script.buildDownloadUrl("https://example.com/x/y", "v1", "a.vsix")).toThrow(
      /GitHub のリポジトリではありません/
    );
  });

  test("書き出しは2字下げの JSON で、末尾に改行", () => {
    const text = script.formatUpdateManifest(script.buildUpdateManifest(base));
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text).product).toBe(script.PRODUCT_ID);
  });
});

describe("引数", () => {
  test("--versions は , で分ける。= の形も読む", () => {
    expect(script.parseManifestArguments(["--versions", "1.0.31, 1.0.30", "--notes=n.md"])).toEqual({
      notesPath: "n.md",
      versions: ["1.0.31", "1.0.30"],
      vsixPath: undefined,
    });
  });

  test("知らない引数と値の抜けは止める", () => {
    expect(() => script.parseManifestArguments(["--dry-run"])).toThrow(/知らない引数/);
    expect(() => script.parseManifestArguments(["--notes", "--versions", "1"])).toThrow(/値がありません/);
  });
});
