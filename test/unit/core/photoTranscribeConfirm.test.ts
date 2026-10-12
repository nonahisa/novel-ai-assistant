import { describe, expect, test } from "vitest";
import { describePhotoSend } from "../../../src/core/photoTranscribeConfirm";

/**
 * 写真を送る前の確かめの文（設計書6.117.5）。
 *
 * 作者の裁定（2026-10-11）「写真を外のAI（クラウド）へ送る前に、必ず確かめる」。
 * 手元のAIなら外へ出ないことも書く。
 */
describe("写真を送る前の確かめ", () => {
  const base = {
    providerName: "Claude（クラウド・有料）",
    model: "claude-opus-5-5",
    pages: 3,
    photos: 3,
    isPaid: true,
  };

  test("クラウドへは、枚数とAIの名前と「外のサービスに渡ります」を出す", () => {
    const confirm = describePhotoSend({ ...base, providerId: "claude" });
    expect(confirm.message).toBe(
      "この写真 3枚を『Claude（クラウド・有料）（claude-opus-5-5）』へ送ります。"
    );
    expect(confirm.detail).toContain("写真は外のサービスに渡ります。");
    expect(confirm.detail).toContain("課金");
  });

  test("無料のクラウドでも外へ出ることは言う（課金の行は出さない）", () => {
    const confirm = describePhotoSend({
      ...base,
      providerId: "gemini",
      providerName: "Gemini（クラウド・無料枠あり）",
      model: "gemini-3-flash",
      isPaid: false,
    });
    expect(confirm.detail).toBe("写真は外のサービスに渡ります。");
  });

  test("VS Code 経由は、どこへ繋がるか分からないので外として扱う", () => {
    const confirm = describePhotoSend({ ...base, providerId: "vscode-lm", isPaid: false });
    expect(confirm.detail).toContain("外のサービスに渡ります");
  });

  test.each(["ollama", "lmstudio"])("手元のAI（%s）なら、外へ出ないことを書く", (providerId) => {
    const confirm = describePhotoSend({
      ...base,
      providerId,
      providerName: "Ollama（ローカル）",
      model: "gemma4:26b",
      isPaid: false,
    });
    expect(confirm.message).toBe("この写真 3枚を『Ollama（ローカル）（gemma4:26b）』で読みます。");
    expect(confirm.detail).toBe("写真はこのパソコンの外へは出ません。");
    expect(confirm.detail).not.toContain("外のサービス");
  });

  test("見開きを切って枚数とページ数が違えば、両方を出す", () => {
    const confirm = describePhotoSend({ ...base, providerId: "claude", pages: 5, photos: 3 });
    expect(confirm.message).toContain("この写真 5枚（写真 3枚を切り分けた 5ページ）");
  });
});

describe("作者からの頼みも、送る前に見せる（6.117.7）", () => {
  const base = {
    providerName: "Claude（クラウド・有料）",
    model: "claude-opus-5-5",
    pages: 1,
    photos: 1,
    isPaid: true,
  };

  test("クラウドへ送るとき、頼みの文を本文の末尾に出す（改行もそのまま）", () => {
    const confirm = describePhotoSend({ ...base, providerId: "claude", request: "旧字体はそのまま\nルビは（）に" });
    expect(confirm.detail).toBe(
      "写真は外のサービスに渡ります。\n呼び出すたびに課金されます。\n\nAIへの頼み（一緒に送ります）：\n旧字体はそのまま\nルビは（）に"
    );
  });

  test("手元のAIでも頼みを出す", () => {
    const confirm = describePhotoSend({ ...base, providerId: "ollama", isPaid: false, request: "旧字体はそのまま" });
    expect(confirm.detail).toBe("写真はこのパソコンの外へは出ません。\n\nAIへの頼み（一緒に送ります）：\n旧字体はそのまま");
  });

  test("頼みが空なら何も足さない", () => {
    const confirm = describePhotoSend({ ...base, providerId: "ollama", isPaid: false, request: "  " });
    expect(confirm.detail).toBe("写真はこのパソコンの外へは出ません。");
  });
});
