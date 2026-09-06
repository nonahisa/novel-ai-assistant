import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  buildDictationCleanPrompt,
  DICTATION_CLEAN_SCHEMA,
  DICTATION_CLEAN_SYSTEM_PROMPT,
  DICTATION_CLEAN_VERSION,
  DICTATION_MIN_CHARS,
} from "../../src/prompts/dictationClean";
import {
  DICTATION_MAX_LENGTH_RATIO,
  DICTATION_MIN_LENGTH_RATIO,
  dictationQuoteAllowance,
  parseDictationCleanResult,
  validateDictationClean,
} from "../../src/core/dictationCleanValidation";
import { EXTRA_GUIDE, buildGuideBundles } from "../../src/features/featureGuide";
import { allActions } from "../../src/views/actionList";
import { COMMAND_FEATURES } from "../../src/core/workTypeVisibility";

/**
 * 口述筆記（P-35、設計書6.83）。
 *
 * **拡張機能はマイクに触らない。** 声を文字にするのはOSの音声入力で、
 * ここで確かめるのは「入り終わった文字列を、書き直さずに整えられるか」
 * だけである。
 *
 * いちばん怖いのは**作者の言葉がAIの言葉へ置き換わること**なので、
 * プロンプトの禁止事項と、置き換え前の検証（長さ・鍵括弧）を見る。
 */

const COMMAND = "novelai.dictationClean";

describe("P-35 口述の整文のプロンプト", () => {
  const prompt = buildDictationCleanPrompt({ dictatedText: "きょうはいい天気" });

  test("してよいことを3つに限っている", () => {
    // 「読みやすくして」と頼むと、作者の言葉がAIの言葉へ置き換わる
    expect(prompt).toContain("句読点と改行を入れる");
    expect(prompt).toContain("誤変換を直す");
    expect(prompt).toContain("言いよどみを取る");
  });

  test("足さない・削らない・言い換えないを禁止として書いている", () => {
    expect(prompt).toContain("言葉を足さない");
    expect(prompt).toContain("言葉を削らない");
    expect(prompt).toContain("言い換えない");
  });

  /**
   * **指示語はそのまま返ってくる**（この作品で繰り返し起きた）。
   * 「えーと」を例に挙げる以上、本文の言葉としての「えーと」と
   * 区別できなければ、作者が書いた台詞の口ごもりまで消える。
   * そこで**位置**（文頭・句点の直後）で切ることを明記させる。
   */
  test("言いよどみは、語ではなく位置で切らせる", () => {
    expect(prompt).toContain("文頭または句点");
    expect(prompt).toContain("文の途中にあるものは残してください");
    // 会話の中の口ごもりは、作者が書いた演技である
    expect(prompt).toContain("会話（「」の中）は取らないでください");
  });

  test("「なし」「空文字」を notes に書かせない", () => {
    // 指示の言葉が答えの中身として返ってくるのを、あらかじめ塞ぐ
    expect(prompt).toContain("空文字");
    expect(prompt).toContain("何も入れない（[]）");
  });

  test("作品の作法は、渡したときだけ入る", () => {
    const withStyle = buildDictationCleanPrompt({
      dictatedText: "きょうはいい天気",
      styleNote: "【この作品の書き方】\n- 語り手の一人称は「わたし」",
    });

    expect(withStyle).toContain("語り手の一人称は「わたし」");
    // 渡さないときに「（登録されていません）」を送っても、量が増えるだけ
    expect(prompt).not.toContain("登録されていません");
  });

  test("下書きの本文が入る", () => {
    expect(prompt).toContain("きょうはいい天気");
  });

  test("システムプロンプトが、書き直しを禁じている", () => {
    expect(DICTATION_CLEAN_SYSTEM_PROMPT).toContain("書き直してはいけません");
  });

  test("出力の形は text と notes の2つで、どちらも required", () => {
    expect(DICTATION_CLEAN_SCHEMA.required).toEqual(["text", "notes"]);
  });

  test("versionを持つ（キャッシュの鍵に入る）", () => {
    expect(DICTATION_CLEAN_VERSION).toBe("1.0");
  });
});

