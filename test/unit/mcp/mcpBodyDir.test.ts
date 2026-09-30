import * as path from "path";
import * as fs from "node:fs";
import * as os from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { bodyDirOf, listBodyFiles } from "../../../src/mcp/tools/shared";

/**
 * MCP の本文の置き場も、拡張機能と同じ決め方を通る（机のPCで第1話が
 * 見えなかった件）。**本物のディスク（一時フォルダー）で確かめる**——
 * MCP は Node の同期の `fs` で読むので、作り物では読み方の側を素通りする。
 */
const made: string[] = [];

function makeWork(files: Record<string, string>, emptyDirs: string[] = []): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novelai-bodydir-"));
  made.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const at = path.join(root, rel);
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.writeFileSync(at, text, "utf8");
  }
  for (const rel of emptyDirs) fs.mkdirSync(path.join(root, rel), { recursive: true });
  return root;
}

afterEach(() => {
  for (const root of made.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("MCP の本文の置き場", () => {
  test("空の本文フォルダーがあっても、直下の原稿を拾う", () => {
    const root = makeWork({ "001.txt": "一。", "002.txt": "二。" }, ["本文"]);

    expect(bodyDirOf(root)).toBe(path.resolve(root));
    expect(listBodyFiles(root)).toEqual(["001.txt", "002.txt"]);
    // **空のフォルダーは消さない**（作者のファイルに触らない）
    expect(fs.existsSync(path.join(root, "本文"))).toBe(true);
  });

  test("本文フォルダーに原稿があれば、これまでどおりそちらだけ", () => {
    const root = makeWork({ "本文/001.txt": "一。", "下書き.txt": "根。" });

    expect(bodyDirOf(root)).toBe(path.join(path.resolve(root), "本文"));
    expect(listBodyFiles(root)).toEqual([path.join("本文", "001.txt")]);
  });

  test("登録したばかりの作品（空の本文フォルダー、直下は README だけ）は本文フォルダー", () => {
    const root = makeWork({ "README.md": "# 作品\n" }, ["本文"]);

    expect(bodyDirOf(root)).toBe(path.join(path.resolve(root), "本文"));
    expect(listBodyFiles(root)).toEqual([]);
  });
});
