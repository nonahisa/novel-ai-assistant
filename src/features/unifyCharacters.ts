import * as vscode from "vscode";
import { WorkEntry } from "../models/types";
import type { Character } from "../models/character";
import { CharacterStore, CharacterStoreError } from "../core/characterStore";
import { findMergeCandidates, type MergeCandidate } from "../core/characterMerge";
import { unifyCharacters } from "../core/characterUnify";
import { logFailure } from "../core/logger";
import { cancelItem } from "../views/dialogs";

/**
 * 同一人物として登録されてしまった組を、作者の確認のうえで1件にまとめる。
 *
 * 自動では統合しない。別人をまとめると作者のデータを壊すことになり、
 * 取り消しも難しいため、どれをまとめるか・どちらの名前を残すかは必ず作者が決める。
 */

const REASON_LABELS: Record<MergeCandidate["reason"], string> = {
  same_name: "同じ呼び名が両方に登録されています",
  abbreviation: "省略形とみられます",
  suffix: "一方が他方の呼び方を含んでいます",
  name_part: "姓名と、名だけの呼び方とみられます",
  ambiguous: "統合先を決められませんでした",
};

export async function unifyCharacterRecords(work: WorkEntry): Promise<void> {
  const store = new CharacterStore(work);
  const loaded = await store.loadAll();

  if (loaded.errors.length > 0) {
    // 壊れたJSONがあるまま統合すると、読めていない人物を見落とす
    await vscode.window.showErrorMessage(
      "読み込めない設定ファイルがあるため、まとめる操作を中止しました。" +
        `（${loaded.errors.map((error) => error.file).join("、")}）`
    );
    return;
  }

  const candidates = findMergeCandidates(loaded.characters);
  if (candidates.length === 0) {
    vscode.window.showInformationMessage(
      "同一人物とみられる組は見つかりませんでした。"
    );
    return;
  }

  const byName = new Map(loaded.characters.map((c) => [c.name, c]));
  const picked = await vscode.window.showQuickPick(
    [
      ...candidates.map((candidate) => ({
        label: `${candidate.names[0]} ＋ ${candidate.names[1]}`,
        description: REASON_LABELS[candidate.reason],
        candidate,
      })),
      // Escでも閉じられるが、それを知らない人には出口が無いように見える
      cancelItem(),
    ],
    {
      title: "同一人物としてまとめる組を選んでください",
      ignoreFocusOut: true,
    }
  );
  if (!picked || !("candidate" in picked)) return;

  const first = byName.get(picked.candidate.names[0]);
  const second = byName.get(picked.candidate.names[1]);
  if (!first || !second) {
    await vscode.window.showErrorMessage(
      "対象の人物が見つかりませんでした。読み込み直してください。"
    );
    return;
  }

  const keepPick = await vscode.window.showQuickPick(
    [
      { label: first.name, description: describe(first), keep: first, absorb: second },
      { label: second.name, description: describe(second), keep: second, absorb: first },
      cancelItem(),
    ],
    {
      title: "残す名前を選んでください（もう一方は別名として残ります）",
      ignoreFocusOut: true,
    }
  );
  if (!keepPick || !("keep" in keepPick)) return;

  const { unified, retiredId } = unifyCharacters(keepPick.keep, keepPick.absorb);

  const confirm = await vscode.window.showWarningMessage(
    `「${keepPick.absorb.name}」を「${unified.name}」にまとめます。\n` +
      `別名: ${unified.aliases.join("、") || "なし"}\n` +
      "まとめた側のファイルは削除せず、回復用の場所へ移します。\n" +
      "以後この人物は抽出で上書きされなくなります。",
    "まとめる",
    "中止"
  );
  if (confirm !== "まとめる") return;

  // このプロジェクトは既存ファイルの上書きを行わない（atomicWrite の replaceGuarded は
  // 必ず失敗する）。そのため「残す側を退避 → 新しい内容を新規作成 → 取り下げ側を退避」
  // の順で進める。
  //
  // 順序はわざとこうしている。新規作成に失敗した時点で止まれば、
  // 取り下げ側のファイルは手つかずのまま残る。逆順にすると、
  // 作成に失敗したときに人物が2件とも退避先へ行ってしまう。
  let keepRecoveryPath: string;
  try {
    keepRecoveryPath = await store.retire(keepPick.keep.id);
  } catch (error) {
    await reportFailure("残す側のファイルを退避できませんでした", error);
    return;
  }

  try {
    await store.save(unified);
  } catch (error) {
    logFailure("まとめた人物の保存に失敗", { 詳細: messageOf(error) });
    await vscode.window.showErrorMessage(
      `まとめた内容を保存できませんでした。${messageOf(error)}\n` +
        `「${keepPick.keep.name}」の元ファイルは次の場所にあります。` +
        `手動で戻してください:\n${keepRecoveryPath}`,
      { modal: true }
    );
    return;
  }

  let absorbRecoveryPath: string;
  try {
    absorbRecoveryPath = await store.retire(retiredId);
  } catch (error) {
    // まとめた内容は保存済み。取り下げ側が残ると一覧に重複が出るが、
    // データは失われていない。何が起きたかだけ正確に伝える
    await reportFailure(
      `まとめた内容は保存しましたが、「${keepPick.absorb.name}」を取り下げられませんでした。` +
        "一覧に重複が残ります",
      error
    );
    return;
  }

  const action = await vscode.window.showInformationMessage(
    `「${unified.name}」にまとめました。` +
      "「設定資料集を出力」を実行すると一覧にも反映されます。",
    "退避先を開く"
  );
  if (action === "退避先を開く") {
    await vscode.commands.executeCommand(
      "revealFileInOS",
      vscode.Uri.file(absorbRecoveryPath)
    );
  }
}

async function reportFailure(context: string, error: unknown): Promise<void> {
  logFailure("人物のまとめ処理の失敗", {
    場面: context,
    詳細: messageOf(error),
  });
  await vscode.window.showErrorMessage(`${context}。${messageOf(error)}`);
}

function messageOf(error: unknown): string {
  if (error instanceof CharacterStoreError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/** どちらを残すか決める材料を出す */
function describe(character: Character): string {
  return [
    character.role ?? "",
    character.aliases.length > 0 ? `別名: ${character.aliases.join("、")}` : "",
    character.authorNotes.trim() ? "作者メモあり" : "",
  ]
    .filter((part) => part)
    .join(" / ");
}
