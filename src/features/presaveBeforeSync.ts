import * as vscode from "vscode";
import { fromUri } from "../core/paths";
import {
  isInsideAnyFolder,
  pickPresaveDocuments,
  type PresaveDocument,
  type PresaveFailure,
} from "../core/syncPresave";
import { settleOpenManuscripts } from "./manuscriptEditor";

/**
 * 「すべて同期」の記録の前の保存（設計書5.5.19。作者の裁定 2026-10-04）。
 *
 * どの文書を保存するかの判断は `core/syncPresave.ts` にある。ここは
 * VS Code の文書を読んで渡し、**VS Code の保存（`TextDocument.save()`）を
 * 呼ぶだけ**。新しい書き込みの道は作らない（実装ルール1）——原稿エディター
 * （設計書6.25）も普通のエディターと同じ文書の上で動くので、保存は同じ道を通る。
 */
export interface SyncPresave {
  /** 作品フォルダーの中で、まだ保存していない文書の数（確認の窓と、記録するかの判断に使う） */
  countUnsaved(folders: readonly string[]): number;
  /** 作品フォルダーの中の未保存を保存する。保存できなかったものを返す */
  saveInside(
    folders: readonly string[]
  ): Promise<{ saved: number; failures: PresaveFailure[] }>;
}

function documentFacts(): Array<PresaveDocument & { document: vscode.TextDocument }> {
  return vscode.workspace.textDocuments.map((document) => ({
    document,
    filePath: fromUri(document.uri),
    isDirty: document.isDirty,
    isUntitled: document.isUntitled,
    readText: () => document.getText(),
  }));
}

export function createSyncPresave(): SyncPresave {
  return {
    countUnsaved(folders) {
      // 競合の印の入った文書も数える。記録へ進ませ、保存の段で止めて理由を出す
      const picked = pickPresaveDocuments(documentFacts(), folders);
      return picked.save.length + picked.conflicted.length;
    },

    async saveInside(folders) {
      const failures: PresaveFailure[] = [];

      /*
        **先に、原稿エディターの画面から届いた便を当て終わるまで待つ。**
        画面の字は便で届いて文書へ当たる。当て終わる前に保存すると、
        最後に打った字が入る前の中身を保存する（［保存］が同じ理由で待っている。
        `core/manuscriptSave.ts`）
      */
      const unsettled = await settleOpenManuscripts((filePath) =>
        isInsideAnyFolder(folders, filePath)
      );
      for (const face of unsettled) {
        failures.push({ filePath: face.filePath, reason: face.result });
      }

      const facts = documentFacts();
      const picked = pickPresaveDocuments(facts, folders);
      for (const filePath of picked.conflicted) {
        failures.push({ filePath, reason: "conflict" });
      }

      let saved = 0;
      for (const filePath of picked.save) {
        const fact = facts.find((one) => one.filePath === filePath);
        if (!fact) continue;
        const document = fact.document;
        // 選んでから保存するまでに、自動保存が先に済ませていることがある
        if (!document.isDirty) continue;
        let ok = false;
        try {
          ok = await document.save();
        } catch {
          ok = false;
        }
        // VS Code は未変更の文書の保存に false を返す。保存済みなら失敗ではない
        if (ok || !document.isDirty) {
          saved += 1;
        } else {
          failures.push({ filePath, reason: "saveFailed" });
        }
      }
      return { saved, failures };
    },
  };
}
