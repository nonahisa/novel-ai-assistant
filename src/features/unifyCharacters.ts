import { revealFolder } from "../views/openDocument";
import * as vscode from "vscode";
import { WorkEntry } from "../models/types";
import type { Character } from "../models/character";
import { CharacterStore } from "../core/characterStore";
import {
  describeMergeCandidate,
  findMergeCandidates,
} from "../core/characterMerge";
import { unifyCharacters } from "../core/characterUnify";
import {
  applyCharacterUnify,
  CharacterUnifyError,
  describeDecisionBlockedByLoadErrors,
  describeUnifyFailure,
} from "../core/characterPairDecision";
import { logFailure, useLogFile } from "../core/logger";
import { cancelItem } from "../views/dialogs";
import { confirmRun, whenNoticePicked } from "../views/notify";

/**
 * 同一人物として登録されてしまった組を、作者の確認のうえで1件にまとめる。
 *
 * 自動では統合しない。別人をまとめると作者のデータを壊すことになり、
 * 取り消しも難しいため、どれをまとめるか・どちらの名前を残すかは必ず作者が決める。
 */

export async function unifyCharacterRecords(work: WorkEntry): Promise<void> {
  // **この先の記録は、その作品のログファイルへ残す**（0.43.3 と同じ）。
  // 失敗をまとめる `reportFailure` は作品を受け取らないので、入口で向ける
  useLogFile(work.folderPath);
  const store = new CharacterStore(work);
  const loaded = await store.loadAll();

  const blocked = describeDecisionBlockedByLoadErrors(loaded.errors);
  if (blocked) {
    // 壊れたJSONがあるまま統合すると、読めていない人物を見落とす
    await vscode.window.showErrorMessage(blocked);
    return;
  }

  const candidates = findMergeCandidates(loaded.characters);
  if (candidates.length === 0) {
    vscode.window.showInformationMessage(
      "同一人物とみられる組は見つかりませんでした。"
    );
    return;
  }

  // **idで引き当てる。名前では組を特定できない。**
  // 「同じ呼び名が両方に登録されています」の候補は、まさに同名レコードの組
  // である（実データで「お母さん」が4件に分裂した）。名前のMapは同名を
  // 1件へ潰すので、first と second が同じレコードになり、
  // 「同じ人物どうしはまとめられません」で必ず失敗していた（0.22.9で修正）
  const byId = new Map(loaded.characters.map((c) => [c.id, c]));
  const picked = await vscode.window.showQuickPick(
    [
      // 同名の組（「お母さん ＋ お母さん」）は名前だけでは見分けが付かない。
      // idを添えて、どのレコードの組かが分かるようにする
      ...candidates.map((candidate) => ({
        label:
          candidate.names[0] === candidate.names[1]
            ? `${candidate.names[0]}（${candidate.ids[0]}） ＋ ${candidate.names[1]}（${candidate.ids[1]}）`
            : `${candidate.names[0]} ＋ ${candidate.names[1]}`,
        // **何が一致したのかを名指しで出す**（設計書6.5.9）。
        // 「同じ呼び名が両方に登録されています」だけでは、姓の共有なのか
        // 同一人物なのかを作者が見分けられなかった
        description: describeMergeCandidate(candidate),
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

  const first = byId.get(picked.candidate.ids[0]);
  const second = byId.get(picked.candidate.ids[1]);
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

  // ほかのレコードの名前を渡す。別人の名前を別名として引き継がないため
  const { unified, retiredId } = unifyCharacters(
    keepPick.keep,
    keepPick.absorb,
    loaded.characters
  );

  const confirmed = await confirmRun(
    `「${keepPick.absorb.name}」を「${unified.name}」にまとめます。\n` +
      `別名: ${unified.aliases.join("、") || "なし"}\n` +
      "まとめた側のファイルは削除せず、回復用の場所へ移します。\n" +
      "以後この人物は抽出で上書きされなくなります。",
    "まとめる",
    // **取り消しにくいので警告の顔で訊く**（0.35.4）。まとめた側のファイルは
    // 回復用の場所へ移るだけとはいえ、戻すのは手作業になる
    { kind: "warning" }
  );
  if (!confirmed) return;

  // 書く順番（残す側を退避 → 作る → 取り下げ側を退避）と失敗の文は core の1か所
  // （`applyCharacterUnify`）。設定資料パネルの候補の欄も同じものを通る
  let absorbRecoveryPath: string;
  try {
    ({ absorbRecoveryPath } = await applyCharacterUnify(
      store,
      keepPick.keep,
      keepPick.absorb,
      loaded.characters,
      // 確認の窓に出した別名と、書く別名を同じにする
      { unified, retiredId }
    ));
  } catch (error) {
    await reportUnifyFailure(error, keepPick.keep.name, keepPick.absorb.name);
    return;
  }

  // **「退避先を開く」が押されるのを待たない**（ノートPCの実機、
  // 2026-09-23。抽出の完了の知らせと同じ直し）。待つと、知らせを閉じる
  // まで「重複をまとめる」の「動いている」札を持ったままになる
  whenNoticePicked(
    vscode.window.showInformationMessage(
      `「${unified.name}」にまとめました。` +
        "「設定資料集出力」を実行すると一覧にも反映されます。",
      "退避先を開く"
    ),
    async (action) => {
      if (action === "退避先を開く") await revealFolder(absorbRecoveryPath);
    },
    { label: "人物のまとめ", workFolder: work.folderPath }
  );
}

/**
 * まとめるのに失敗したことを伝える。文は core（`describeUnifyFailure`）が組み、
 * 設定資料パネルと同じ言い方になる。記録はこれまでどおり作品のログへ残す
 */
export async function reportUnifyFailure(
  error: unknown,
  keepName: string,
  absorbName: string
): Promise<string> {
  if (!(error instanceof CharacterUnifyError)) {
    const detail = error instanceof Error ? error.message : String(error);
    logFailure("人物のまとめ処理の失敗", { 詳細: detail });
    await vscode.window.showErrorMessage(`まとめられませんでした。${detail}`);
    return `まとめられませんでした。${detail}`;
  }
  const { message, modal } = describeUnifyFailure(error, keepName, absorbName);
  logFailure(
    error.stage === "save_unified" ? "まとめた人物の保存に失敗" : "人物のまとめ処理の失敗",
    { 段: error.stage, 詳細: error.detail }
  );
  if (modal) {
    await vscode.window.showErrorMessage(message, { modal: true });
  } else {
    await vscode.window.showErrorMessage(message);
  }
  return message;
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
