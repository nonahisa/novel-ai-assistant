import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { characterFileName, type Character } from "../models/character";
import { CharacterStore } from "../core/characterStore";
import { PendingUpdateStore } from "../core/pendingUpdates";
import {
  describeRetractionDetail,
  describeRetractionRefusal,
  findEmptySeparatedCharacters,
} from "../core/characterSeparate";
import {
  readRetractionOffers,
  rememberRetractionOffers,
} from "../core/separationOfferStore";
import { logStep, useLogFile } from "../core/logger";

/**
 * 別人として分けた記録に、抽出のあとも中身が入らなかったとき、取り下げを
 * 持ちかける（作者の裁定、2026-10-03「取り下げを持ちかける」。設計書6.5.8）。
 *
 * 呼ぶのは抽出（`extractCharacters.ts`）が**全話を読み切って保存まで済んだ
 * あと**だけ。中止・失敗したチャンク・競合で外した話があるときは、
 * 「見つからなかった」と言い切れないので呼ばない。
 *
 * **押したときだけ取り下げる。** 取り下げは `CharacterStore.retire` で、
 * ファイルは消さずに回復用の場所へ移す（パネルの「取り下げ」と同じ道）。
 * 押す前に、ファイルと中身を見せる。
 *
 * **同じ記録には1回だけ訊く。** 「取り下げない」を選んだ記録に、抽出の
 * たびに同じことを訊かない（覚書は `core/separationOfferStore.ts`）。
 *
 * @param characters 抽出の前に読み込んだ人物（更新案に回らなかった人物は、
 *   いまも同じ中身である）
 * @param updatedIds 今回の抽出で更新案（承認待ち）に回った人物のID
 */
export async function offerSeparationRetraction(
  work: WorkEntry,
  characters: readonly Character[],
  updatedIds: ReadonlySet<string>
): Promise<void> {
  // 抽出の完了の知らせを待たずに走るので、書き先をここでも作品へ向け直す
  useLogFile(work.folderPath);
  const offered = await readRetractionOffers(work);
  // **前の抽出の更新案が残っている人物にも訊かない。** 反映すれば中身が入る
  let pendingIds: string[] = [];
  try {
    pendingIds = (await new PendingUpdateStore(work).loadAll()).updates.map(
      (update) => update.character.id
    );
  } catch (error) {
    // 承認待ちが読めないなら、中身が無いとは言い切れない。訊かずに終える
    logStep(
      "分けた記録の取り下げは訊きませんでした（承認待ちを読めませんでした: " +
        `${error instanceof Error ? error.message : String(error)}）。`
    );
    return;
  }
  const candidates = findEmptySeparatedCharacters(characters, {
    updatedIds: new Set([...updatedIds, ...pendingIds]),
    offered,
  });
  if (candidates.length === 0) return;

  // **先に覚える。** 訊いている途中で VS Code が閉じられても、次の抽出で
  // 同じ問いを繰り返さない（覚えそこねても、もう一度訊くだけで害は無い）
  await rememberRetractionOffers(
    work,
    offered,
    candidates.map((record) => ({ id: record.id, name: record.name }))
  );

  for (const record of candidates) {
    const RETRACT = "取り下げる";
    const answer = await vscode.window.showWarningMessage(
      `本文から「${record.name}」の中身が見つかりませんでした。この記録を取り下げますか？`,
      {
        modal: true,
        detail:
          describeRetractionDetail(record, characterFileName(record)) +
          "\n\nこの問いは、この記録には一度だけ出します。" +
          "取り下げないときは、設定資料パネルの「取り下げ」からいつでも取り下げられます。",
      },
      RETRACT
    );
    if (answer !== RETRACT) {
      logStep(`分けた記録「${record.name}」（${record.id}）の取り下げは見送られました。`);
      continue;
    }
    await retract(work, record);
  }
}

/**
 * 読み直して確かめてから取り下げる。
 *
 * **持ちかけてから押すまでのあいだに、記録が変わっていることがある**
 * （パネルで作者メモを書いた・承認待ちから中身が反映された）。そのときは
 * 消さずに断る（CLAUDE.md 規則2）。
 */
async function retract(work: WorkEntry, shown: Character): Promise<void> {
  const store = new CharacterStore(work);
  try {
    if ((await store.dirtyDocumentPaths()).length > 0) {
      void vscode.window.showWarningMessage(
        `未保存の人物設定があるので、「${shown.name}」は取り下げませんでした。` +
          "保存してから、設定資料パネルの「取り下げ」で取り下げてください。"
      );
      return;
    }
    const loaded = await store.loadAll();
    const current = loaded.characters.find((record) => record.id === shown.id);
    if (!current || current.name !== shown.name) {
      void vscode.window.showInformationMessage(
        `「${shown.name}」は、すでに一覧にありません。`
      );
      return;
    }
    const refusal = describeRetractionRefusal(current);
    const stillEmpty =
      findEmptySeparatedCharacters([current], {
        updatedIds: new Set(),
        offered: [],
      }).length > 0;
    const pending = (await new PendingUpdateStore(work).loadAll()).updates.some(
      (update) => update.character.id === current.id
    );
    if (refusal || !stillEmpty || pending) {
      const reason =
        refusal ??
        (pending ? "承認待ちの更新案があります" : "中身が入りました");
      logStep(`分けた記録「${current.name}」は取り下げませんでした（${reason}）。`);
      void vscode.window.showWarningMessage(
        `「${current.name}」は取り下げませんでした（${reason}）。`
      );
      return;
    }

    const recoveryPath = await store.retire(current.id);
    logStep(
      `分けた記録「${current.name}」（${current.id}）を取り下げました（中身が見つからなかったため）。` +
        `控え：${path.basename(recoveryPath)}`
    );
    void vscode.window.showInformationMessage(
      `「${current.name}」を取り下げました。実体は ${path.basename(recoveryPath)} として回復用の場所に残っています。`
    );
    // 設定資料パネルが開いていれば読み直す。開いたままだと、消えた人物を
    // 出し続ける（実機、2026-09-07）。パネル側から抽出を読む輪を作らない
    // よう、動的に読む
    const { findOpenSettingsPanel } = await import("./settingsPanel.js");
    await findOpenSettingsPanel(work.id)?.refreshFromDisk();
  } catch (error) {
    // **黙らない**（規則5）。消せなかったことと理由を出す
    const message = error instanceof Error ? error.message : String(error);
    logStep(`分けた記録「${shown.name}」を取り下げられませんでした: ${message}`);
    void vscode.window.showWarningMessage(
      `「${shown.name}」を取り下げられませんでした: ${message}`
    );
  }
}
