import { describe, expect, test } from "vitest";
import {
  describeChatEditButton,
  describeChatEditDestination,
  parseChatEdit,
  findExtensionVariant,
  parseChatRun,
  pickFileHints,
  sanitizeRequestedPaths,
} from "../../../src/core/chatEdit";

function parse(target: string, content = "書き込む内容") {
  return parseChatEdit({ target, content });
}

describe("書き込み先の解釈", () => {
  test("プロットの項目を指せる", () => {
    const result = parse("plot.theme");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.edit.target).toEqual({ kind: "plot", section: "theme" });
    // **見出しは「どのファイルのどこ」を名乗る**（作者の指摘、2026-09-07）。
    // 「テーマの明確化」というAIの言葉のままでは、押すと plot.md が
    // 書き換わることが読み取れなかった
    expect(result.edit.label).toBe("設定/plot.md の「テーマ」を書き換える");
  });

  test("AIのラベルは補足として括弧で添える（信じて見出しにはしない）", () => {
    const result = parseChatEdit({
      target: "plot.theme",
      content: "テーマそのもの",
      label: "テーマの明確化",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.edit.label).toBe(
      "設定/plot.md の「テーマ」を書き換える（テーマの明確化）"
    );
  });

  test("書き込み先を、ファイルと項目名で言える", () => {
    // 確認のモーダルの題に使う。作者の作品ファイルへ書く操作なので、
    // どこが変わるかが押す前に読めること
    expect(describeChatEditDestination({ kind: "plot", section: "theme" })).toEqual(
      { file: "設定/plot.md", item: "テーマ" }
    );
    expect(describeChatEditDestination({ kind: "blurb" }).file).toBe(
      "設定/synopsis.md"
    );
    expect(
      describeChatEditDestination({ kind: "episodeSynopsis", chapter: 4 })
    ).toEqual({ file: "設定/chapter_synopses.json", item: "第4話のあらすじ" });
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
    expect(result.edit.label).toBe(
      "設定/chapter_synopses.json の「第3話のあらすじ」を書き換える"
    );
  });

  test("見出しはどの書き込み先でも作れる", () => {
    expect(describeChatEditButton({ kind: "blurb" })).toContain("作品紹介文");
    expect(
      describeChatEditButton({ kind: "plot", section: "logline" })
    ).toContain("ログライン");
  });
});