describe("整えた本文の読み取り", () => {
  test("コードフェンス付きでも読める", () => {
    const parsed = parseDictationCleanResult(
      '```json\n{"text":"整えた本文","notes":["直した"]}\n```'
    );

    expect(parsed?.text).toBe("整えた本文");
    expect(parsed?.notes).toEqual(["直した"]);
  });

  test("notes が無くても失敗にしない（添え物なので空にする）", () => {
    const parsed = parseDictationCleanResult('{"text":"整えた本文"}');

    expect(parsed?.text).toBe("整えた本文");
    expect(parsed?.notes).toEqual([]);
  });

  test("notes の中の文字列でないものは落とす", () => {
    const parsed = parseDictationCleanResult(
      '{"text":"本文","notes":["直した",3,"","  "]}'
    );

    expect(parsed?.notes).toEqual(["直した"]);
  });

  test("text が無ければ読み取り失敗", () => {
    expect(parseDictationCleanResult('{"notes":[]}')).toBeNull();
    expect(parseDictationCleanResult("これはJSONではない")).toBeNull();
    expect(parseDictationCleanResult("[]")).toBeNull();
  });
});

describe("整えた本文を、本文へ入れてよいかの検証", () => {
  /** 100字の下書き。比を数えやすい長さにする */
  const original = "あ".repeat(100);

  test("句読点と改行が入ったくらいの伸びは通す", () => {
    const checked = validateDictationClean(original, {
      text: "あ".repeat(110),
      notes: ["読点を入れました"],
    });

    expect(checked.ok).toBe(true);
    expect(checked.ok && checked.notes).toEqual(["読点を入れました"]);
  });

  test("空の本文は入れない（口述した分が丸ごと消える）", () => {
    const checked = validateDictationClean(original, { text: "   ", notes: [] });

    expect(checked.ok).toBe(false);
    expect(checked.ok === false && checked.reason).toContain("空");
  });

  test("要約されたものは入れない（下限の境目）", () => {
    // 下限ちょうどは通し、1字下回ったら止める
    const atLimit = Math.round(100 * DICTATION_MIN_LENGTH_RATIO);
    expect(
      validateDictationClean(original, { text: "あ".repeat(atLimit), notes: [] })
        .ok
    ).toBe(true);

    const tooShort = validateDictationClean(original, {
      text: "あ".repeat(atLimit - 1),
      notes: [],
    });
    expect(tooShort.ok).toBe(false);
    expect(tooShort.ok === false && tooShort.reason).toContain("短すぎます");
  });

  test("書き足されたものは入れない（上限の境目）", () => {
    const atLimit = Math.round(100 * DICTATION_MAX_LENGTH_RATIO);
    expect(
      validateDictationClean(original, { text: "あ".repeat(atLimit), notes: [] })
        .ok
    ).toBe(true);

    const tooLong = validateDictationClean(original, {
      text: "あ".repeat(atLimit + 1),
      notes: [],
    });
    expect(tooLong.ok).toBe(false);
    expect(tooLong.ok === false && tooLong.reason).toContain("長すぎます");
  });

  /**
   * 会話を「」でくくるのは正しい仕事なので、少しなら増えてよい。
   * **何十組も増えるのは、地の文を台詞に作り替えたということ。**
   */
  test("鍵括弧は少しなら増えてよい", () => {
    const spoken = "こんにちはと彼は言った。" + "あ".repeat(88);
    const quoted = "「こんにちは」と彼は言った。" + "あ".repeat(88);

    expect(validateDictationClean(spoken, { text: quoted, notes: [] }).ok).toBe(
      true
    );
  });

  /** 短い口述でも、会話がいくつか入ることはある（下限は3組） */
  test("許す組数は、短いときでも3組を下回らない", () => {
    expect(dictationQuoteAllowance(20)).toBe(3);
    expect(dictationQuoteAllowance(100)).toBe(3);
  });

  /**
   * **長さに比例させる**（本体の裁定、2026-09-06）。会話の多い場面を
   * まとめて口述すると、正しく整えただけで「」は何組も増える。
   * 固定の3組では、長い口述が必ず引っかかった。
   */
  test("許す組数は、長さに比例して増える（100字につき1組）", () => {
    expect(dictationQuoteAllowance(800)).toBe(8);

    const long = "あ".repeat(800);
    const eightPairs = "「あ」".repeat(8) + "あ".repeat(800 - 24);
    const ninePairs = "「あ」".repeat(9) + "あ".repeat(800 - 27);

    expect(
      validateDictationClean(long, { text: eightPairs, notes: [] }).ok
    ).toBe(true);
    expect(validateDictationClean(long, { text: ninePairs, notes: [] }).ok).toBe(
      false
    );
  });

  test("鍵括弧が増えすぎたら入れない", () => {
    // 100字の口述で許すのは3組。4組は多すぎる
    const quotes = "「あ」".repeat(dictationQuoteAllowance(100) + 1);
    const checked = validateDictationClean(original, {
      text: quotes + "あ".repeat(100 - quotes.length),
      notes: [],
    });

    expect(checked.ok).toBe(false);
    expect(checked.ok === false && checked.reason).toContain("鍵括弧");
    expect(checked.ok === false && checked.reason).toContain("4組");
  });

  test("元が空なら、比を取らずに断る（NaNを返さない）", () => {
    const checked = validateDictationClean("   ", { text: "本文", notes: [] });

    expect(checked.ok).toBe(false);
  });
});

