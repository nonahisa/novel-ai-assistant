import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  ChatterService,
  QUIET_GAP_MS,
  type ChatterDeps,
} from "../../src/features/chatterService";
import { IDLE_THRESHOLD_MS, type Chatter } from "../../src/core/chatter";
import { beginAiWork, resetAiActivity } from "../../src/core/aiActivity";
import type { WorkEntry } from "../../src/models/types";
import { workspace } from "./support/vscodeStub";

/**
 * 独り言を「いつ言うか」。
 *
 * **黙るべきときに黙るかを重点的に見る。** とくに有料のAIで動かさないことは、
 * 作者に頼まれていない発言で課金しないための線であり、緩めてはならない。
 */
const work: WorkEntry = {
  id: "work_1",
  title: "作品",
  folderPath: "C:\\novels\\work",
  registeredAt: "2026-08-16T00:00:00.000Z",
};

const originalGetConfiguration = workspace.getConfiguration;

function deps(overrides: Partial<ChatterDeps> = {}): ChatterDeps & {
  posted: Chatter[];
} {
  const posted: Chatter[] = [];
  return {
    posted,
    resolveAi: () => ({ paid: false }),
    panelVisible: () => true,
    post: (chatter) => posted.push(chatter),
    // 目標を達成した状態にしておく。**何か言える状態が既定**にすることで、
    // 「黙った」ことが条件のせいだと言い切れる
    summary: async () => ({ today: "2026-08-16", written: 5_000, streak: 0 }),
    counts: () => ({ pendingUpdates: 0, mergeCandidates: 0 }),
    ...overrides,
  };
}

/** 手が止まっている状態にする */
function idle(service: ChatterService): void {
  service.noteEdit(work, "C:\\novels\\work\\001.txt");
  // 最後に保存した時刻を、無操作とみなされるところまで戻す
  (service as unknown as { lastEditAt: number }).lastEditAt =
    Date.now() - IDLE_THRESHOLD_MS - 1;
}

beforeEach(() => resetAiActivity());
afterEach(() => {
  workspace.getConfiguration = originalGetConfiguration;
});

describe("話しかけてよいとき", () => {
  test("Ollamaで、パネルが見えていて、手が空いていれば話す", async () => {
    const d = deps();
    const service = new ChatterService(d);
    idle(service);

    await service.tick();

    expect(d.posted).toHaveLength(1);
    expect(d.posted[0].text).toContain("5,000文字");
  });

  test("立て続けには喋らない", async () => {
    // 「同じことは言わない」だけでは足りない。言えることが3つたまっている日に、
    // 1分おきに順番に喋り出す。独り言は実況ではない
    const d = deps({
      counts: () => ({ pendingUpdates: 3, mergeCandidates: 2 }),
    });
    const service = new ChatterService(d);
    idle(service);

    await service.tick();
    await service.tick();
    await service.tick();

    expect(d.posted).toHaveLength(1);
  });

  test("間合いが空けば、次のことを言う", async () => {
    const d = deps({
      counts: () => ({ pendingUpdates: 3, mergeCandidates: 0 }),
    });
    const service = new ChatterService(d);
    idle(service);

    await service.tick();
    // 前に言った時刻を、間合いのぶん戻す
    (service as unknown as { lastSpokeAt: number }).lastSpokeAt =
      Date.now() - QUIET_GAP_MS - 1;
    idle(service);
    await service.tick();

    expect(d.posted).toHaveLength(2);
    expect(d.posted[0].key).not.toBe(d.posted[1].key);
  });

  test("何度間合いを空けても、同じことは言い直さない", async () => {
    // 言えることが尽きたら黙る。「1,000文字を超えました」を
    // 1日に何度も言う相棒は、ただの雑音になる
    const d = deps({
      counts: () => ({ pendingUpdates: 3, mergeCandidates: 2 }),
    });
    const service = new ChatterService(d);

    for (let round = 0; round < 10; round++) {
      idle(service);
      (service as unknown as { lastSpokeAt: number }).lastSpokeAt = 0;
      await service.tick();
    }

    const keys = d.posted.map((chatter) => chatter.key);
    expect(new Set(keys).size).toBe(keys.length);
    // 言えることは有限。10回まわしても、その数で止まる
    expect(keys.length).toBeLessThan(10);
  });
});

