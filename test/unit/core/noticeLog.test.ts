import { describe, expect, it } from "vitest";
import {
  NOTICE_LOG_DIRECTORY,
  NOTICE_LOG_MAX_AGE_MS,
  NOTICE_LOG_MAX_ENTRIES,
  NOTICE_LOG_SCHEMA,
  NOTICE_TEXT_MAX_CHARS,
  answerChoice,
  clipNoticeText,
  describeNoticeCall,
  isNoticeLogExpired,
  noticeLogFileName,
  parseNoticeLog,
  pruneNotices,
  selectNotices,
  serializeNoticeLog,
  type NoticeEntry,
  type NoticeLogFile,
} from "../../../src/core/noticeLog";
import { redactSecrets } from "../../../src/core/logger";

/**
 * 拡張機能が出した知らせの記録（MCP の `notices.recent`。作者の承認、2026-09-24）。
 *
 * **見張りたいのは4つ。**
 *
 * 1. **記録が上限（500件・7日）を超えて膨らまないこと**
 * 2. **キーらしき文字は伏せ、長い文は200字で切ること**（先に伏せてから切る）
 * 3. **読む側の絞り込み（since・contains・pid・limit）が効くこと**
 * 4. 壊れた記録で読みが止まらないこと
 */

const NOW = new Date("2026-09-24T10:00:00.000Z");
const same = (text: string): string => text;

function entry(overrides: Partial<NoticeEntry> = {}): NoticeEntry {
  return {
    seq: 1,
    at: "2026-09-24T09:00:00.000Z",
    severity: "info",
    modal: false,
    message: "保存しました",
    detail: null,
    items: [],
    truncated: false,
    answer: null,
    ...overrides,
  };
}

function file(overrides: Partial<NoticeLogFile> = {}): NoticeLogFile {
  return {
    schema: NOTICE_LOG_SCHEMA,
    pid: 100,
    machineName: "DESKTOP",
    extensionVersion: "0.85.0",
    startedAt: "2026-09-24T08:00:00.000Z",
    updatedAt: "2026-09-24T09:00:00.000Z",
    notices: [entry()],
    ...overrides,
  };
}

describe("置き場と名前", () => {
  it("保管庫の .aiwriter/notices に、窓ごとに1ファイル", () => {
    expect(NOTICE_LOG_DIRECTORY).toEqual([".aiwriter", "notices"]);
  });

  it("ファイル名はプロセス番号と起動時刻（使い回された番号で上書きしない）", () => {
    const at = new Date("2026-09-24T08:00:00.000Z");
    expect(noticeLogFileName(42, at)).toBe(`42-${at.getTime()}.json`);
    expect(noticeLogFileName(42, at)).not.toBe(
      noticeLogFileName(42, new Date("2026-09-25T08:00:00.000Z"))
    );
  });
});

describe("文を記録へ残す形にする（clipNoticeText）", () => {
  it("200字までは、そのまま", () => {
    const text = "あ".repeat(NOTICE_TEXT_MAX_CHARS);
    expect(clipNoticeText(text, same)).toEqual({ text, truncated: false });
  });

  it("200字を超えたら切り、切ったと印を付ける", () => {
    const result = clipNoticeText("い".repeat(NOTICE_TEXT_MAX_CHARS + 50), same);
    expect(result.truncated).toBe(true);
    expect(Array.from(result.text)).toHaveLength(NOTICE_TEXT_MAX_CHARS + 1);
    expect(result.text.endsWith("…")).toBe(true);
  });

  it("サロゲートペアの字を半分に割らない", () => {
    const text = "𠮷".repeat(NOTICE_TEXT_MAX_CHARS + 1);
    const result = clipNoticeText(text, same);
    expect(result.text).toBe(`${"𠮷".repeat(NOTICE_TEXT_MAX_CHARS)}…`);
  });

  it("キーらしき文字は logger.ts と同じ伏せ方で伏せる", () => {
    const result = clipNoticeText("鍵 sk-abcdefghijklmnop が違います", redactSecrets);
    expect(result.text).toBe("鍵 sk-*** が違います");
  });

  it("先に伏せてから切る（境目にかかったキーの頭を残さない）", () => {
    const key = "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
    const text = `${"x".repeat(NOTICE_TEXT_MAX_CHARS - 10)} ${key}`;
    const result = clipNoticeText(text, redactSecrets);
    expect(result.text).not.toContain("AIzaSyAB");
    expect(result.text).toContain("AIza***");
  });
});