describe("起動してよい標準機能", () => {
  test("許可した3つを起動できる", () => {
    expect(parseChatRun("checkTypos")?.kind).toBe("checkTypos");
    expect(parseChatRun("checkTyposForFile")?.kind).toBe("checkTyposForFile");
    expect(parseChatRun("checkNotation")?.kind).toBe("checkNotation");
  });

  test("AIを使うかどうかを添える（料金の有無が押す前に分かる）", () => {
    expect(parseChatRun("checkTypos")?.usesAI).toBe(true);
    // 表記ゆれはルールだけで判定するので料金がかからない
    expect(parseChatRun("checkNotation")?.usesAI).toBe(false);
  });

  test("許可していないものは起動できない", () => {
    // ここを通すと、AIの返した文字列がそのままコマンド名になり、
    // 作品の削除を含むあらゆる操作が会話の一言で動かせてしまう
    for (const value of [
      "novelai.deleteEpisodeFile",
      "workbench.action.closeWindow",
      "gitPush",
      "removeWork",
      "",
    ]) {
      expect(parseChatRun(value), value).toBeUndefined();
    }
  });

  test("消す操作・作品の登録を変える操作は入れない", () => {
    // 会話の一言でファイルが消えては取り返しがつかない。
    // 一覧を広げるときも、この線引きは動かさない
    for (const value of [
      "deleteEpisodeFile",
      "removeWork",
      "clearVectorIndex",
      "gitRestore",
    ]) {
      expect(parseChatRun(value), value).toBeUndefined();
    }
  });

  test("作業を頼まれたときに勧める操作は起動できる", () => {
    // 一覧に無い操作を勧めると、作者は「やると言ったのに動かない」画面を見る
    // （実機で「資料抽出→設定資料集を出力」を勧められて起動できなかった）
    for (const value of [
      "extractSettings",
      "generateSettingsDocs",
      "generateSynopses",
      "unifyCharacters",
    ]) {
      expect(parseChatRun(value)?.kind, value).toBe(value);
    }
  });

  test("文字列でなければ起動しない", () => {
    expect(parseChatRun(undefined)).toBeUndefined();
    expect(parseChatRun({ kind: "checkTypos" })).toBeUndefined();
    expect(parseChatRun(["checkTypos"])).toBeUndefined();
  });

  test("大文字小文字の揺れは受け入れる", () => {
    // 種別名の綴りはAIが揺らしがちで、そこで弾くと使えない機能になる
    expect(parseChatRun("CHECKTYPOS")?.kind).toBe("checkTypos");
    expect(parseChatRun(" checknotation ")?.kind).toBe("checkNotation");
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
        "C:/Users/author/Documents/秘密.txt",
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

/**
 * AIが求めたファイルが無いときの拡張子違いの引き当て（2026-09-24、実データの測定）。
 *
 * AIは `episode_0001.txt` を求めたが、実物は `episode_0001.md` だった。
 * 読めないまま黙って止まり、作者の画面には「本文を提示してください」だけが
 * 残った。**引き当てるのは候補が1つに決まるときだけ**——当て推量で
 * 別の話を読ませると、違う話についての講評が返る（実装ルール3）。
 */
describe("求められたファイルの拡張子違いを引き当てる", () => {
  test("拡張子だけ違う原稿が1つだけあれば、それを読む", () => {
    expect(
      findExtensionVariant("episode_0001.txt", [
        "episode_0001.md",
        "episode_0002.md",
      ])
    ).toBe("episode_0001.md");
    // 逆向き（.md を求められて .txt がある）も同じ
    expect(findExtensionVariant("第1話.md", ["第1話.txt"])).toBe("第1話.txt");
  });

  test("下のフォルダーのパスは、フォルダーを付けたまま返す", () => {
    expect(
      findExtensionVariant("本編/episode_0003.txt", ["episode_0003.md"])
    ).toBe("本編/episode_0003.md");
  });

  test("候補が2つあれば引き当てない", () => {
    // 拡張子の無い指定は .txt と .md のどちらにも当たる。どちらかを
    // 選ぶ根拠が無いので読まない
    expect(
      findExtensionVariant("episode_0001", [
        "episode_0001.txt",
        "episode_0001.md",
      ])
    ).toBeUndefined();
    // 大文字小文字だけ違う2つも、どちらか決められない
    expect(findExtensionVariant("a.txt", ["a.md", "a.MD"])).toBeUndefined();
  });

  test("拡張子の無い指定は、候補が1つなら引き当てる", () => {
    expect(findExtensionVariant("episode_0001", ["episode_0001.md"])).toBe(
      "episode_0001.md"
    );
  });

  test("候補が無ければ引き当てない", () => {
    expect(
      findExtensionVariant("episode_0001.txt", [
        "episode_0002.md",
        "episode_0001.json",
      ])
    ).toBeUndefined();
    // 名前の一部が同じだけのものは別のファイル
    expect(
      findExtensionVariant("episode_0001.txt", [
        "episode_00010.md",
        "episode_0001_改.md",
      ])
    ).toBeUndefined();
  });

  test("原稿でない拡張子は引き当てない", () => {
    // 設定のJSONを求められて、同じ名前のMarkdownを渡すのは別物
    expect(
      findExtensionVariant("設定/characters.json", ["characters.md"])
    ).toBeUndefined();
  });

  test("親フォルダーへ出るパスは今までどおり断る", () => {
    // 絞り込み（sanitizeRequestedPaths）が先に落とすので、引き当てまで届かない
    expect(sanitizeRequestedPaths(["../外/episode_0001.txt"], 3)).toEqual([]);
    // 引き当ての側も、外へ出る指定には答えない（二重の歯止め）
    expect(
      findExtensionVariant("../episode_0001.txt", ["episode_0001.md"])
    ).toBeUndefined();
  });
});

describe("見つからなかったときに示すファイルの候補", () => {
  const available = [
    { path: "episode_0001.md", label: "第1話 出会い" },
    { path: "episode_0002.md", label: "第2話 別れ" },
    { path: "episode_0003.md", label: "第3話 再会" },
    { path: "episode_0015.md", label: "第15話 旅立ち" },
  ];

  test("求められた番号と同じ番号のものを先に並べる", () => {
    const hints = pickFileHints(["episode_0015.txt"], available, 3);
    expect(hints.map((hint) => hint.path)).toEqual([
      "episode_0015.md",
      "episode_0001.md",
      "episode_0002.md",
    ]);
  });

  test("番号が当たらなければ先頭から並べ、上限で切る", () => {
    const hints = pickFileHints(["あとがき.txt"], available, 2);
    expect(hints.map((hint) => hint.path)).toEqual([
      "episode_0001.md",
      "episode_0002.md",
    ]);
  });
});
