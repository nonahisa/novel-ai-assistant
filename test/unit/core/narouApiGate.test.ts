import { describe, expect, test } from "vitest";
import {
  NAROU_API_DAILY_LIMIT,
  NAROU_API_INTERVAL_MINUTES,
  judgeNarouApiAttempt,
  readNarouApiAttempts,
  readNarouApiConsent,
  withAgreement,
  withGuidelineOpened,
  withNarouApiAttempt,
} from "../../../src/core/narouApiGate";
import { NAROU_GUIDELINE_URL } from "../../../src/core/narouApi";

/** 同意（ガイドラインを開くまで入れられない）と、回数の上限（作者の指示 2026-11-02） */

describe("同意", () => {
  test("既定は開いていない・同意していない", () => {
    expect(readNarouApiConsent(undefined)).toEqual({ opened: false, agreed: false, agreedAt: null });
  });

  test("開く前はチェックを入れられない", () => {
    const result = withAgreement(undefined, true, "2026-11-02T01:00:00.000Z");
    expect(result.changed).toBe(false);
    expect(readNarouApiConsent(result.record).agreed).toBe(false);
  });

  test("開いたら入れられる。入れた日時を覚える", () => {
    const opened = withGuidelineOpened(undefined, "2026-11-02T01:00:00.000Z");
    expect(readNarouApiConsent(opened)).toEqual({ opened: true, agreed: false, agreedAt: null });
    const agreed = withAgreement(opened, true, "2026-11-02T01:05:00.000Z");
    expect(agreed.changed).toBe(true);
    expect(readNarouApiConsent(agreed.record)).toEqual({
      opened: true,
      agreed: true,
      agreedAt: "2026-11-02T01:05:00.000Z",
    });
    expect(agreed.record.guidelineUrl).toBe(NAROU_GUIDELINE_URL);
  });

  test("外せば取り消せ、開いた記録が残るので入れ直せる", () => {
    const opened = withGuidelineOpened(undefined, "2026-11-02T01:00:00.000Z");
    const agreed = withAgreement(opened, true, "2026-11-02T01:05:00.000Z").record;
    const revoked = withAgreement(agreed, false, "2026-11-02T02:00:00.000Z");
    expect(revoked.changed).toBe(true);
    expect(readNarouApiConsent(revoked.record)).toEqual({ opened: true, agreed: false, agreedAt: null });
    const again = withAgreement(revoked.record, true, "2026-11-02T03:00:00.000Z");
    expect(again.changed).toBe(true);
    expect(readNarouApiConsent(again.record).agreedAt).toBe("2026-11-02T03:00:00.000Z");
  });

  test("ガイドラインの URL が変わったら、開き直すまで入れられない（前の同意も効かない）", () => {
    const opened = withGuidelineOpened(undefined, "2026-11-02T01:00:00.000Z", "https://example.test/old");
    const agreed = withAgreement(opened, true, "2026-11-02T01:05:00.000Z", "https://example.test/old").record;
    expect(readNarouApiConsent(agreed, "https://example.test/old").agreed).toBe(true);
    // 新しい URL では、開いていない・同意していない
    expect(readNarouApiConsent(agreed, "https://example.test/new")).toEqual({
      opened: false,
      agreed: false,
      agreedAt: null,
    });
    expect(withAgreement(agreed, true, "2026-11-02T02:00:00.000Z", "https://example.test/new").changed).toBe(false);
    const reopened = withGuidelineOpened(agreed, "2026-11-02T02:00:00.000Z", "https://example.test/new");
    expect(withAgreement(reopened, true, "2026-11-02T02:01:00.000Z", "https://example.test/new").changed).toBe(true);
  });

  test("開いた記録の無い同意（手で書き換えた保管庫）は同意として読まない", () => {
    expect(
      readNarouApiConsent({ guidelineUrl: NAROU_GUIDELINE_URL, agreedAt: "2026-11-02T01:00:00.000Z" }).agreed
    ).toBe(false);
  });
});

describe("回数の上限", () => {
  const ncode = "n1234ab";

  test("初めては取りにいける", () => {
    expect(judgeNarouApiAttempt([], new Date("2026-11-02T10:00:00+09:00"))).toEqual({ allowed: true });
  });

  test(`前に押してから${NAROU_API_INTERVAL_MINUTES}分は取りにいかず、あと何分かを言う`, () => {
    const attempts = readNarouApiAttempts(
      withNarouApiAttempt({}, ncode, "2026-11-02T10:00:00+09:00"),
      ncode
    );
    const verdict = judgeNarouApiAttempt(attempts, new Date("2026-11-02T10:15:00+09:00"));
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.waitMinutes).toBe(45);
    expect(verdict.message).toContain("45分後にもう一度押せます");
    expect(judgeNarouApiAttempt(attempts, new Date("2026-11-02T11:00:00+09:00")).allowed).toBe(true);
  });

  test(`同じ作品は1日に${NAROU_API_DAILY_LIMIT}回まで（翌日はまた押せる）`, () => {
    let raw: unknown = {};
    for (let hour = 8; hour < 8 + NAROU_API_DAILY_LIMIT; hour++) {
      raw = withNarouApiAttempt(raw, ncode, `2026-11-02T${String(hour).padStart(2, "0")}:00:00+09:00`);
    }
    const attempts = readNarouApiAttempts(raw, ncode);
    const verdict = judgeNarouApiAttempt(attempts, new Date("2026-11-02T20:00:00+09:00"));
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.message).toContain("明日もう一度押せます");
    expect(judgeNarouApiAttempt(attempts, new Date("2026-11-03T08:00:00+09:00")).allowed).toBe(true);
  });

  test("ほかの作品の回数は数えない・保管庫は膨らまない", () => {
    let raw: unknown = withNarouApiAttempt({}, "n9999zz", "2026-11-02T10:00:00+09:00");
    expect(judgeNarouApiAttempt(readNarouApiAttempts(raw, ncode), new Date("2026-11-02T10:01:00+09:00")).allowed).toBe(true);
    for (let i = 0; i < 30; i++) raw = withNarouApiAttempt(raw, ncode, `2026-10-${String(i + 1).padStart(2, "0")}T10:00:00+09:00`);
    expect(readNarouApiAttempts(raw, ncode).length).toBeLessThanOrEqual(NAROU_API_DAILY_LIMIT * 2);
    expect(readNarouApiAttempts(raw, "n9999zz")).toHaveLength(1);
  });

  test("時計が戻った（前の時刻が未来）ときも待たせる", () => {
    const verdict = judgeNarouApiAttempt(["2026-11-02T12:00:00+09:00"], new Date("2026-11-02T11:00:00+09:00"));
    expect(verdict.allowed).toBe(false);
  });
});
