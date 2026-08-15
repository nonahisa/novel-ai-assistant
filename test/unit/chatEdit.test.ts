import { describe, expect, test } from "vitest";
import {
  describeChatEditTarget,
  parseChatEdit,
  sanitizeRequestedPaths,
} from "../../src/core/chatEdit";

function parse(target: string, content = "書き込む内容") {
  return parseChatEdit({ target, content });
}

describe("書き込み先の解釈", () => {
  test("プロットの項目を指せる", () => {
    const result = parse("plot.theme");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.edit.target).toEqual({ kind: "plot", section: "theme" });
    expect(result.edit.label).toBe("プロットの「テーマ」に書き込む");
  });

  test("紹介文とキャッチコピーを指せる", () => {
    expect(parse("blurb").ok).toBe(true);
    expect(parse("catchphrase").ok).toBe(true);
  });

  test("話数を添えて各話あらすじを指せる", () => {
    const result = parse("episode.7");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.edit.target).toEqual({ kind: "episodeSynopsis", chapter: 7 });
  });

  test("本文は書き換えられない（はっきり断る）", () => {
    // 作者の許可は「小説本文以外」。黙って無視すると理由が伝わらないので、
    // 断る理由を返して画面に出せるようにする
    for (const target of ["manuscript", "本文", "episodeBody.3"]) {
      const result = parseChatEdit({ target, content: "書き換え" });
      expect(result.ok, target).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe("manuscript_not_allowed");
    }
  });

  test("知らない書き込み先は受け付けない", () => {
    for (const target of ["characters.md", "plot.unknown", "episode.ゼロ", ""]) {
      const result = parseChatEdit({ target, content: "内容" });
      expect(result.ok, target).toBe(false);
    }
  });

  test("空の内容は受け付けない", () => {
    const result = parseChatEdit({ target: "blurb", content: "   " });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("empty_content");
  });

  test("長すぎる内容は受け付けない（丸ごと差し替えを防ぐ）", () => {
    const result = parseChatEdit({
      target: "blurb",
      content: "あ".repeat(5000),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("too_long");
  });

  test("AIがラベルを付けなければ、こちらで組み立てる", () => {
    const result = parse("episode.3");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.edit.label).toBe("第3話のあらすじに書き込む");
  });

  test("説明はどの書き込み先でも作れる", () => {
    expect(describeChatEditTarget({ kind: "blurb" })).toContain("作品紹介文");
    expect(
      describeChatEditTarget({ kind: "plot", section: "logline" })
    ).toContain("ログライン");
  });
});

describe("読み込みを求められたパスの絞り込み", () => {
  test("作品フォルダーの中の相対パスだけを通す", () => {
    const result = sanitizeRequestedPaths(
      ["設定/plot.md", "episode_0003.txt"],
      3
    );

    expect(result).toEqual(["設定/plot.md", "episode_0003.txt"]);
  });

  test("作品の外へ出ようとするパスを弾く", () => {
    // ここを通すと、作品と無関係のファイルをAIへ渡せてしまう
    const result = sanitizeRequestedPaths(
      [
        "../別の作品/秘密.txt",
        "/etc/passwd",
        "C:/Users/nonah/Documents/秘密.txt",
        "設定/../../外.txt",
      ],
      5
    );

    expect(result).toEqual([]);
  });

  test("拡張機能の作業用フォルダは読ませない", () => {
    // キャッシュ・ログには失敗の記録が入る。作品の中身ではない
    const result = sanitizeRequestedPaths(
      [".aiwriter/logs/actions.log", ".novelai-recovery/x.bak"],
      5
    );

    expect(result).toEqual([]);
  });

  test("件数の上限で切る", () => {
    const result = sanitizeRequestedPaths(["a.txt", "b.txt", "c.txt", "d.txt"], 2);

    expect(result).toEqual(["a.txt", "b.txt"]);
  });

  test("同じパスは1つにする", () => {
    const result = sanitizeRequestedPaths(["a.txt", "a.txt"], 3);

    expect(result).toEqual(["a.txt"]);
  });

  test("配列でなければ何も読まない", () => {
    expect(sanitizeRequestedPaths(undefined, 3)).toEqual([]);
    expect(sanitizeRequestedPaths("設定/plot.md", 3)).toEqual([]);
  });
});
