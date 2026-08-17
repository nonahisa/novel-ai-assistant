import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { KeepWordStore } from "../core/keepWordStore";
import { validateKeepWord, type KeepWord } from "../models/keepWord";
import { askText, cancelItem, isCancelItem } from "../views/dialogs";

/**
 * 「直さない語」を見る・足す・消す。
 *
 * 普段は指摘を見たその場で「今後直さない」を押すのが自然なので、
 * **この画面は見直しのためにある。** 前に守った語が多すぎて本物の誤字が
 * 出なくなっていないか、作者が確かめられるようにする。
 */
export async function manageKeepWords(work: WorkEntry): Promise<void> {
  const store = new KeepWordStore(work);

  for (;;) {
    let words: KeepWord[];
    try {
      words = (await store.load()).words;
    } catch (error) {
      void vscode.window.showErrorMessage(
        error instanceof Error ? error.message : String(error)
      );
      return;
    }

    const picked = await vscode.window.showQuickPick(
      [
        {
          label: "$(add) 語を足す",
          description: "方言・口癖・独自の言い回しなど",
          action: "add" as const,
        },
        ...words.map((entry) => ({
          label: `$(circle-slash) ${entry.word}`,
          description: entry.addedAt ? `${entry.addedAt} に登録` : "",
          detail: entry.note || undefined,
          action: "remove" as const,
          word: entry.word,
        })),
        cancelItem("閉じる"),
      ],
      {
        title: `${work.title}：直さない語（${words.length}件）`,
        placeHolder:
          words.length === 0
            ? "まだ1件もありません。方言や口癖を足すと、誤字脱字と推敲で指摘されなくなります"
            : "消したい語を選ぶか、足してください",
        ignoreFocusOut: true,
      }
    );

    if (!picked || isCancelItem(picked)) return;

    if ("action" in picked && picked.action === "add") {
      await addWord(store);
      continue;
    }

    if ("word" in picked && picked.word) {
      const yes = await vscode.window.showWarningMessage(
        `「${picked.word}」を一覧から消しますか。` +
          "以後、この語も誤字脱字・推敲の指摘の対象になります。",
        { modal: true },
        "消す"
      );
      if (yes === "消す") await store.remove(picked.word);
    }
  }
}

async function addWord(store: KeepWordStore): Promise<void> {
  const word = await askText({
    title: "直さない語を足す",
    prompt: "本文に出てくる形で書いてください（例：はよ、せやかて、あらへん）",
    placeHolder: "守りたい語",
    validateInput: (value) => validateKeepWord(value) ?? undefined,
  });
  if (!word) return;

  const note = await askText({
    title: `「${word.trim()}」を直さない理由`,
    prompt: "後から見直すときの手がかりです。空のままでも構いません",
    placeHolder: "例：関西弁、この人物の口癖",
  });

  try {
    const added = await store.add(word, note ?? "");
    void vscode.window.showInformationMessage(
      added
        ? `「${word.trim()}」を今後直しません。`
        : `「${word.trim()}」は既に登録されています。`
    );
  } catch (error) {
    void vscode.window.showErrorMessage(
      error instanceof Error ? error.message : String(error)
    );
  }
}