/**
 * 送った時点の本文と違っていたら、置き換えない。
 *
 * AIの応答には数十秒かかり、口述モードのあいだも作者は打てる。
 * **ずれた範囲を置き換えると、口述していない部分まで巻き込む。**
 */
describe("本文への当て方", () => {
  test("照合と WorkspaceEdit を通している", () => {
    const source = readFileSync("src/features/dictationClean.ts", "utf8");

    // ファイルへ直に書かない（Ctrl+Z で戻せるのは文書の編集だから）
    expect(source).toContain("new vscode.WorkspaceEdit()");
    expect(source).not.toContain("atomicWriteFile");
    expect(source).not.toContain("writeTextFilePreservingFormat");
    // 送った時点と同じかを見てから当てる
    expect(source).toContain("now !== input.sentText");
    expect(source).toContain("本文が変わったので置き換えません");
    // 当たったかを確かめる（文書が閉じられていれば失敗しうる）
    expect(source).toContain("await vscode.workspace.applyEdit(change)");
  });

  test("確認は置き換える前に1回だけ", () => {
    const source = readFileSync("src/features/dictationClean.ts", "utf8");
    const confirms = source.split("confirmRun(").length - 1;

    expect(confirms).toBe(1);
  });

  test("機能別AI割当は推敲を借りる（キーを増やさない）", () => {
    const source = readFileSync("src/features/dictationClean.ts", "utf8");

    expect(source).toContain('ensureConfigured(registry, "proofread")');
  });

  /**
   * **「元に戻す」ボタンは、効く入口にだけ出す**（本体の裁定、2026-09-06）。
   * 原稿エディタはWebViewのパネルなので、通知のボタンを押した時点で
   * アクティブなテキストエディタが無く、`undo` コマンドが効かない。
   */
  test("原稿エディタからは、押しても効かないボタンを出さない", () => {
    const source = readFileSync("src/features/dictationClean.ts", "utf8");

    expect(source).toContain('entry === "manuscriptEditor"');
    expect(source).toContain("Ctrl+Z で元に戻せます");
    // 効く入口（普通のエディタ）にはボタンを出す
    expect(source).toContain('"元に戻す"');
    expect(source).toContain('executeCommand("undo")');
  });

  test("入口ごとに entry を渡している（写しの分岐を作らない）", () => {
    const extension = readFileSync("src/extension.ts", "utf8");

    expect(extension).toContain('entry: "manuscriptEditor"');
    expect(extension).toContain('entry: "editor"');
  });
});

