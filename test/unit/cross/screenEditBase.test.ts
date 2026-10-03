import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { textFingerprint } from "../../../src/core/screenEditRebase";
import { buildManuscriptEditorHtml } from "../../../src/views/manuscriptEditorHtml";

/**
 * 便の元の本文を、画面と本体で取り違えない（設計書6.25.9。作者の裁定「塞ぐ」、
 * 2026-10-04）。
 *
 * 画面（`manuscriptEditorHtml.ts` のスクリプト）は元の本文の指紋を便に添え、
 * 本体（`core/screenEditRebase.ts`）は自分の控えた本文の指紋と突き合わせる。
 * **計算が1文字でもずれると、どの便も「元が分からない」に倒れ、打った字が
 * すべて控えの帯へ回る。** 2つの写しが同じ計算であることをここで見張る。
 */

const html = buildManuscriptEditorHtml("NONCE123", "vscode-resource:");
const code = html.slice(html.indexOf("<script"));

/** 画面のスクリプトから `function name(...) {...}` をまるごと切り出す */
function extractFunction(name: string): string {
  const start = code.indexOf(`function ${name}(`);
  expect(start, `${name} が画面に無い`).toBeGreaterThan(0);
  const end = code.indexOf("\n  }\n", start);
  expect(end, `${name} の終わりが見つからない`).toBeGreaterThan(start);
  return code.slice(start, end + 4);
}

describe("画面と本体の指紋", () => {
  const screenKey = new Function(
    `${extractFunction("textHash")}
    return (text) => textHash(text) + ":" + text.length;`
  )() as (text: string) => string;

  it.each([
    "",
    "あ",
    "前の字と《《強調》》と後ろの字。\n",
    "😀絵文字と𠮷（サロゲートペア）",
    "改行\nと\n\n空行",
  ])("「%s」の指紋が画面と本体で同じ", (text) => {
    expect(screenKey(text)).toBe(textFingerprint(text));
  });

  it("画面は指紋を本体と同じ形（ハッシュ:字数）で作る", () => {
    expect(extractFunction("setEditBase")).toContain('textHash(text) + ":" + text.length');
  });
});

describe("画面が元を進める所", () => {
  it("外からの本文で組み直したとき・同じだったときに、元をその本文にする（打つ面・組んで書く面）", () => {
    expect(extractFunction("takeIncoming")).toContain("setEditBase(text)");
    expect(extractFunction("composeTakeIncoming")).toContain("setEditBase(text)");
  });

  it("送ったら、元はいま送った本文になる", () => {
    const post = extractFunction("postEdit");
    expect(post).toContain("message.base = editBaseKey");
    expect(post.indexOf("vscode.postMessage(message)")).toBeLessThan(post.indexOf("setEditBase(text)"));
  });

  it("変換中に溜めて捨てた本文（取り込んでいない本文）では、元を進めない", () => {
    const start = code.indexOf('compose.addEventListener("compositionend"');
    const block = code.slice(start, code.indexOf("\n  });", start));
    expect(block).toContain("composePending = null");
    expect(block).not.toContain("setEditBase");
  });
});

describe("本体が元の本文を控える所", () => {
  const source = readFileSync("src/features/manuscriptEditor.ts", "utf8");

  it("画面へ送る本文は、送る前に控え帳へ入れる（待ちを挟まない）", () => {
    const start = source.indexOf("const send = async (): Promise<void> => {");
    const post = source.indexOf("await panel.webview.postMessage({", start);
    const body = source.slice(start, post);
    const read = body.indexOf("toLf(document.getText())");
    const remember = body.indexOf("ledger.rememberSent(text)");
    expect(remember).toBeGreaterThan(read);
    expect(body.slice(read, remember)).not.toContain("await ");
  });

  it("画面から届いた元の指紋を、順番待ちへ渡す", () => {
    const start = source.indexOf('case "edit":');
    const block = source.slice(start, source.indexOf("break;", start));
    expect(block).toContain("base: message.base");
  });
});
