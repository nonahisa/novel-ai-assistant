import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { TravelDistanceDismissedHistory } from "../../../src/core/pendingSettingsUpdates";
import { travelDistanceDismissKey } from "../../../src/core/travelCues";
import { restoreDismissedTravelDistances } from "../../../src/features/restoreDismissedTravelDistances";
import { emptyLocation, type Location } from "../../../src/models/location";
import type { WorkEntry } from "../../../src/models/types";
import { memoryFs } from "../support/memoryDisk";
import { window, workspace } from "../support/vscodeStub";

/**
 * 見送った距離を戻す（作者の裁定 2026-10-26「戻す操作をいま足す」。設計書6.88.13）。
 *
 * 提案パネルで場所の案を見送ると、距離の鍵が `.aiwriter/cache/travel_distance_dismissed.json`
 * に残り、次の事実の照合から同じ距離は出なくなる。場所の案は1件丸ごと見送るので、
 * 2件の距離のうち1件だけが誤りでも両方が止まる。それを一覧から選んで、記録から外す。
 * **外すのは記録だけ**——戻した距離は次の実行で、本文にあればまた提案される。
 */

const work: WorkEntry = {
  id: "work_test",
  title: "作品",
  folderPath: ["C:", "novels", "work"].join(path.sep),
  registeredAt: "2026-10-26T00:00:00.000Z",
};

const locations: Location[] = [
  emptyLocation("loc_0001", "王都"),
  emptyLocation("loc_0002", "港町"),
  emptyLocation("loc_0004", "北の砦"),
];
const HARBOR = travelDistanceDismissKey("loc_0001", "loc_0002", "馬で三日");
const FORT = travelDistanceDismissKey("loc_0001", "loc_0004", "馬で三日");

const disk = new Map<string, Uint8Array>();
let picked: Array<{ label: string; description?: string }> = [];
let shownItems: Array<{ label: string; description?: string }> = [];
let warnings: string[] = [];
let infos: string[] = [];
let confirmWith: string | undefined;

beforeEach(async () => {
  disk.clear();
  workspace.fs = memoryFs(disk);
  picked = [];
  shownItems = [];
  warnings = [];
  infos = [];
  confirmWith = "外す";
  window.showQuickPick = (async (items: unknown) => {
    shownItems = items as typeof shownItems;
    const chosen = shownItems.filter((item) => picked.some((want) => want.label === item.label));
    return chosen.length > 0 ? chosen : undefined;
  }) as never;
  window.showWarningMessage = (async (message: string) => {
    warnings.push(message);
    return confirmWith;
  }) as never;
  window.showInformationMessage = (async (message: string) => {
    infos.push(message);
    return undefined;
  }) as never;
  await new TravelDistanceDismissedHistory(work).add([HARBOR, FORT]);
});

const run = () => restoreDismissedTravelDistances(work, { loadLocations: async () => locations });

describe("見送った距離を戻す", () => {
  test("一覧に場所の名前と値で並び、選んだものだけを記録から外す", async () => {
    picked = [{ label: "王都 ↔ 港町" }];
    await run();

    expect(shownItems.map((item) => [item.label, item.description])).toEqual([
      ["王都 ↔ 港町", "馬で三日"],
      ["王都 ↔ 北の砦", "馬で三日"],
    ]);
    // 確認の文面に、戻すと何が起きるかを書く
    expect(warnings[0]).toContain("次の矛盾検知（事実の照合）");
    expect([...(await new TravelDistanceDismissedHistory(work).load())]).toEqual([FORT]);
    expect(infos.join("\n")).toContain("1件");
  });

  test("確認で押さずに閉じたら、何も外さない", async () => {
    picked = [{ label: "王都 ↔ 港町" }];
    confirmWith = undefined;
    await run();
    expect([...(await new TravelDistanceDismissedHistory(work).load())]).toEqual([HARBOR, FORT]);
  });

  test("見送った距離が無ければ、一覧を出さずにそう伝える", async () => {
    disk.clear();
    await run();
    expect(shownItems).toEqual([]);
    expect(infos.join("\n")).toContain("見送った距離はありません");
  });

  test("場所の記録から消えた場所は、id のまま並べる（黙って隠さない）", async () => {
    await restoreDismissedTravelDistances(work, {
      loadLocations: async () => locations.filter((location) => location.id !== "loc_0004"),
    });
    expect(shownItems.map((item) => item.label)).toContain("王都 ↔ loc_0004");
  });
});
