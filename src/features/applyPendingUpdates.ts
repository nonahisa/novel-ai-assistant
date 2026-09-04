import * as vscode from "vscode";
import { WorkEntry } from "../models/types";
import {
  emptyCharacter,
  nextCharacterId,
  type Character,
} from "../models/character";
import { findCharactersByAppellation } from "../core/plotCharacterSync";
import { CharacterStore, CharacterStoreError } from "../core/characterStore";
import {
  PendingUpdateStore,
  pendingSourceLabel,
  type PendingUpdate,
} from "../core/pendingUpdates";
import {
  diffCharacter,
  diffLinesForPanel,
  formatDiff,
  summarizeDiff,
  type CharacterDiff,
} from "../core/characterDiff";
import { diffChars } from "../core/inlineDiff";
import { CustomFieldStore } from "../core/customFieldStore";
import { logFailure } from "../core/logger";
import { openGeneratedMarkdown } from "../views/openDocument";
import type { ProposalPanel } from "./proposalPanel";

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
  /** 更新前のレコード。**新規案には無い**（まだ台帳に居ない） */
  current: Character | undefined;
  diff: CharacterDiff;
}

/** その案が「新しく作る」ものか（設計書6.4.9） */
function isCreation(item: ReviewItem): boolean {
  return item.update.kind === "creation";
}

/**
 * 何が変わるかの要約に、出どころを添える（設計書6.4.9）。
 *
 * **AIが本文から読んだものと、作者がプロットへ書いたものは別物である。**
 * 同じ「紹介を変更」でも、承認するときの見方が変わる。
 */
function describeChange(item: ReviewItem): string {
  const label = pendingSourceLabel(item.update.source);
  const summary = isCreation(item) ? "新規の人物" : summarizeDiff(item.diff);
  return label ? `${label}：${summary}` : summary;
}

/**
 * 承認された1件を台帳へ入れる。
 *
 * **新規案のIDは、ここで採る。** 積んだ時点の番号を使うと、承認までの
 * あいだに別の操作（抽出・分割）が同じ番号を使っていることがある。
 * `known` には台帳の全員とこの操作で作ったぶんを入れておき、続けて
 * 承認したときに同じ番号を二度使わないようにする。
 *
 * **`save` を直に呼ばない。** `saveOrUpdate` は既知のIDなら退避つきの
 * 書き換え、未知なら新規作成へ振り分ける（`atomicWrite` の約束）。
 */
async function applyItem(
  item: ReviewItem,
  characterStore: CharacterStore,
  known: Character[]
): Promise<void> {
  if (!isCreation(item)) {
    await characterStore.saveOrUpdate(item.update.character);
    return;
  }
  const created: Character = {
    ...item.update.character,
    id: nextCharacterId(known),
  };
  await characterStore.saveOrUpdate(created);
  known.push(created);
}

