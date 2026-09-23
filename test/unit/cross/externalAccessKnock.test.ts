import { describe, expect, it } from "vitest";
import {
  EXTERNAL_ACCESS_DENIED_DETAIL,
  isExternalAccessKnock,
  parseExternalAccessLog,
  pendingExternalAccessKnocks,
  type ExternalAccessEntry,
} from "../../src/core/externalAccessLog";
import { recordExternalAccess } from "../../src/mcp/tools/accessLog";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

/**
 * 外部AIのノックを見つけて、作者に知らせる（設計書6.87.14）。
 *
 * **作者の指示（2026-09-16）**：「MCP承認を検知した場合は、拡張機能の
 * 画面上にポップアップさせてください」。
 *
 * ## ここで見張りたいこと
 *
 * 1. **知らせるのは「断った回」だけ。** 許可済みの呼び出しまで出すと、
 *    作者は画面を閉じることを覚えてしまい、**本当に知らせたい回まで
 *    閉じられる**
 * 2. **同じノックで何度も呼ばない。** 外部AIはチャンクごとに呼ぶので、
 *    畳まないと数十回のポップアップになる
 * 3. **MCP が書いた印を、拡張機能がそのまま読めること**——文字列を
 *    写していると、片方を直したときに検知が黙って止まる
 */

function entry(over: Partial<ExternalAccessEntry> = {}): ExternalAccessEntry {
  return {
    time: "2026-09-16T10:00:00.000Z",
    tool: "typo.run",
    client: "claude-code",
    file: "",
    exposure: "none",
    model: "",
    ok: false,
    detail: EXTERNAL_ACCESS_DENIED_DETAIL,
    ...over,
  };
}

describe("ノックかどうか", () => {
  it("断った回はノック", () => {
    expect(isExternalAccessKnock(entry())).toBe(true);
  });

  it("**うまくいった回はノックではない**（知らせない）", () => {
    expect(isExternalAccessKnock(entry({ ok: true, detail: "" }))).toBe(false);
  });

  it("ほかの理由の失敗はノックではない", () => {
    // 許可はあったが、道具の中で失敗した回。これは記録に残るだけでよい
    expect(
      isExternalAccessKnock(entry({ detail: "本文ファイルが見つかりません" }))
    ).toBe(false);
  });

  it("**MCP が書いた行を、そのまま読める**（写しを作らない）", () => {
    /*
      印の文字列を両側で書くと、片方を直したときに**検知が黙って止まる**。
      ここは実際に書かせて、読めることを確かめる。
    */
    const folder = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-knock-"));
    try {
      recordExternalAccess({
        tool: "typo.run",
        args: { folder },
        ok: false,
        denied: true,
      });
      const text = fs.readFileSync(
        nodePath.join(folder, ".aiwriter", "history", "external.jsonl"),
        "utf8"
      );
      const entries = parseExternalAccessLog(text);
      expect(entries).toHaveLength(1);
      expect(isExternalAccessKnock(entries[0])).toBe(true);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("どれを知らせるか", () => {
  it("**同じ相手の同じ道具は、1つに畳む**", () => {
    const knocks = pendingExternalAccessKnocks(
      [
        entry({ time: "2026-09-16T10:00:03.000Z" }),
        entry({ time: "2026-09-16T10:00:02.000Z" }),
        entry({ time: "2026-09-16T10:00:01.000Z" }),
      ],
      ""
    );
    expect(knocks).toHaveLength(1);
    // いちばん新しいものを残す（記録は新しい順に並んで来る）
    expect(knocks[0].at).toBe("2026-09-16T10:00:03.000Z");
  });

  it("道具が違えば、別に知らせる", () => {
    const knocks = pendingExternalAccessKnocks(
      [entry(), entry({ tool: "settings.run" })],
      ""
    );
    expect(knocks.map((knock) => knock.tool)).toEqual([
      "typo.run",
      "settings.run",
    ]);
  });

  it("接続元が違えば、別に知らせる", () => {
    const knocks = pendingExternalAccessKnocks(
      [entry(), entry({ client: "別のなにか" })],
      ""
    );
    expect(knocks).toHaveLength(2);
  });

  it("**知らせた時刻より古いものは、もう出さない**", () => {
    const knocks = pendingExternalAccessKnocks(
      [
        entry({ time: "2026-09-16T10:00:05.000Z", tool: "work.scan" }),
        entry({ time: "2026-09-16T09:00:00.000Z" }),
      ],
      "2026-09-16T10:00:00.000Z"
    );
    expect(knocks.map((knock) => knock.tool)).toEqual(["work.scan"]);
  });

  it("うまくいった記録は混ざらない", () => {
    const knocks = pendingExternalAccessKnocks(
      [entry({ ok: true, detail: "" }), entry({ tool: "work.scan" })],
      ""
    );
    expect(knocks.map((knock) => knock.tool)).toEqual(["work.scan"]);
  });

  it("**名前に区切り文字が入っていても、別の組と混ざらない**", () => {
    /*
      鍵を「名前＋区切り＋道具」で作ると、区切り文字を名乗る相手が来た
      ときに別の組と衝突する。`JSON.stringify` で作れば起きない。
    */
    // 区切りに使われがちな文字を、名前のほうに入れてみる
    const separator = String.fromCharCode(0);
    const knocks = pendingExternalAccessKnocks(
      [
        entry({ client: "a", tool: `b${separator}c` }),
        entry({ client: `a${separator}b`, tool: "c" }),
      ],
      ""
    );
    expect(knocks).toHaveLength(2);
  });
});