describe("黙るとき", () => {
  test("有料のAIでは話さない", async () => {
    // **頼まれていない発言で課金しない。** ここは緩めてはならない
    const d = deps({ resolveAi: () => ({ paid: true }) });
    const service = new ChatterService(d);
    idle(service);

    await service.tick();

    expect(d.posted).toHaveLength(0);
  });

  test("AIが未設定なら話さない", async () => {
    const d = deps({ resolveAi: () => undefined });
    const service = new ChatterService(d);
    idle(service);

    await service.tick();

    expect(d.posted).toHaveLength(0);
  });

  test("AIが仕事中なら話さない", async () => {
    // 抽出の最中に割り込むと、遅い機械では抽出そのものを遅くする
    const d = deps();
    const service = new ChatterService(d);
    idle(service);
    beginAiWork();

    await service.tick();

    expect(d.posted).toHaveLength(0);
  });

  test("パネルが見えていなければ話さない", async () => {
    // 見ていないところへ書き溜めても意味がない
    const d = deps({ panelVisible: () => false });
    const service = new ChatterService(d);
    idle(service);

    await service.tick();

    expect(d.posted).toHaveLength(0);
  });

  test("設定が切なら話さない", async () => {
    workspace.getConfiguration = () => ({
      get: <T>(key: string, defaultValue: T): T =>
        key === "chatter.enabled" ? (false as unknown as T) : defaultValue,
    });
    const d = deps();
    const service = new ChatterService(d);
    idle(service);

    await service.tick();

    expect(d.posted).toHaveLength(0);
  });

  test("まだ本文を保存していなければ話さない", async () => {
    // 誰について話しているのか言えない
    const d = deps();
    const service = new ChatterService(d);

    await service.tick();

    expect(d.posted).toHaveLength(0);
  });

  test("本文でないファイルの保存は、手を動かした印にしない", async () => {
    // 設定JSONの保存で「書いている」ことにはしない
    const d = deps();
    const service = new ChatterService(d);
    service.noteEdit(work, "C:\\novels\\work\\設定\\characters\\char_001.json");

    await service.tick();

    expect(d.posted).toHaveLength(0);
  });

  test("執筆量が読めなくても落ちない", async () => {
    const d = deps({ summary: async () => undefined });
    const service = new ChatterService(d);
    idle(service);

    await expect(service.tick()).resolves.toBeUndefined();
    expect(d.posted).toHaveLength(0);
  });

  test("執筆量の読み取りが失敗しても、執筆を止めない", async () => {
    const d = deps({
      summary: async () => {
        throw new Error("読めません");
      },
    });
    const service = new ChatterService(d);
    idle(service);

    await expect(service.tick()).resolves.toBeUndefined();
    expect(d.posted).toHaveLength(0);
  });
});

describe("手伝いの申し出", () => {
  test("承認待ちがあれば、押せる口を添えて申し出る", async () => {
    const d = deps({
      summary: async () => ({ today: "2026-08-16", written: 0, streak: 0 }),
      counts: () => ({ pendingUpdates: 3, mergeCandidates: 0 }),
    });
    const service = new ChatterService(d);
    idle(service);

    await service.tick();

    expect(d.posted[0].run?.kind).toBe("openSettingsPanel");
  });

  test("書いている最中は申し出ない", async () => {
    const d = deps({
      summary: async () => ({ today: "2026-08-16", written: 0, streak: 0 }),
      counts: () => ({ pendingUpdates: 3, mergeCandidates: 0 }),
    });
    const service = new ChatterService(d);
    // idle にせず、いま保存したばかりの状態にする
    service.noteEdit(work, "C:\\novels\\work\\001.txt");

    await service.tick();

    expect(d.posted).toHaveLength(0);
  });
});
