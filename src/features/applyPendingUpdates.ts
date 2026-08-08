import * as vscode from "vscode";
import { WorkEntry } from "../models/types";
import type { Character } from "../models/character";
import { CharacterStore, CharacterStoreError } from "../core/characterStore";
import { PendingUpdateStore, type PendingUpdate } from "../core/pendingUpdates";
import {
  diffCharacter,
  formatDiff,
  summarizeDiff,
  type CharacterDiff,
} from "../core/characterDiff";
import { logFailure } from "../core/logger";

/**
 * 抽出で作られた既存人物の更新案を、作者が確認して反映する。
 *
 * 自動では反映しない。抽出はAIの判断であり、作者が確定させた記述を
 * 黙って書き換えないというのがこのプロジェクトの約束である。
 * ただし1件ずつ承認させると19話ぶんで手が止まるので、
 * 中身を見たうえで「すべて反映」できるようにする。
 */

interface ReviewItem {
  update: PendingUpdate;
  current: Character;
  diff: CharacterDiff;
}

export async function applyPendingCharacterUpdates(
  work: WorkEntry
): Promise<void> {
  const pendingStore = new PendingUpdateStore(work);
  const characterStore = new CharacterStore(work);

  const pending = await pendingStore.loadAll();
  if (pending.errors.length > 0) {
    await vscode.window.showWarningMessage(
      `読み込めない更新案が ${pending.errors.length} 件あります（${pending.errors
        .map((error) => error.file)
        .join("、")}）。残りだけを扱います。`
    );
  }
  if (pending.updates.length === 0) {
    vscode.window.showInformationMessage("反映待ちの更新はありません。");
    return;
  }

  const loaded = await characterStore.loadAll();
  if (loaded.errors.length > 0) {
    await vscode.window.showErrorMessage(
      "読み込めない人物設定があるため、反映を中止しました。" +
        `（${loaded.errors.map((error) => error.file).join("、")}）`
    );
    return;
  }

  const byId = new Map(loaded.characters.map((c) => [c.id, c]));
  const items: ReviewItem[] = [];
  const orphaned: PendingUpdate[] = [];

  for (const update of pending.updates) {
    const current = byId.get(update.character.id);
    if (!current) {
      // 対象が消えている（まとめた・削除した）。反映しても復活させるだけ
      orphaned.push(update);
      continue;
    }
    const diff = diffCharacter(current, update.character);
    if (diff.changes.length === 0) {
      orphaned.push(update);
      continue;
    }
    items.push({ update, current, diff });
  }

  for (const stale of orphaned) {
    await pendingStore.discard(stale.filePath);
  }

  if (items.length === 0) {
    vscode.window.showInformationMessage(
      "反映が必要な更新はありませんでした。古い更新案は片付けました。"
    );
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `${items.length} 人の設定に更新があります。\n` +
      items
        .slice(0, 5)
        .map((item) => `・${item.diff.name}: ${summarizeDiff(item.diff)}`)
        .join("\n") +
      (items.length > 5 ? `\n…ほか ${items.length - 5} 人` : ""),
    { modal: true },
    "内容を確認",
    "すべて反映",
    "選んで反映"
  );

  if (choice === "内容を確認") {
    await showDiffDocument(items);
    return;
  }

  let targets: ReviewItem[];
  if (choice === "すべて反映") {
    targets = items;
  } else if (choice === "選んで反映") {
    const picked = await vscode.window.showQuickPick(
      items.map((item) => ({
        label: item.diff.name,
        description: summarizeDiff(item.diff),
        picked: true,
        item,
      })),
      {
        title: "反映する人物を選んでください",
        canPickMany: true,
        ignoreFocusOut: true,
      }
    );
    if (!picked || picked.length === 0) return;
    targets = picked.map((entry) => entry.item);
  } else {
    return;
  }

  await applyAll(targets, characterStore, pendingStore);
}

async function applyAll(
  targets: ReviewItem[],
  characterStore: CharacterStore,
  pendingStore: PendingUpdateStore
): Promise<void> {
  const applied: string[] = [];
  const failed: Array<{ name: string; message: string }> = [];

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "更新を反映しています" },
    async (progress) => {
      for (const [index, target] of targets.entries()) {
        progress.report({
          message: `${index + 1}/${targets.length} ${target.diff.name}`,
        });
        try {
          await characterStore.update(target.update.character);
          await pendingStore.discard(target.update.filePath);
          applied.push(target.diff.name);
        } catch (error) {
          // 1人の失敗で全体を止めない。何が反映できなかったかを最後にまとめて出す
          const message =
            error instanceof CharacterStoreError
              ? error.message
              : error instanceof Error
                ? error.message
                : String(error);
          logFailure("更新の反映に失敗", {
            人物: target.diff.name,
            詳細: message,
          });
          failed.push({ name: target.diff.name, message });
        }
      }
    }
  );

  if (failed.length === 0) {
    vscode.window.showInformationMessage(
      `${applied.length} 人の設定を更新しました。` +
        "「設定資料集を出力する」を実行すると一覧にも反映されます。"
    );
    return;
  }

  const action = await vscode.window.showWarningMessage(
    `${applied.length} 人を更新し、${failed.length} 人は反映できませんでした。` +
      "反映できなかった更新案は残してあります。",
    "詳細を表示"
  );
  if (action === "詳細を表示") {
    const document = await vscode.workspace.openTextDocument({
      content: failed
        .map((entry) => `${entry.name}: ${entry.message}`)
        .join("\n"),
      language: "text",
    });
    await vscode.window.showTextDocument(document);
  }
}

/** 何が変わるのかを読める形で出す。JSONを見比べさせない */
async function showDiffDocument(items: ReviewItem[]): Promise<void> {
  const content = [
    "# 反映待ちの更新",
    "",
    "この内容はまだ保存されていません。",
    "確認したら「同一人物をまとめる」の隣の「更新分を反映」から実行してください。",
    "",
    ...items.map((item) => formatDiff(item.diff)),
  ].join("\n");

  const document = await vscode.workspace.openTextDocument({
    content,
    language: "markdown",
  });
  await vscode.window.showTextDocument(document);
}