describe("呼び出しから中身を取る（describeNoticeCall）", () => {
  it("文とボタン（文字列）", () => {
    expect(describeNoticeCall("warning", ["消しますか", "消す", "やめる"], same)).toEqual({
      severity: "warning",
      modal: false,
      message: "消しますか",
      detail: null,
      items: ["消す", "やめる"],
      truncated: false,
    });
  });

  it("2つ目が options なら、モーダルと説明を取り、ボタンに数えない", () => {
    const described = describeNoticeCall(
      "info",
      ["登録しますか", { modal: true, detail: "作品フォルダーを登録します" }, "登録"],
      same
    );
    expect(described.modal).toBe(true);
    expect(described.detail).toBe("作品フォルダーを登録します");
    expect(described.items).toEqual(["登録"]);
  });

  it("ボタンが { title } の形でも名前を取る", () => {
    const described = describeNoticeCall(
      "error",
      ["失敗しました", { title: "ログを見る" }, { title: "閉じる", isCloseAffordance: true }],
      same
    );
    expect(described.modal).toBe(false);
    expect(described.items).toEqual(["ログを見る", "閉じる"]);
  });

  it("見分けられない引数は捨てる（記録のために止めない）", () => {
    const described = describeNoticeCall("info", ["文", 42, null, "押す"], same);
    expect(described.items).toEqual(["押す"]);
  });

  it("説明やボタンが長ければ、それも切って印を付ける", () => {
    const described = describeNoticeCall(
      "info",
      ["短い", { modal: true, detail: "う".repeat(300) }],
      same
    );
    expect(described.truncated).toBe(true);
    expect(Array.from(described.detail ?? "")).toHaveLength(NOTICE_TEXT_MAX_CHARS + 1);
  });

  it("押されたボタンの名前（閉じただけなら null）", () => {
    expect(answerChoice("消す", same)).toBe("消す");
    expect(answerChoice({ title: "ログを見る" }, same)).toBe("ログを見る");
    expect(answerChoice(undefined, same)).toBeNull();
  });
});

describe("上限（pruneNotices）", () => {
  it(`${NOTICE_LOG_MAX_ENTRIES}件を超えたら、古いほうから落とす`, () => {
    const many = Array.from({ length: NOTICE_LOG_MAX_ENTRIES + 20 }, (_, index) =>
      entry({ seq: index + 1, at: new Date(NOW.getTime() - 60_000 + index).toISOString() })
    );
    const kept = pruneNotices(many, NOW);
    expect(kept).toHaveLength(NOTICE_LOG_MAX_ENTRIES);
    expect(kept[0].seq).toBe(21);
    expect(kept[kept.length - 1].seq).toBe(NOTICE_LOG_MAX_ENTRIES + 20);
  });

  it("7日より古いものと、時刻の読めないものを落とす", () => {
    const kept = pruneNotices(
      [
        entry({ seq: 1, at: new Date(NOW.getTime() - NOTICE_LOG_MAX_AGE_MS - 1).toISOString() }),
        entry({ seq: 2, at: "壊れた時刻" }),
        entry({ seq: 3, at: new Date(NOW.getTime() - NOTICE_LOG_MAX_AGE_MS).toISOString() }),
      ],
      NOW
    );
    expect(kept.map((item) => item.seq)).toEqual([3]);
  });

  it("保管期間を過ぎた記録ファイルは片づけの対象、読めない時刻は対象にしない", () => {
    expect(
      isNoticeLogExpired(
        file({ updatedAt: new Date(NOW.getTime() - NOTICE_LOG_MAX_AGE_MS - 1).toISOString() }),
        NOW
      )
    ).toBe(true);
    expect(isNoticeLogExpired(file(), NOW)).toBe(false);
    expect(isNoticeLogExpired(file({ updatedAt: "?" }), NOW)).toBe(false);
  });
});

