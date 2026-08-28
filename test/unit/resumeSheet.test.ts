import { describe, expect, test } from "vitest";
import {
  buildEpisodePlotTemplate,
  buildResumeSheet,
  episodePlotFileName,
  RESUME_TAIL_LIMIT,
  tailParagraphs,
  type ResumeSheetInput,
} from "../../src/core/resumeSheet";

/**
 * 執筆再開の1枚（設計書6.36.1）と、単話プロットの雛形（6.36.2）。
 *
 * **AIを呼ばない部分だけ**を確かめる。ここで見るのは「材料が揃ったとき」
 * よりも、**揃っていないとき**の見え方である——本文がまだ無い・あらすじを
 * 作っていない・伏線が0件、という状態こそが書き始めの日の普通の姿で、
 * そこで空の見出しばかり並ぶと1枚として使えない。
 */

function input(overrides: Partial<ResumeSheetInput> = {}): ResumeSheetInput {
  return {
    workTitle: "湖畔の誓い",
    latest: {
      label: "第19話",
      title: "再会",
      chars: 1234,
      countLabel: "",
      tail: "彼女は振り返らなかった。\n雪が、静かに降り始めていた。",
    },
    synopses: [
      { label: "第17話", title: "約束", synopsis: "湖のほとりで約束を交わす。" },
      { label: "第18話", title: null, synopsis: "手紙が届く。" },
    ],
    openForeshadows: [
      {
        label: "銀の懐中時計",
        plantedChapter: 3,
        quote: "彼は懐中時計を握りしめた",
        note: "父の形見らしい",
      },
    ],
    episodePlot: { kind: "found", path: "設定/episode-plots/第19話.md", body: "# 第19話の単話プロット\n\n## 視点\n藍" },
    todayGoal: { written: 1200, goal: 2000, remaining: 800 },
    ...overrides,
  };
}

/** `##` の見出しだけを取り出す */
function headings(markdown: string): string[] {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3));
}

describe("再開の1枚（材料が揃っているとき）", () => {
  const sheet = buildResumeSheet(input());

  test("見出しは作品名を含む", () => {
    expect(sheet.startsWith("# 執筆再開：湖畔の誓い")).toBe(true);
  });

  test("節は決めた順に並ぶ", () => {
    // 前回の続きを最初に見せる。要約より先に本文を置く。
    // **単話プロットの中身は「そのまま」出す**ので、その見出しが混ざらない
    // 状態（まだ作っていない話）で並びを見る
    const bare = buildResumeSheet(
      input({
        episodePlot: { kind: "missing", path: "設定/episode-plots/第19話.md" },
      })
    );

    expect(headings(bare)).toEqual([
      "前回どこまで",
      "前話までのあらすじ",
      "未回収の伏線（1件）",
      "この話の単話プロット",
      "次にすること",
    ]);
  });

  test("最新話の話数・題・文字数が出る", () => {
    expect(sheet).toContain("第19話「再会」／1,234字");
  });

  test("末尾の数段落を、引用として出す", () => {
    // 本文には「-」で始まる行も入りうる。引用にしておけば、
    // どこからどこまでが原稿かが目で分かる
    expect(sheet).toContain("> 彼女は振り返らなかった。");
    expect(sheet).toContain("> 雪が、静かに降り始めていた。");
  });

  test("前話までのあらすじが、話数付きで並ぶ", () => {
    expect(sheet).toContain("- 第17話「約束」：湖のほとりで約束を交わす。");
    // 題が無い話でも、話数だけで出す
    expect(sheet).toContain("- 第18話：手紙が届く。");
  });

  test("未回収の伏線は、張った話数と引用を添える", () => {
    expect(sheet).toContain("- 銀の懐中時計（第3話で張った）");
    expect(sheet).toContain("引用：「彼は懐中時計を握りしめた」");
  });

  test("単話プロットは中身をそのまま出す", () => {
    expect(sheet).toContain("（設定/episode-plots/第19話.md）");
    expect(sheet).toContain("## 視点\n藍");
  });

  test("今日の目標は、この作品ぶんだと断って出す", () => {
    // 目標（1日）は全作品で共有する値なので、断らないと読み違える
    expect(sheet).toContain("今日：1,200/2,000字（あと800字。この作品で書いた分）");
  });

  test("押せないリンクを置かない", () => {
    // 保存していないMarkdownは素のテキストで開くことがあり、
    // command: のリンクはそこで文字列のまま残る
    expect(sheet).not.toContain("command:");
    expect(sheet).toContain("「単話プロットを作る」");
  });
});

