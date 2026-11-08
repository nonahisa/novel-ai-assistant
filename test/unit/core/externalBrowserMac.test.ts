import { describe, expect, test } from "vitest";
import {
  launchServicesPlistPath,
  readDefaultBrowserBundleId,
  type RunPlutil,
} from "../../../src/core/externalBrowserMac";

/**
 * Mac の既定のブラウザを LaunchServices の記録から読む（作者の決定 2026-11-08）。
 * この PC は Windows なので、`plutil` を差し替えて、呼び方と読み方だけを確かめる。
 * 本物の Mac の記録を読めるかは実機確認リストへ（0.148.0）。
 */

const PLIST = "/Users/a/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist";

describe("Mac の既定のブラウザを読む", () => {
  test("記録の場所はホームの Library/Preferences の下", () => {
    expect(launchServicesPlistPath("/Users/a")).toBe(PLIST);
    expect(launchServicesPlistPath("/Users/a/")).toBe(PLIST);
  });

  test("plutil で JSON にして https の受け手を拾う", async () => {
    const calls: string[][] = [];
    const run: RunPlutil = async (args) => {
      calls.push([...args]);
      return JSON.stringify({ LSHandlers: [{ LSHandlerURLScheme: "https", LSHandlerRoleAll: "com.google.chrome" }] });
    };
    await expect(readDefaultBrowserBundleId(run, PLIST)).resolves.toBe("com.google.chrome");
    expect(calls).toEqual([["-convert", "json", "-o", "-", PLIST]]);
  });

  test("JSON にできなければ XML で読み直す", async () => {
    const run: RunPlutil = async (args) =>
      args[1] === "json"
        ? undefined
        : "<plist><dict><key>LSHandlers</key><array><dict><key>LSHandlerURLScheme</key><string>https</string>" +
          "<key>LSHandlerRoleAll</key><string>com.apple.safari</string></dict></array></dict></plist>";
    await expect(readDefaultBrowserBundleId(run, PLIST)).resolves.toBe("com.apple.safari");
  });

  test("どちらでも読めなければ「分からない」（案内を出さない）", async () => {
    await expect(readDefaultBrowserBundleId(async () => undefined, PLIST)).resolves.toBeUndefined();
  });
});