export async function applyPendingCharacterUpdates(
  work: WorkEntry,
  /**
   * 提案パネル。**渡されたらそちらへ出す**（設計書5.6）。
   *
   * 作者への提案の窓口を1つにする。本文の直しは提案パネル、設定資料の
   * 更新は別のダイアログ、では**片方を見落とす。**
   */
  panel?: ProposalPanel
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

  // 作者が足した項目の変化も差分に出す。出さないと、
  // 気付かないうちに書き換わることになる
  const customFields = await new CustomFieldStore(work).loadFields();

  const byId = new Map(loaded.characters.map((c) => [c.id, c]));
  // 新規案の採番に使う。**承認するたびに増やす**（続けて承認したときに
  // 同じ番号を二度使わないため）
  const known: Character[] = [...loaded.characters];
  const items: ReviewItem[] = [];
  const orphaned: PendingUpdate[] = [];

  for (const update of pending.updates) {
    // **新規案は、居ないことの判定より先に分ける**（設計書6.4.9）。
    // 台帳に居ないのが当たり前なので、更新案の規則（居なければ片付ける）を
    // そのまま当てると、確認される前に必ず消える
    if (update.kind === "creation") {
      // 積んだあとに同じ名前の人物が資料へ増えていたら、作らない。
      // 二重に作ると、次の抽出で「同じかもしれません」と言われ続ける
      if (findCharactersByAppellation(loaded.characters, update.character.name).length > 0) {
        orphaned.push(update);
        continue;
      }
      items.push({
        update,
        current: undefined,
        // 何が入るのかを、更新案と同じ並びで見せる。
        // 比べる相手は空のレコード（すべてが「追加」になる）
        diff: diffCharacter(
          emptyCharacter(update.character.id, ""),
          update.character,
          customFields
        ),
      });
      continue;
    }

    const current = byId.get(update.character.id);
    if (!current) {
      // 対象が消えている（まとめた・削除した）。反映しても復活させるだけ
      orphaned.push(update);
      continue;
    }
    const diff = diffCharacter(current, update.character, customFields);
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

  // **提案の窓口を1つにする**（設計書5.6）。本文の直しは提案パネル、
  // 設定資料の更新は別のダイアログ、では作者が片方を見落とす
  if (panel) {
    panel.showRecordUpdates(
      work,
      items.map((item) => ({
        id: item.update.filePath,
        name: item.diff.name,
        // **何がどう変わるかを全部並べる。** 折り畳むと読まずに押される
        changes: diffLinesForPanel(item.diff),
        // 違うところだけを塗れるよう、項目ごとに分けても渡す
        changeParts: item.diff.changes.map((change) => {
          const before = change.before || "（未設定）";
          const after = change.after || "（未設定）";
          return {
            label: change.label,
            before,
            after,
            diff: diffChars(before, after),
          };
        }),
        source: describeChange(item),
        status: "pending" as const,
      })),
      async (id) => {
        const target = items.find((item) => item.update.filePath === id);
        if (!target) return { ok: false, reason: "対象が見つかりません。" };
        try {
          // 既存ファイルは上書きできないので saveOrUpdate を通す
          // （新規案はここでIDを採る。`applyItem` を参照）
          await applyItem(target, characterStore, known);
          await pendingStore.discard(target.update.filePath);
          return { ok: true };
        } catch (error) {
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
          return { ok: false, reason: message };
        }
      },
      // 見送る＝承認待ちから片付ける（レコードには触らない）。
      // これを渡していなかったころ、「見送る」は押しても黙って何も
      // 起きなかった（作者の報告、2026-08-28）
      async (id) => {
        const target = items.find((item) => item.update.filePath === id);
        if (!target) return { ok: false, reason: "対象が見つかりません。" };
        try {
          await pendingStore.discard(target.update.filePath);
          return { ok: true };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          logFailure("更新の見送りに失敗", {
            人物: target.diff.name,
            詳細: message,
          });
          return { ok: false, reason: message };
        }
      }
    );
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `${items.length} 人の設定に更新があります。\n` +
      items
        .slice(0, 5)
        .map((item) => `・${item.diff.name}: ${describeChange(item)}`)
        .join("\n") +
      (items.length > 5 ? `\n…ほか ${items.length - 5} 人` : ""),
    { modal: true },
    "内容を確認",
    "すべて反映",
    "選んで反映"
  );

  if (choice === "内容を確認") {
    await showDiffDocument(work, items);
    return;
  }

  let targets: ReviewItem[];
  if (choice === "すべて反映") {
    targets = items;
  } else if (choice === "選んで反映") {
    const picked = await vscode.window.showQuickPick(
      items.map((item) => ({
        label: item.diff.name,
        description: describeChange(item),
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

  await applyAll(targets, characterStore, pendingStore, known);
}

async function applyAll(
  targets: ReviewItem[],
  characterStore: CharacterStore,
  pendingStore: PendingUpdateStore,
  /** 採番に使う顔ぶれ。作ったぶんはここへ足される */
  known: Character[]
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
          await applyItem(target, characterStore, known);
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
        "「設定資料集を出力」を実行すると一覧にも反映されます。"
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
async function showDiffDocument(
  work: WorkEntry,
  items: ReviewItem[]
): Promise<void> {
  const content = [
    "# 反映待ちの更新",
    "",
    "この内容はまだ保存されていません。",
    "確認したら「重複をまとめる」の隣の「更新分を反映」から実行してください。",
    "",
    // 出どころは名前の見出しの直後に置く（設計書6.4.9）。
    // どこから来た提案かは、中身より先に知りたい
    ...items.map((item) => {
      const label = pendingSourceLabel(item.update.source);
      const body = formatDiff(item.diff);
      if (!label) return body;
      const [heading, ...rest] = body.split("\n");
      return [heading, "", `出どころ: ${label}`, ...rest].join("\n");
    }),
  ].join("\n");

  // **どの画面で読むかは作者が決める。** 前は開いた直後に
  // `markdown.showPreview` を呼んでプレビューへ切り替えていたが、
  // それは作者が既定にした画面（Markdown編集画面など）を押しのける。
  // 作者の報告「反映待ちの更新がデフォルトで開きません」（2026-08-27）。
  // 作品に属する読み物なので、作品の中へ置く（設計書6.17.7）
  await openGeneratedMarkdown(
    "反映待ちの更新",
    content,
    { preview: false },
    { work }
  );
}
