import * as fs from "node:fs";
import * as nodePath from "node:path";
import { sha256Text } from "../../core/hash";
import { normalizeForComparison } from "../../core/pathText";
import { randomUuid } from "../../core/runtime";

/**
 * MCP（Node の別プロセス）が既存のファイルを書き直すときの回復先（設計書5.4.1）。
 *
 * **製品の `atomicWrite.ts` の `createManagedRecoveryPath`・`pruneManagedRecoveries`
 * と同じ形にする**——あちらは `vscode` を引くので import できない。形を揃えて
 * おけば、製品の世代の整理が同じ控えとして数える（作品の側では1種類に見える）。
 *
 * `<置き場>/.novelai-recovery/<sha256(比べ方を揃えた道)>-<13桁の時刻>-<8桁の連番>-<uuid>.bak`
 *
 * 使うのは `novel.synopsis.commit`（設定資料）と `outbox.import`（本文、6.115）。
 */

/** 製品の `RECOVERY_DIRECTORY_NAME`（`atomicWrite.ts`）と同じ名前 */
export const RECOVERY_DIRECTORY = ".novelai-recovery";

/** 製品の `RECOVERY_GENERATIONS_PER_FILE` と同じ数 */
const GENERATIONS_PER_FILE = 5;

let recoverySequence = 0;

export function recoveryPathFor(target: string): string {
  recoverySequence += 1;
  const timestamp = String(Date.now()).padStart(13, "0");
  const sequence = String(recoverySequence).padStart(8, "0");
  return nodePath.join(
    nodePath.dirname(target),
    RECOVERY_DIRECTORY,
    `${recoveryKeyOf(target)}-${timestamp}-${sequence}-${randomUuid()}.bak`
  );
}

/**
 * 同じファイルの控えを、新しい5件だけ残す（製品の `pruneManagedRecoveries` と同じ決まり）。
 * **整理に失敗しても、済んだ書き込みを失敗にしない。**
 */
export function pruneRecoveries(target: string): void {
  const directory = nodePath.join(nodePath.dirname(target), RECOVERY_DIRECTORY);
  const pattern = new RegExp(
    `^${recoveryKeyOf(target)}-\\d{13}-\\d{8}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.bak$`,
    "i"
  );
  let names: string[];
  try {
    names = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return;
  }
  const obsolete = names
    .sort((left, right) => right.localeCompare(left))
    .slice(GENERATIONS_PER_FILE);
  for (const name of obsolete) {
    try {
      fs.unlinkSync(nodePath.join(directory, name));
    } catch {
      // 整理の失敗で、完了済みの保存を失敗扱いにしない
    }
  }
}

function recoveryKeyOf(target: string): string {
  return sha256Text(normalizeForComparison(target));
}
