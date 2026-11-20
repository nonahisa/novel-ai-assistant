import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { restoreFromHistory } from "../../../src/features/gitRestore";
import { gitFailureNoticeText } from "../../../src/features/gitOnboarding";
import { window } from "../support/vscodeStub";
import { present, setUpMissingWork, type MissingWorkHarness } from "../support/missingWorkHarness";

/**
 * git の生の失敗文を知らせへ出すときは、鍵を伏せる（セキュリティ点検 2026-11-21）。
 *
 * git の失敗文には送り先の URL がそのまま入る。古い `.git/config` には
 * `https://<トークン>@github.com/...` の形が残っていることがあり（設計書6.78の5）、
 * 知らせの写真やコピーから鍵が漏れる。ログは前から `redactSecrets` を通していた。
 */

// 本物の鍵は使わない。形だけ寄せた作り物
const TOKEN = `ghp_${"A1b2C3d4E5".repeat(4)}`;
const RAW = `fatal: unable to access 'https://${TOKEN}@github.com/example/novel.git/': Could not resolve host`;

describe("はじめての送信の失敗の知らせ", () => {
  test("言い換えられない失敗文でも、鍵は伏せて出す", () => {
    const text = gitFailureNoticeText("送信", `error: ${TOKEN} を使えませんでした`);
    expect(text).toContain("送信に失敗しました");
    expect(text).not.toContain(TOKEN);
  });

  test("伏せてから200字に切る（切った境目で鍵の形が崩れてすり抜けない）", () => {
    const detail = `${"あ".repeat(190)}${TOKEN}`;
    expect(gitFailureNoticeText("送信", detail)).not.toContain("ghp_A1b2");
  });
});

describe("復元：履歴を読めなかった知らせ", () => {
  let harness: MissingWorkHarness;
  const errors: string[] = [];
  const original = window.showErrorMessage;

  beforeEach(() => {
    harness = setUpMissingWork();
    harness.bringBack();
    errors.length = 0;
    window.showErrorMessage = (async (message: string) => {
      errors.push(message);
      return undefined;
    }) as typeof window.showErrorMessage;
  });
  afterEach(() => {
    window.showErrorMessage = original;
    harness.restore();
  });

  test("git の生の失敗文の鍵を伏せて出す", async () => {
    const run: typeof harness.run = async (args, cwd, timeout, options) => {
      // 作業ツリーの中なのに根を読めない形（`readSyncStatus` が failed を返す）
      if (args[0] === "rev-parse") return { code: 128, stdout: "true\n", stderr: RAW };
      return harness.run(args, cwd, timeout, options);
    };
    await restoreFromHistory(present, { works: harness.registry.list(), run });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("履歴を読めませんでした");
    expect(errors[0]).not.toContain(TOKEN);
  });
});
