import { describe, expect, test } from "vitest";
import {
  DEVICE_ID_KEY,
  isValidDeviceId,
  resolveDeviceId,
  sanitizeHostname,
} from "../../src/core/device";
import {
  describeElapsed,
  describeOtherDeviceSession,
  parseSessionRecord,
} from "../../src/core/sessionStore";

function memoryStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(DEVICE_ID_KEY, initial);
  return {
    get: (key: string) => values.get(key),
    update: async (key: string, value: string) => {
      values.set(key, value);
    },
    values,
  };
}

describe("端末ID", () => {
  test("一度作ったら次からは同じ値を返す", async () => {
    const storage = memoryStorage();

    const first = await resolveDeviceId(storage, "desktop");
    const second = await resolveDeviceId(storage, "desktop");

    expect(first).toBe(second);
    expect(first).toMatch(/^desktop-[0-9a-f]{4}$/);
  });

  test("機械名が同じでも端末どうしは区別できる", async () => {
    // 同じ型のPCを2台使うことはある。機械名だけでは足りない
    const first = await resolveDeviceId(memoryStorage(), "desktop");
    const second = await resolveDeviceId(memoryStorage(), "desktop");

    expect(first).not.toBe(second);
  });

  test("日本語の機械名でもファイル名に使える形にする", async () => {
    // 端末IDはファイル名の一部になる。英数字部分は手掛かりとして残す
    const id = await resolveDeviceId(memoryStorage(), "太郎のPC");

    expect(isValidDeviceId(id)).toBe(true);
    expect(id).toMatch(/^pc-[0-9a-f]{4}$/);
  });

  test("英数字が1文字も無い機械名でも作れる", async () => {
    const id = await resolveDeviceId(memoryStorage(), "書斎の機械");

    expect(isValidDeviceId(id)).toBe(true);
    expect(id).toMatch(/^device-[0-9a-f]{4}$/);
  });

  test("ドメイン部分は落とす", () => {
    expect(sanitizeHostname("macbook.local")).toBe("macbook");
  });

  test("壊れた値を覚えていたら作り直す", async () => {
    // パス区切りが混ざった値をそのままファイル名にしない
    const storage = memoryStorage("../../etc/passwd");

    const id = await resolveDeviceId(storage, "laptop");

    expect(id).not.toContain("/");
    expect(isValidDeviceId(id)).toBe(true);
  });

  test("使えない形を弾く", () => {
    expect(isValidDeviceId("desktop-a1b2")).toBe(true);
    expect(isValidDeviceId("")).toBe(false);
    expect(isValidDeviceId("../x")).toBe(false);
    expect(isValidDeviceId("a".repeat(65))).toBe(false);
    expect(isValidDeviceId("大文字ハ駄目")).toBe(false);
  });
});

describe("最終編集環境の記録", () => {
  test("必要な項目がそろっていれば読む", () => {
    const record = parseSessionRecord({
      deviceId: "desktop-a1b2",
      lastEditedAt: "2026-08-10T22:15:03+09:00",
      lastEditedFile: "本文/008.txt",
    });

    expect(record).toMatchObject({ deviceId: "desktop-a1b2" });
  });

  test("壊れた記録は捨てる", () => {
    // 同期対象なので競合マーカーが混ざることがある。
    // ここで例外を投げると執筆そのものが止まる
    expect(parseSessionRecord(null)).toBeUndefined();
    expect(parseSessionRecord({})).toBeUndefined();
    expect(
      parseSessionRecord({
        deviceId: "../evil",
        lastEditedAt: "2026-08-10T22:15:03+09:00",
        lastEditedFile: "本文/008.txt",
      })
    ).toBeUndefined();
    expect(
      parseSessionRecord({
        deviceId: "desktop-a1b2",
        lastEditedAt: "いつか",
        lastEditedFile: "本文/008.txt",
      })
    ).toBeUndefined();
  });

  test("経過時間を添えて知らせる", () => {
    const now = new Date("2026-08-10T22:15:00+09:00");
    const text = describeOtherDeviceSession(
      {
        deviceId: "desktop-a1b2",
        lastEditedAt: "2026-08-10T19:15:00+09:00",
        lastEditedFile: "本文/008.txt",
      },
      now
    );

    expect(text).toContain("desktop-a1b2");
    expect(text).toContain("3時間前");
    expect(text).toContain("008.txt");
  });

  test("経過時間の言い回し", () => {
    // 「別の環境で編集しています」だけでは、1分前か半年前か分からない
    expect(describeElapsed(30_000)).toBe("たった今");
    expect(describeElapsed(5 * 60_000)).toBe("5分前");
    expect(describeElapsed(3 * 3_600_000)).toBe("3時間前");
    expect(describeElapsed(2 * 86_400_000)).toBe("2日前");
    expect(describeElapsed(60 * 86_400_000)).toBe("2か月前");
    expect(describeElapsed(400 * 86_400_000)).toBe("1年前");
  });
});
