import { beforeEach, describe, expect, test } from "vitest";
import { workspace } from "../support/vscodeStub";
import {
  logStep,
  setFallbackLogRoot,
  useLogFile,
  workLog,
} from "../../../src/core/logger";

/**
 * 長い処理のログが、途中で別の作品へ紛れないこと（2026-10-10 の実機）。
 *
 * 窓を2つ開いて抽出を回していたとき、「ハイエルフ未亡人_確認用」の抽出を
 * 中止した「チャンクの処理を終了: 0/4（中止された）」の1行が、直前に
 * 触っていた「肉片とラジオと心霊現象」のログに入り、本来の作品のログには
 * 残らなかった。ログの書き先（`useLogFile`）は拡張機能の中で1つの共有の
 * 値で、AIの応答を待っているあいだに別の作品の画面を開くと向け直される。
 * 長い処理は、始めに決めた作品へ書き続けなければならない。
 */

let written: { path: string; text: string }[] = [];

beforeEach(() => {
  written = [];
  Object.assign(workspace, {
    fs: {
      createDirectory: async () => undefined,
      readFile: async () => {
        throw new Error("まだ無い");
      },
      writeFile: async (uri: { path?: string; fsPath?: string }, data: Uint8Array) => {
        written.push({
          path: uri.fsPath ?? uri.path ?? "",
          text: new TextDecoder().decode(data),
        });
      },
    },
  });
});

function logPath(raw: string): string {
  return raw.replace(/\\/g, "/").toLowerCase();
}

/** 書き込みは順番待ちの列に乗るので、何周か待ってから読む */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const HIGH_ELF = "C:/works/ハイエルフ";
const NIKUHEN = "C:/works/肉片";

function linesIn(folder: string): string[] {
  const target = logPath(`${folder}/.aiwriter/logs/actions.log`);
  return written.filter((entry) => logPath(entry.path) === target).map((entry) => entry.text);
}

describe("長い処理のログの書き先（workLog）", () => {
  test("処理の途中で別の作品へ向け直されても、終わりの行は始めの作品のログへ入る", async () => {
    setFallbackLogRoot("C:/storage");
    // 窓Bで抽出を始める
    useLogFile(HIGH_ELF);
    const log = workLog(HIGH_ELF);
    log.step("抽出を開始: ハイエルフ未亡人_確認用 / 4チャンク");
    // AIの応答を待っているあいだに、別の作品の画面が開かれる
    useLogFile(NIKUHEN);
    log.step("チャンクの処理を終了: 0/4 （失敗 0件 / 中止された）");
    await settle();

    expect(linesIn(HIGH_ELF).join("")).toContain("チャンクの処理を終了: 0/4");
    expect(linesIn(NIKUHEN).join("")).not.toContain("チャンクの処理を終了");
  });

  test("束ねても共有の書き先は変えない（同時に動くほかの操作の行を奪わない）", async () => {
    setFallbackLogRoot("C:/storage");
    useLogFile(NIKUHEN);
    workLog(HIGH_ELF).step("抽出を開始");
    logStep("設定資料パネルを開きました");
    await settle();

    expect(linesIn(NIKUHEN).join("")).toContain("設定資料パネルを開きました");
    expect(linesIn(HIGH_ELF).join("")).not.toContain("設定資料パネル");
  });

  test("作品が決まらないときの保管庫は、束ねた時点で決まる", async () => {
    setFallbackLogRoot("C:/storage");
    const log = workLog(undefined);
    useLogFile(NIKUHEN);
    log.failure("チューニング", { 理由: "試し" });
    await settle();

    expect(linesIn("C:/storage").join("")).toContain("--- チューニング ---");
    expect(linesIn(NIKUHEN)).toEqual([]);
  });
});