describe("記録を読む（parseNoticeLog）", () => {
  it("書いたものをそのまま読み戻せる", () => {
    const original = file({
      notices: [entry({ answer: { at: "2026-09-24T09:00:05.000Z", choice: "消す" } })],
    });
    expect(parseNoticeLog(serializeNoticeLog(original))).toEqual(original);
  });

  it("壊れた記録は投げずに undefined", () => {
    expect(parseNoticeLog("{")).toBeUndefined();
    expect(parseNoticeLog("[]")).toBeUndefined();
    expect(parseNoticeLog(JSON.stringify({ ...file(), schema: 99 }))).toBeUndefined();
    expect(parseNoticeLog(JSON.stringify({ ...file(), pid: "1" }))).toBeUndefined();
  });

  it("知らせ1件が壊れていても、その1件だけを落として残りは読む", () => {
    const text = JSON.stringify({
      ...file(),
      notices: [entry({ seq: 1 }), { seq: 2, message: 3 }, entry({ seq: 3 })],
    });
    expect(parseNoticeLog(text)?.notices.map((item) => item.seq)).toEqual([1, 3]);
  });
});

describe("絞り込み（selectNotices）", () => {
  const files = [
    file({
      pid: 100,
      notices: [
        entry({ seq: 1, at: "2026-09-24T09:00:00.000Z", message: "作品を登録しました" }),
        entry({ seq: 2, at: "2026-09-24T09:10:00.000Z", message: "保存しました", items: ["登録を解除"] }),
      ],
    }),
    file({
      pid: 200,
      notices: [
        entry({ seq: 1, at: "2026-09-24T09:05:00.000Z", message: "失敗", detail: "登録できません", severity: "error" }),
        entry({ seq: 2, at: "2026-09-10T09:05:00.000Z", message: "古い知らせ" }),
      ],
    }),
  ];

  it("新しい順に並べ、どの窓かを添える。7日より古いものは出さない", () => {
    const { notices, matched } = selectNotices(files, {}, NOW);
    expect(notices.map((item) => [item.pid, item.seq])).toEqual([
      [100, 2],
      [200, 1],
      [100, 1],
    ]);
    expect(matched).toBe(3);
    expect(notices[0].machineName).toBe("DESKTOP");
  });

  it("since より後だけ", () => {
    const { notices } = selectNotices(files, { since: "2026-09-24T09:05:00.000Z" }, NOW);
    expect(notices.map((item) => [item.pid, item.seq])).toEqual([[100, 2]]);
  });

  it("contains は文・説明・ボタンの名前のどれかに含むもの", () => {
    const { notices } = selectNotices(files, { contains: "登録" }, NOW);
    expect(notices.map((item) => [item.pid, item.seq])).toEqual([
      [100, 2],
      [200, 1],
      [100, 1],
    ]);
    expect(selectNotices(files, { contains: "保存" }, NOW).matched).toBe(1);
  });

  it("pid でその窓だけ", () => {
    const { notices } = selectNotices(files, { pid: 200 }, NOW);
    expect(notices.map((item) => item.seq)).toEqual([1]);
  });

  it("limit で切っても、合った数（matched）は切る前の数", () => {
    const result = selectNotices(files, { limit: 1 }, NOW);
    expect(result.notices).toHaveLength(1);
    expect(result.matched).toBe(3);
  });

  it("limit は 1〜500 に収める", () => {
    expect(selectNotices(files, { limit: 0 }, NOW).notices).toHaveLength(1);
    expect(selectNotices(files, { limit: 100_000 }, NOW).notices).toHaveLength(3);
  });
});