describe("口述モードの画面（原稿エディタ）", () => {
  const html = readFileSync("src/views/manuscriptEditorHtml.ts", "utf8");

  test("下段に「口述」「整える」「やめる」がある", () => {
    expect(html).toContain('id="dictate"');
    expect(html).toContain('id="dictateClean"');
    expect(html).toContain('id="dictateCancel"');
  });

  test("「整える」「やめる」は、口述モードに入るまで出さない", () => {
    // 押す前から並べても、何を整えるのかがまだ決まっていない
    expect(html).toContain(".dictate-on { display: none; }");
    expect(html).toContain("body.dictating .dictate-on");
    expect(html).toContain("body.dictating #dictate { display: none; }");
  });

  test("OSの音声入力の始め方を、注記に出す", () => {
    expect(html).toContain("OSの音声入力を始めてください");
    expect(html).toContain("Win+H");
  });

  test("「やめる」は開始位置を捨てるだけで、本文へ送らない", () => {
    const cancel = html.slice(
      html.indexOf('dictateCancelButton.addEventListener("click"'),
      html.indexOf('dictateCleanButton.addEventListener("click"')
    );

    expect(cancel).toContain("dictationFrom = null");
    expect(cancel).not.toContain("postMessage");
  });

  test("「整える」は開始位置から現在のカーソルまでを送る", () => {
    expect(html).toContain(
      'vscode.postMessage({ type: "dictationClean", from: from, to: to })'
    );
    // カーソルが開始より前なら、文末までを範囲にする
    expect(html).toContain(
      "caret !== null && caret > from ? caret : dictationTextNow().length"
    );
  });

  /**
   * 組んで書く面（既定）では、ボタンを押した時点で選択が外れている。
   * 拾えないと、口述の開始位置がいつも文頭になる。
   */
  test("組んで書く面のために、押す直前のカーソルを拾う", () => {
    expect(html).toContain('dictateButton.addEventListener("mousedown"');
    expect(html).toContain('dictateCleanButton.addEventListener("mousedown"');
  });
});

describe("口述の整文の入口", () => {
  test("詳細メニューの「原稿づくり」にある（AIの印つき）", () => {
    const action = allActions().find((entry) => entry.command === COMMAND);

    expect(action, "詳細メニューに口述の整文がない").toBeTruthy();
    expect(action?.label).toBe("口述で入れた文を整える");
    expect(action?.usesAI).toBe(true);
    // 開いているファイルに対して働くので、作品の登録は要らない
    expect(action?.requiresWork).toBeFalsy();
  });

  test("package.json に登録され、タイプで隠さない", () => {
    const manifest = JSON.parse(
      readFileSync("package.json", "utf8")
    ) as { contributes: { commands: Array<{ command: string; title: string }> } };
    const declared = manifest.contributes.commands.find(
      (entry) => entry.command === COMMAND
    );

    expect(declared?.title).toBe("口述で入れた文を整える");
    // 声で書くことに、作品のタイプは関わらない
    expect(COMMAND_FEATURES[COMMAND]).toBe("allTypes");
  });

  test("原稿エディタの「整える」と、同じ関数を通す（入口2つ・実体1つ）", () => {
    const extension = readFileSync("src/extension.ts", "utf8");
    const calls = extension.split("runDictationClean(").length - 1;

    // 読み込み（import）と、2つの入口からの呼び出し
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(extension).toContain('registerCommand("novelai.dictationClean"');
    expect(extension).toContain("dictationClean: async (document, range)");
  });

  test("原稿エディタは、位置をLF空間から文書の位置へ直して渡す", () => {
    const editor = readFileSync("src/features/manuscriptEditor.ts", "utf8");

    expect(editor).toContain('case "dictationClean"');
    expect(editor).toContain("fromLfOffset(source, head)");
    expect(editor).toContain("fromLfOffset(source, tail)");
  });

  test("短すぎる範囲はAIを呼ばない", () => {
    const source = readFileSync("src/features/dictationClean.ts", "utf8");

    expect(DICTATION_MIN_CHARS).toBe(20);
    expect(source).toContain("< DICTATION_MIN_CHARS");
    expect(source).toContain('notifyDone("整える範囲がありません")');
  });
});

describe("相談へ渡す説明", () => {
  test("EXTRA_GUIDE に口述筆記の節がある", () => {
    expect(EXTRA_GUIDE).toContain("【口述筆記】");
    // 作者がいちばん知りたいのは、OS側の始め方である
    expect(EXTRA_GUIDE).toContain("Win+H");
    expect(EXTRA_GUIDE).toContain("fnキー");
    // 「マイクを使えますか」に、正しく答えられるようにする
    expect(EXTRA_GUIDE).toContain("拡張機能はマイクに触りません");
  });

  test("束として選べる（質問に当たったときだけ送る）", () => {
    const bundle = buildGuideBundles().find(
      (entry) => entry.key === "dictation"
    );

    expect(bundle, "口述筆記の束がない").toBeTruthy();
    expect(bundle?.label).toBe("口述筆記");
    expect(bundle?.text).toContain("【口述筆記】");
  });
});
