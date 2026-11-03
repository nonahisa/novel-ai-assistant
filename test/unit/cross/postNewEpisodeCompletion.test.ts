import * as fs from "fs";
import * as path from "path";
import { describe, expect, test } from "vitest";

/**
 * **出し直しだけで終えた回を「新話投稿を済ませた」と数えない**（設計書6.68.7。作者の裁定 2026-11-03 夜）。
 *
 * 直す前は `novelai.postNewEpisode` が「台帳が変わったか」（`result.changed`）で `CHECK_COMPLETED` を
 * 返していた。出し直しの記録や話の番号の預かりでも台帳は変わるので、出し直しだけで終えた回にも
 * はじめの案内などの手順が先へ進んだ。済んだと数えるのは、新しい話の投稿を記録したとき
 * （`result.postedNew`）だけ。`postNewEpisode` の戻り値は `postingKitEditedPrompt.test.ts` などが見る。
 * ここは命令の登録が、どちらの欄で済んだを名乗るかという配線を見張る（型では守れない）。
 */

const EXTENSION = path.join(__dirname, "..", "..", "..", "src", "extension.ts");

function registrationOf(source: string, command: string): string {
  const at = source.indexOf(`registerCommand("${command}"`);
  if (at === -1) throw new Error(`${command} の登録が見つかりません`);
  const next = source.indexOf("registerCommand(", at + 1);
  return source.slice(at, next === -1 ? undefined : next);
}

describe("新話投稿の命令が「済んだ」を名乗る条件", () => {
  const body = registrationOf(fs.readFileSync(EXTENSION, "utf8"), "novelai.postNewEpisode");

  test("新しい話を投稿したときだけ CHECK_COMPLETED を返す", () => {
    expect(body).toMatch(/result\.postedNew\s*\?\s*CHECK_COMPLETED\s*:\s*CHECK_CANCELLED/);
  });

  test("台帳が変わったか（changed）では済んだを名乗らない", () => {
    expect(body).not.toMatch(/result\.changed\s*\?\s*CHECK_COMPLETED/);
  });
});
