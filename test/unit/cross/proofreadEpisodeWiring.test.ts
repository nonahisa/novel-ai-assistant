import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 原稿エディターの「この話を校正」と Ctrl+Alt+A の配線（作者の答え 2026-11-27。
 * 設計書6.25・6.80）。
 *
 * **命令は作品全体のまとめ実行と同じ（`novelai.runProofreadingSuite`）で、原稿から
 * 来た印（`manuscriptKeyFileOf`）があるときだけ話の道になる。** 印を受けた先の
 * 4つの校正が「この話」を範囲へ渡さないと、黙って作品全体で走る（量も料金も
 * 作者の思ったものと違う）。型では止められないので、ここで繋がりを見る。
 */

const SRC = resolve(__dirname, "../../../src");
const read = (file: string) => readFileSync(resolve(SRC, file), "utf8");

/** 命令の登録（`"novelai.xxx",` から次の `registerCommand(` まで）を切り出す */
function commandBody(source: string, head: string): string {
  const start = source.indexOf(head);
  expect(start, head).toBeGreaterThan(-1);
  const next = source.indexOf("registerCommand(", start + head.length);
  return source.slice(start, next < 0 ? undefined : next);
}

describe("原稿から来たら、話の道を通す", () => {
  const extension = read("extension.ts");

  test("まとめ実行の命令は、原稿の印から話を引いて渡す", () => {
    const body = commandBody(extension, "PROOFREADING_SUITE_COMMAND,\n      async (node");
    expect(body).toContain("manuscriptKeyFileOf(node)");
    expect(body).toContain("episodeFile");
  });

  test("4つの校正は、まとめ実行の印の「この話」を範囲へ渡す", () => {
    for (const head of [
      '"novelai.checkTypos",\n',
      '"novelai.checkProofread",\n',
      '"novelai.checkDeviations",\n',
    ]) {
      expect(commandBody(extension, head), head).toContain("suiteOnlyFile: suiteOnlyFileOf(options)");
    }
    // 矛盾はまとめ実行から設定との照合だけが走る（`runSettingsContradictions`）
    const settings = extension.slice(
      extension.indexOf("async function runSettingsContradictions(")
    );
    expect(settings.slice(0, 2000)).toContain("suiteOnlyFile: suiteOnlyFileOf(options)");
  });

  test("原稿の話が作品の話として見つからなければ、作品全体へ落とさずに止める", () => {
    const start = extension.indexOf("const manuscriptNodeFor = async (");
    const body = extension.slice(start, extension.indexOf("const treeMenuCommands", start));
    expect(body).toContain("PROOFREADING_SUITE_COMMAND");
  });
});
