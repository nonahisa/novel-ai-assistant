import type { WorkEntry } from "../models/types";
import type {
  PendingUpdate,
  PendingUpdateSource,
  PendingUpdateStore,
} from "../core/pendingUpdates";
import {
  buildNewCharacterRecords,
  inheritPendingCreationFields,
  type PlotCharacterPlan,
} from "../core/plotCharacterSync";
import { recordRoleRenameOffers } from "./roleRenameOffers";

/**
 * 突き合わせた結果（`buildPlotCharacterUpdates`）を、承認待ちへ積む。
 *
 * **プロットからの反映（設計書6.4.9）と相談からの反映（6.72）が同じものを
 * 使う。** 突き合わせの規則を1か所に置いても、積み方が2か所にあれば、
 * 「プロットからは直す案の理由が残るのに、相談からは消える」という
 * 食い違いが出る（0.87.4 までは相談の側が承認待ちを見ていなかった）。
 *
 * 台帳へは書かない。積むのは承認待ちだけで、資料が変わるのは作者が
 * 「更新分を反映」で承認したときだけ。
 */
export async function stageCharacterPlan(
  work: WorkEntry,
  store: PendingUpdateStore,
  plan: PlotCharacterPlan<PendingUpdate>,
  pending: readonly PendingUpdate[],
  source: PendingUpdateSource
): Promise<void> {
  // 出どころを添えて積む。AIが本文から読んだものと、作者が書いた文・
  // 相談で決めたこととでは、承認するときの見方が変わる
  if (plan.updates.length > 0) {
    await store.stage(plan.updates, { source });
  }

  // 承認待ちの案の上に重ねたものは、**元の案の出どころと理由を残す**。
  // 「プロットから」「相談から」で塗ると、名前の候補で置いた理由
  // （主人公 → 相馬 誠）が承認の画面から消える
  for (const overlay of plan.pendingOverlays) {
    await store.stage([overlay.character], {
      source: overlay.proposal.source,
      reason: overlay.proposal.reason,
    });
  }

  // 資料の役名の人物を、名前に直す案（作者の判断、2026-09-25「直す案を置く」）。
  // 積み方は名前の候補（`plotNameSuggest.ts` の `stageRename`）と同じ
  for (const rename of plan.renames) {
    const reason =
      `${source === "plot" ? "plot.md に書いた" : "決まった"}名前に直します` +
      `（${rename.from} → ${rename.to}）。元の役名は役割の欄へ移します。`;
    const previous = rename.base;
    await store.stage([rename.character], {
      // 先の案（抽出など）の上に重ねたときは、その出どころを引き継ぐ。
      // 出どころ無しを渡すと、`stage` が先の案のファイルから引き継ぐ
      source: previous ? previous.source : source,
      reason: previous?.reason ? `${previous.reason}／${reason}` : reason,
    });
  }
  // **置けたあとに覚える。** 作者が見送ったあと、保存のたびに同じ案を
  // 置き直さないため（`roleRenameOffers.ts`）
  await recordRoleRenameOffers(
    work,
    plan.renames.map((rename) => ({
      id: rename.character.id,
      from: rename.from,
      to: rename.to,
    }))
  );

  // 資料にまだ無い人は**新規の人物案**として積む。台帳へは書かない
  // ——承認したときに `applyPendingUpdates` が採番して作る
  if (plan.creations.length > 0) {
    // 名前の候補から選んで置いた案（設計書6.4.8）は読みを持つが、
    // plot.md も相談の拾い出しも読みを書かない。**積み直しで読みを消さない**
    await store.stage(
      inheritPendingCreationFields(
        buildNewCharacterRecords(plan.creations),
        pending
          .filter((entry) => entry.kind === "creation")
          .map((entry) => entry.character)
      ),
      { source, kind: "creation" }
    );
  }
}
