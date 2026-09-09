import { describe, expect, test } from "vitest";
import {
  SETTINGS_ASSISTANT_SYSTEM_PROMPT,
  SETTINGS_CHAT_VERSION,
} from "../../src/prompts/settingsChat";
import {
  WORK_CHAT_SYSTEM_PROMPT,
  WORK_CHAT_VERSION,
} from "../../src/prompts/workChat";
import { BASE_SYSTEM_PROMPT } from "../../src/prompts/characterExtract";

/**
 * 「分からない」で突き放す指示が、考えるための問いにまで掛かっていた
 * 不具合の再現（作者の指摘、2026-08-16）。
 *
 * 実データ（いじめられっ子18話）で測ったところ：
 *
 * | 指示 | 幻覚 | 「テーマは？」への答え |
 * |---|---|---|
 * | 強い禁止 | 0/6 | **「分かりません」（6字）** |
 * | 区別させる | 0/6 | 792字（引用と解釈） |
 * | 制限なし | 2/6 | 1667字（世辞と冗長） |
 *
 * **禁止を強めても幻覚は減らず、答えだけが痩せる。**
 * 区別させるほうが、同じ安全さでずっと役に立つ。
 */

const CHAT_PROMPTS: Array<[string, string]> = [
  ["相談パネル（P-21）", WORK_CHAT_SYSTEM_PROMPT],
  ["設定資料パネル（P-18）", SETTINGS_ASSISTANT_SYSTEM_PROMPT],
];

describe("相談では、禁じるのではなく区別させる", () => {
  test.each(CHAT_PROMPTS)("%s は推測を「区別して書け」と言う", (_, prompt) => {
    expect(prompt).toContain("区別");
    expect(prompt).toMatch(/〜と読める|と読めます/);
  });

  test.each(CHAT_PROMPTS)("%s は考えるための問いで突き放さない", (_, prompt) => {
    // ここが無いと「この作品のテーマは？」に「分かりません」とだけ返る
    expect(prompt).toContain("突き放さない");
  });

  test.each(CHAT_PROMPTS)("%s は事実の問いに限って「見当たりません」と言う", (_, prompt) => {
    // 限定が外れると、解釈を求める問いまで拒む
    expect(prompt).toMatch(/出来事・数値・固有名詞/);
    expect(prompt).toContain("見当たりません");
  });

  test.each(CHAT_PROMPTS)("%s は無条件の「分かりませんと答えよ」を持たない", (_, prompt) => {
    // 「答えが無いときは分かりませんと答えること」という無条件の指示が
    // 残っていると、限定を書いても引っ張られる
    expect(prompt).not.toMatch(/答えが無いときは.{0,20}分かりません/);
  });
});

/**
 * **資料の矛盾を、作品の欠点として答えない**（作者の指摘、2026-09-07）。
 *
 * 実機では「文佳」の別名に「太志」が入った壊れた資料を渡され、AIは
 * 「文佳と太志が同一人物として扱われているため分かりにくい」と、
 * **資料の記録の問題を本文の話として**返した。資料は本文からAIが作った
 * ものなので、間違っていることがある。
 */
describe("資料の矛盾は、資料の話として断る", () => {
  test("作品の欠点として述べないよう釘を刺している", () => {
    expect(WORK_CHAT_SYSTEM_PROMPT).toContain("食い違っている");
    expect(WORK_CHAT_SYSTEM_PROMPT).toContain("作品の欠点");
    // 断ったあとの手を示す（読み直しの提案）
    expect(WORK_CHAT_SYSTEM_PROMPT).toContain("reloadRecord");
  });
});

/**
 * **書き込む中身に、助言を混ぜない**（作者の指摘、2026-09-07）。
 *
 * 「テーマの明確化」を押したら、`設定/plot.md` の「## テーマ」へ
 * 「〜を追加することで、わかりやすくなります」という助言の文まで入った。
 * content はそのまま作者のファイルへ書き込まれる。
 */
describe("書き込みの content は項目の中身だけ", () => {
  test("助言を入れないよう指示している", () => {
    expect(WORK_CHAT_SYSTEM_PROMPT).toContain("助言は reply に書いて");
    expect(WORK_CHAT_SYSTEM_PROMPT).toMatch(/content はその項目の中身だけ/);
  });
});

/**
 * **見立てを求められたら、見立てだけを返す**（作者の指摘、2026-09-08
 * 「１，２，３の選択肢も「わかりにくいですか？」の回答として
 * 論理が飛躍しています」）。
 *
 * 実機では「太志が文佳に憑依しているのはわかりにくいですか？」に対し、
 * AI自身が「明確に描かれています」と答えたうえで、
 * 「憑依の描写を強調する場面を3ヶ所提案してほしい」など**直す作業**の
 * 選択肢が3つ並んだ。**作者が聞いたのは見立てであって手順ではない。**
 */
describe("判断を求められたら、作業を勧めない", () => {
  test("options を空にし、作業の提案を付けないよう指示している", () => {
    expect(WORK_CHAT_SYSTEM_PROMPT).toContain("見立てだけを返す");
    expect(WORK_CHAT_SYSTEM_PROMPT).toContain("options は空配列");
    expect(WORK_CHAT_SYSTEM_PROMPT).toContain("頼まれていない作業を勧めない");
  });

  test("run／edit を付けてよいのは作業を頼まれたときだと書いてある", () => {
    // ここが無いと「作業は勧めるな」だけが残り、頼まれてもボタンが出なくなる
    expect(WORK_CHAT_SYSTEM_PROMPT).toMatch(
      /run や edit を付けてよいのは、\*\*作業を頼まれたとき\*\*/
    );
  });
});

/**
 * **留意点を、答えの結論と食い違わせない**（実機の観測、2026-09-08）。
 *
 * reply は「太志の憑依は本文と設定資料で**明確に描かれています**」なのに、
 * 青枠の留意点は「太志の憑依が**不十分に描写されている**」だった。
 * 同じ返答の中で正反対のことを言っている。
 */
describe("読み直しの留意点は、答えの結論と揃える", () => {
  test("資料の誤りを訴えられたときだけ付けるよう限定している", () => {
    expect(WORK_CHAT_SYSTEM_PROMPT).toContain(
      "**作者が資料の誤りを訴えたときだけ**付けること"
    );
    expect(WORK_CHAT_SYSTEM_PROMPT).toContain("本文の描写の\n  不足を感じただけ");
  });

  test("notes と reply の食い違いを禁じている", () => {
    expect(WORK_CHAT_SYSTEM_PROMPT).toContain(
      "notes は reply の結論と食い違わせないこと"
    );
  });
});

describe("抽出は厳しいままにする", () => {
  test("本文に無いことを書かせない指示は残す", () => {
    // 抽出結果は設定資料として**保存され**、後の判断の土台になる。
    // 読んで終わりの相談とは扱いを変える
    expect(BASE_SYSTEM_PROMPT).toMatch(
      /本文に(書かれていない|明示されていない)|推測/
    );
  });
});

describe("版", () => {
  test("プロンプトを変えたら版も上がっている", () => {
    // 版を止めたままだと、古い応答がキャッシュから返る
    expect(WORK_CHAT_VERSION).toBe("3.7");
    expect(SETTINGS_CHAT_VERSION).toBe("3.0");
  });
});
