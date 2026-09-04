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
    // **既定では未抽出を0にする。** ここで数を出すと、
    // どの試験でも抽出の申し出が混ざって「何を確かめたか」がぼやける
    unextractedEpisodes: async () => 0,
    counts: () => ({ pendingUpdates: 0, mergeCandidates: 0 }),
    // **既定では感想を取りに行けないことにする。** ここで文面を返すと、
    // 既存の試験に「AIの感想」が混ざって、何を確かめたのかがぼやける
    requestComment: async () => undefined,
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

/**
 * 未抽出の話数の申し出（設計書6.21.1、2026-08-19）。
 *
 * **これまでは数えられず `undefined` を渡して黙らせていた。**
 * 数えられるようになったので、申し出るところまで通っているかを見る。
 */
describe("まだ取り込んでいない話の申し出", () => {
  test("たまっていれば申し出る", async () => {
    const posted: Chatter[] = [];
    const service = new ChatterService(
      deps({
        post: (chatter) => posted.push(chatter),
        // **お祝いは申し出より先に出る**ので、祝う状態にしない。
        // そうしないと、何を確かめたのかが分からない
        summary: async () => ({ today: "2026-08-16", written: 100, streak: 0 }),
        unextractedEpisodes: async () => 3,
      })
    );
    idle(service);

    await service.tick();

    expect(posted.map((c) => c.text).join("\n")).toContain("3話");
  });

  test("0話なら言わない", async () => {
    const posted: Chatter[] = [];
    const service = new ChatterService(
      deps({
        post: (chatter) => posted.push(chatter),
        unextractedEpisodes: async () => 0,
      })
    );
    idle(service);

    await service.tick();

    expect(posted.map((c) => c.text).join("\n")).not.toContain("取り込んでいない");
  });

  test("分からなければ言わない", async () => {
    // **0を渡すと「抽出済み」と言い切ることになる。**
    // 一度も抽出していない作品では undefined が返る
    const posted: Chatter[] = [];
    const service = new ChatterService(
      deps({
        post: (chatter) => posted.push(chatter),
        unextractedEpisodes: async () => undefined,
      })
    );
    idle(service);

    await service.tick();

    expect(posted.map((c) => c.text).join("\n")).not.toContain("取り込んでいない");
  });

  test("数えるのは毎回ではない", async () => {
    // **数えるには作品の走査が要る。** 1分ごとの様子見のたびに走らせると、
    // 書いている最中に無駄な読み取りが起きる
    let calls = 0;
    const service = new ChatterService(
      deps({
        unextractedEpisodes: async () => {
          calls++;
          return 0;
        },
      })
    );
    idle(service);

    await service.tick();
    await service.tick();
    await service.tick();

    expect(calls).toBe(1);
  });
});

/**
 * 本文を読んで言う一言（設計書6.21.4、P-34）。
 *
 * **AIを呼ぶのは「言ってよい」と決まってからだけである。** 黙る回にも
 * 呼びに行くと、10分ごとの様子見のたびに手元のAIを無駄に走らせる。
 * そして**失敗は画面に出さない**——独り言のエラー表示ほど邪魔なものはない。
 */
describe("本文の感想", () => {
  /** 感想以外に言うことが無い状態。祝いも申し出も出ない */
  function quiet(overrides: Partial<ChatterDeps> = {}) {
    return deps({
      summary: async () => ({ today: "2026-09-05", written: 100, streak: 0 }),
      ...overrides,
    });
  }

  /** 言えることを1つずつ吐き出させて、感想の番まで進める */
  async function tickUntilComment(service: ChatterService): Promise<void> {
    for (let round = 0; round < 5; round++) {
      idle(service);
      (service as unknown as { lastSpokeAt: number }).lastSpokeAt = 0;
      await service.tick();
    }
  }

  test("取りに行けたら、その文面を出す", async () => {
    const d = quiet({
      requestComment: async () => "戦闘の緊張感が伝わってきます。",
    });
    const service = new ChatterService(d);

    await tickUntilComment(service);

    expect(d.posted.map((c) => c.text)).toContain(
      "戦闘の緊張感が伝わってきます。"
    );
  });

  test("読ませるのは、直近に保存した本文", async () => {
    const asked: string[] = [];
    const service = new ChatterService(
      quiet({
        requestComment: async (_work, manuscriptPath) => {
          asked.push(manuscriptPath);
          return "静かな幕切れですね。";
        },
      })
    );

    await tickUntilComment(service);

    expect(asked).toEqual(["C:\\novels\\work\\001.txt"]);
  });

  test("有料のAIでは取りに行かない", async () => {
    // **頼まれていない発言で課金しない。** 感想でも例外にしない
    let calls = 0;
    const d = quiet({
      resolveAi: () => ({ paid: true }),
      requestComment: async () => {
        calls++;
        return "面白いですね。";
      },
    });
    const service = new ChatterService(d);

    await tickUntilComment(service);

    expect(calls).toBe(0);
    expect(d.posted).toHaveLength(0);
  });

  test("AIが仕事中なら取りに行かない", async () => {
    let calls = 0;
    const d = quiet({
      requestComment: async () => {
        calls++;
        return "面白いですね。";
      },
    });
    const service = new ChatterService(d);
    beginAiWork();

    await tickUntilComment(service);

    expect(calls).toBe(0);
    expect(d.posted).toHaveLength(0);
  });

  test("失敗しても、画面には何も出さない", async () => {
    const d = quiet({
      requestComment: async () => {
        throw new Error("繋がりません");
      },
    });
    const service = new ChatterService(d);

    await expect(tickUntilComment(service)).resolves.toBeUndefined();
    expect(d.posted.map((c) => c.kind)).not.toContain("manuscriptComment");
  });

  test("読めない答えは出さない", async () => {
    // 60字を超える答え・指示語のなぞりは、独り言として使えない
    const d = quiet({ requestComment: async () => "あ".repeat(61) });
    const service = new ChatterService(d);

    await tickUntilComment(service);

    expect(d.posted.map((c) => c.kind)).not.toContain("manuscriptComment");
  });

  test("同じ話へ2度取りに行かない", async () => {
    // 失敗した回も数える。**繋がらないAIへ10分おきに聞き直さない**
    let calls = 0;
    const service = new ChatterService(
      quiet({
        requestComment: async () => {
          calls++;
          throw new Error("繋がりません");
        },
      })
    );

    await tickUntilComment(service);

    expect(calls).toBe(1);
  });

  test("ほかに言うことがあるうちは取りに行かない", async () => {
    let calls = 0;
    const d = quiet({
      counts: () => ({ pendingUpdates: 3, mergeCandidates: 0 }),
      requestComment: async () => {
        calls++;
        return "面白いですね。";
      },
    });
    const service = new ChatterService(d);
    idle(service);

    await service.tick();

    expect(calls).toBe(0);
    expect(d.posted[0].kind).toBe("pendingUpdates");
  });
});