describe("材料が無いとき", () => {
  test("本文がまだ無ければ、その旨と始め方を出す", () => {
    const sheet = buildResumeSheet(input({ latest: null }));

    expect(sheet).toContain("まだ本文がありません");
    expect(headings(sheet)).toContain("前回どこまで");
  });

  test("白紙の話は、白紙だと書く", () => {
    const sheet = buildResumeSheet(
      input({
        latest: {
          label: "第20話",
          title: null,
          chars: 0,
          countLabel: "",
          tail: "",
        },
      })
    );

    expect(sheet).toContain("まだ1文字も書かれていません");
  });

  test("あらすじが無ければ、作り方をメニューの名前で案内する", () => {
    const sheet = buildResumeSheet(input({ synopses: [] }));

    // 言い換えると、探しても見つからない
    expect(sheet).toContain("「各話あらすじを生成」で作れます");
  });

  test("伏線が0件なら、節ごと出さない", () => {
    // 無いものの見出しで場所を取らない（書き始める前に見る1枚である）
    const sheet = buildResumeSheet(input({ openForeshadows: [] }));

    expect(headings(sheet)).not.toContain("未回収の伏線（0件）");
    expect(sheet).not.toContain("未回収の伏線");
  });

  test("単話プロットが無ければ、置き場と作り方を出す", () => {
    const sheet = buildResumeSheet(
      input({
        episodePlot: { kind: "missing", path: "設定/episode-plots/第19話.md" },
      })
    );

    expect(sheet).toContain(
      "「単話プロットを作る」で 設定/episode-plots/第19話.md に雛形を作れます"
    );
  });

  test("話数が読めない話では、置き場を決められないと書く", () => {
    // 「まだありません」と括ると、押しても作れない案内になる
    const sheet = buildResumeSheet(
      input({ episodePlot: { kind: "unnumbered" } })
    );

    expect(sheet).toContain("話数が読み取れないため");
  });

  test("目標が取れなければ、行ごと出さない", () => {
    const sheet = buildResumeSheet(input({ todayGoal: null }));

    expect(sheet).not.toContain("今日：");
  });

  test("読めなかった材料は、先に断る", () => {
    // あとに回すと「まだありません」を本当だと読んでしまう
    const sheet = buildResumeSheet(
      input({ synopses: [], notices: ["各話あらすじを読めませんでした：壊れています"] })
    );

    const noticeAt = sheet.indexOf("各話あらすじを読めませんでした");
    expect(noticeAt).toBeGreaterThan(0);
    expect(noticeAt).toBeLessThan(sheet.indexOf("## 前回どこまで"));
  });
});

describe("末尾の切り出し", () => {
  /** 100字の段落を作る */
  const paragraph = (mark: string) => mark.repeat(100);

  test("段落の切れ目で切り、上限に収まる", () => {
    const source = [
      paragraph("あ"),
      paragraph("い"),
      paragraph("う"),
      paragraph("え"),
      paragraph("お"),
      paragraph("か"),
    ].join("\n");

    const tail = tailParagraphs(source);

    expect(tail.length).toBeLessThanOrEqual(RESUME_TAIL_LIMIT);
    // 段落の途中では切らない＝結果はもとの文章の末尾そのままである
    expect(source.endsWith(tail)).toBe(true);
    // 切れ目で切っているので、どの行も丸ごと残っている
    for (const line of tail.split("\n")) {
      expect(line.length).toBe(100);
    }
  });

  test("空行はそのまま残す", () => {
    const source = ["前の段落。", "", "次の段落。"].join("\n");

    expect(tailParagraphs(source)).toBe(source);
  });

  test("末尾の空行は落とす", () => {
    expect(tailParagraphs("本文。\n\n\n")).toBe("本文。");
  });

  test("何も書かれていなければ空を返す", () => {
    expect(tailParagraphs("   \n\n")).toBe("");
  });

  test("1段落が長すぎるときは、文の切れ目で頭を落とす", () => {
    // 改行を入れずに書く作者もいる。切ったことは「…」で示す
    const source = `${"あ".repeat(500)}。${"い".repeat(200)}。`;

    const tail = tailParagraphs(source);

    expect(tail.startsWith("…")).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(RESUME_TAIL_LIMIT + 1);
    expect(tail).toContain("い");
  });
});

describe("単話プロットの雛形", () => {
  const template = buildEpisodePlotTemplate(19);

  test("作者の指定の3項目が並ぶ", () => {
    expect(headings(template)).toEqual([
      "視点",
      "この話の目標",
      "展開（箇条書き）",
    ]);
  });

  test("見出しに話数が入る", () => {
    expect(template.startsWith("# 第19話の単話プロット")).toBe(true);
  });

  test("展開は箇条書きの行を空で用意する", () => {
    // 書くのは作者。AIに筋書きを作らせない（設計書6.36.2）
    const bullets = template
      .split("\n")
      .filter((line) => line.startsWith("- "));

    expect(bullets).toHaveLength(3);
    for (const bullet of bullets) expect(bullet.trim()).toBe("-");
  });

  test("ファイル名は話数の表記と揃える", () => {
    expect(episodePlotFileName(19)).toBe("第19話.md");
    // ゼロ埋めしない（見出しの「第7話」と揃える）
    expect(episodePlotFileName(7)).toBe("第7話.md");
  });
});
