import * as vscode from "vscode";
import * as path from "../core/paths";
import { AIWRITER_DIR, type WorkEntry } from "../models/types";
import { atomicWriteFile } from "../core/atomicWrite";
import { logFailure, useLogFile } from "../core/logger";
import {
  roleRenameOfferKey,
  type RoleRenameOffer,
} from "../core/plotCharacterSync";

/**
 * 「役名の人物を名前に直す案（主人公 → 相馬 誠）を、前に置いた」という覚え書き
 * （設計書6.4.9。作者の判断、2026-09-25「直す案を置く」）。
 *
 * ## なぜ「見送った記録」ではなく「置いた記録」なのか
 *
 * プロットからの反映は、plot.md に「主人公（相馬 誠）」とあり資料に
 * 「主人公」がいれば、直す案を承認待ちへ置く。作者がその案を見送ったあと、
 * 保存のたびに同じ案が積み直されると、しつこくて承認の画面が読まれなくなる。
 *
 * 承認待ちの「見送る」はファイルを消すだけで、**見送ったことはどこにも
 * 残らない**（退けた関係 `rejectedRelations` は関係にしか効かない）。見送る口は
 * 承認の画面・設定資料パネル・承認のときの片付けと複数あり、✕で名前の葉だけ
 * 落として採ることもできる。どの口で見送られても同じに扱えるよう、
 * **置いた側で覚える**：
 *
 * - 置いた組が承認待ちにある → 反映は、承認待ちの直す案と名前で当たる（置き直さない）
 * - 承認された → 資料に「相馬 誠」がいるので、名前で当たる
 * - 承認待ちにも無く、資料もまだ「主人公」のまま → **見送られた**と読み、置き直さない
 *
 * 作者が plot.md の名前を変えれば（「主人公（早瀬 陸）」）、別の組なので置く。
 *
 * **名前の候補（6.4.8）が置いた案もここへ記録する。** 候補から選んで置いた案を
 * 見送ったあとに plot.md を保存すると、反映の側が同じ案を置き直すため。
 *
 * `.aiwriter` に置くのは、台帳ではなく機械の覚え書きだから（`syncDigest.ts` と同じ）。
 * 消えても、見送った案がもう一度並ぶだけで済む。
 */

const STATE_FILE = "role-rename-offers.json";

/**
 * 覚えておく件数の上限。作品1つで役名の人物がこれほど並ぶことは無いが、
 * 名前を何度も書き換えると増え続けるので、古いほうから落とす
 */
const MAX_OFFERS = 200;

interface StoredOffer extends RoleRenameOffer {
  at: string;
}

function statePath(work: WorkEntry): string {
  return path.join(work.folderPath, AIWRITER_DIR, STATE_FILE);
}

async function readStored(work: WorkEntry): Promise<StoredOffer[]> {
  try {
    const bytes = await vscode.workspace.fs.readFile(path.toUri(statePath(work)));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const offers =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>).offers
        : undefined;
    if (!Array.isArray(offers)) return [];
    return offers.filter(
      (offer): offer is StoredOffer =>
        typeof offer === "object" &&
        offer !== null &&
        typeof (offer as Record<string, unknown>).id === "string" &&
        typeof (offer as Record<string, unknown>).from === "string" &&
        typeof (offer as Record<string, unknown>).to === "string"
    );
  } catch {
    // 覚え書きなので、無い・壊れているときは「まだ置いていない」と読む。
    // 壊れていても直さない（次の書き込みで作り直る）
    return [];
  }
}

/** 前に置いた組か、を引く道具（`buildPlotCharacterUpdates` の `renameOffered` に渡す） */
export async function readRoleRenameOffers(
  work: WorkEntry
): Promise<(offer: RoleRenameOffer) => boolean> {
  const keys = new Set((await readStored(work)).map(roleRenameOfferKey));
  return (offer) => keys.has(roleRenameOfferKey(offer));
}

/**
 * 置いた組を覚える。**承認待ちへ置けたあとに呼ぶ**（置けなかった案を
 * 「置いた」と覚えると、一度も作者の目に触れないまま出なくなる）。
 *
 * **書けなくても失敗にしない。** 案は置けており、次の保存で同じ案が
 * もう一度並ぶだけで済む。
 */
export async function recordRoleRenameOffers(
  work: WorkEntry,
  offers: readonly RoleRenameOffer[]
): Promise<void> {
  if (offers.length === 0) return;
  const target = statePath(work);
  try {
    const stored = await readStored(work);
    const now = new Date().toISOString();
    const known = new Set(stored.map(roleRenameOfferKey));
    for (const offer of offers) {
      const key = roleRenameOfferKey(offer);
      if (known.has(key)) continue;
      known.add(key);
      stored.push({ id: offer.id, from: offer.from, to: offer.to, at: now });
    }
    const kept = stored.slice(-MAX_OFFERS);
    await vscode.workspace.fs.createDirectory(path.toUri(path.dirname(target)));
    const body = `${JSON.stringify({ offers: kept, updatedAt: now }, null, 2)}\n`;
    // 機械の覚え書きなので上書きしてよい（作者の原稿ではない）
    await atomicWriteFile(target, new TextEncoder().encode(body));
  } catch (error) {
    // **記録の直前に書き先を向ける**（0.43.3 と同じ）
    useLogFile(work.folderPath);
    logFailure("名前を直す案の覚え書きを保存できませんでした", {
      作品: work.title,
      詳細: error instanceof Error ? error.message : String(error),
    });
  }
}
