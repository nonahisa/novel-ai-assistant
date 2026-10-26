import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import type { Location } from "../models/location";
import { createLocationStore } from "../core/abilityStore";
import { TravelDistanceDismissedHistory } from "../core/pendingSettingsUpdates";
import { parseTravelDistanceDismissKey } from "../core/travelCues";
import { logFailure, useLogFile } from "../core/logger";

/**
 * 見送った距離を戻す（作者の裁定 2026-10-26「戻す操作をいま足す」。設計書6.88.13）。
 *
 * 提案パネルで場所の案を見送ると、その案の距離は覚えられ、次の事実の照合から
 * 提案も照合もされなくなる。場所の案は1件丸ごと見送るので、2件の距離のうち
 * 1件だけが誤りでも両方が止まる。ここで一覧から選んで、記録から外す。
 *
 * 人物の「退けた記録から外す」と同じ立場：**外すのは記録だけ**で、距離そのものを
 * 場所の記録へ書き戻しはしない。戻した距離は、次の実行で本文にあればまた提案される
 * （入れるかどうかは、そのとき承認の画面で作者が決める）。
 */
export async function restoreDismissedTravelDistances(
  work: WorkEntry,
  deps: { loadLocations?: (work: WorkEntry) => Promise<readonly Location[]> } = {}
): Promise<void> {
  const history = new TravelDistanceDismissedHistory(work);
  const keys = [...(await history.load())];
  if (keys.length === 0) {
    void vscode.window.showInformationMessage(
      "見送った距離はありません（提案パネルで場所の距離の案を見送ると、ここに並びます）。"
    );
    return;
  }

  const locations = await (deps.loadLocations ?? loadLocationsQuietly)(work);
  const nameOf = new Map(locations.map((location) => [location.id, location.name]));
  // 場所の記録から消えた場所も、id のまま並べる（黙って隠すと、外せない記録が残る）
  const items = keys.flatMap((key) => {
    const parsed = parseTravelDistanceDismissKey(key);
    if (!parsed) return [];
    const a = nameOf.get(parsed.aId) ?? parsed.aId;
    const b = nameOf.get(parsed.bId) ?? parsed.bId;
    return [{ label: `${a} ↔ ${b}`, description: parsed.value, key }];
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: "見送った距離の提案を戻す",
    placeHolder: "戻す距離を選んでください（次の矛盾検知〈事実の照合〉で、本文にあればまた提案されます）",
    canPickMany: true,
    ignoreFocusOut: true,
  });
  if (!picked || picked.length === 0) return;

  const confirm = "外す";
  const answer = await vscode.window.showWarningMessage(
    `見送った距離 ${picked.length}件を、見送りの記録から外します。` +
      "次の矛盾検知（事実の照合）で、本文にあればまた提案されます。場所の記録には書きません。",
    { modal: true },
    confirm
  );
  if (answer !== confirm) return;

  try {
    await history.remove(picked.map((item) => item.key));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    useLogFile(work.folderPath);
    logFailure("見送った距離を戻せませんでした", { 詳細: detail });
    void vscode.window.showErrorMessage(`見送った距離を戻せませんでした。${detail}`);
    return;
  }
  void vscode.window.showInformationMessage(
    `見送った距離 ${picked.length}件を戻しました。次の矛盾検知（事実の照合）で、本文にあればまた提案されます。`
  );
}

/** 場所を読む。読めなくても一覧は id のまま出せるので止めない（失敗はログへ） */
async function loadLocationsQuietly(work: WorkEntry): Promise<readonly Location[]> {
  try {
    const loaded = await createLocationStore(work).loadAll();
    return loaded.records;
  } catch (error) {
    useLogFile(work.folderPath);
    logFailure("見送った距離を戻す：場所の読み込み", {
      詳細: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
