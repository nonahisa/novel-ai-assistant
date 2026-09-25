import { describe, expect, test } from "vitest";
import {
  GPU_BUSY_UTILIZATION_PERCENT,
  LOAD_CHECK_INTERVAL_MS,
  LOAD_WARNING_SNOOZE_MS,
  MANAGED_SEND_SETTLE_MS,
  SPLIT_GPU_BUSY_UTILIZATION_PERCENT,
  LoadCheckSchedule,
  externalLoadMessage,
  judgeExternalLoad,
  otherVramLimitMiB,
  parseNvidiaSmi,
  parseOllamaPs,
  probeExternalLoad,
  readOllamaPsWith,
  type GpuSample,
} from "../../../src/core/gpuLoad";

/**
 * 管理の外の負荷（設計書6.76.2）。閾値は 2026-09-25 に作者の機械
 * （RTX 4060 Ti 8GB）で実測した値から決めた。**実測の数字をそのまま**
 * 試験の入力にしている——何もしていないとき・Ollama の生成中・読み込み中。
 */

/** 実物の出力（依頼に貼られたもの） */
const REAL_LINE = "NVIDIA GeForce RTX 4060 Ti, 5412 MiB, 8188 MiB, 14 %";

function gpu(usedMiB: number, utilization: number): GpuSample {
  return {
    name: "NVIDIA GeForce RTX 4060 Ti",
    memoryUsedMiB: usedMiB,
    memoryTotalMiB: 8188,
    utilizationPercent: utilization,
  };
}

describe("nvidia-smi の出力の読み取り", () => {
  test("実物の1行を読む", () => {
    expect(parseNvidiaSmi(`${REAL_LINE}\r\n`)).toEqual([
      {
        name: "NVIDIA GeForce RTX 4060 Ti",
        memoryUsedMiB: 5412,
        memoryTotalMiB: 8188,
        utilizationPercent: 14,
      },
    ]);
  });

  test("単位なし（nounits）・複数枚・名前の「,」・読めない行", () => {
    const stdout = [
      "GPU A, 100, 1000, 5",
      "Weird, Name, 200, 2000, 50 %",
      "GPU C, [N/A], 8188 MiB, [Not Supported]",
      "",
    ].join("\n");
    const samples = parseNvidiaSmi(stdout);
    expect(samples).toHaveLength(2);
    expect(samples[0]).toMatchObject({ name: "GPU A", memoryUsedMiB: 100, utilizationPercent: 5 });
    expect(samples[1]).toMatchObject({ name: "Weird, Name", memoryTotalMiB: 2000 });
  });

  test("空・エラー文は何も返さない", () => {
    expect(parseNvidiaSmi("")).toEqual([]);
    expect(parseNvidiaSmi("NVIDIA-SMI has failed because it couldn't communicate")).toEqual([]);
  });
});

describe("Ollama の /api/ps の読み取り", () => {
  test("読み込み中のモデルと GPU に載せた量", () => {
    const models = parseOllamaPs({
      models: [
        { name: "gemma4:e4b", model: "gemma4:e4b", size: 3253731328, size_vram: 3253731328 },
        { model: "x:1b", size_vram: "壊れた値" },
      ],
    });
    expect(models).toEqual([
      { name: "gemma4:e4b", sizeBytes: 3253731328, sizeVramBytes: 3253731328 },
      { name: "x:1b", sizeVramBytes: 0 },
    ]);
    expect(parseOllamaPs({ models: [] })).toEqual([]);
    expect(parseOllamaPs({})).toBeUndefined();
    expect(parseOllamaPs("x")).toBeUndefined();
  });

  test("聞けなければ undefined（止めない）", async () => {
    const ok = await readOllamaPsWith(async () => ({
      ok: true,
      json: async () => ({ models: [{ name: "a", size_vram: 1 }] }),
    }));
    expect(ok).toEqual([{ name: "a", sizeVramBytes: 1 }]);
    expect(
      await readOllamaPsWith(async () => ({ ok: false, json: async () => ({}) }))
    ).toBeUndefined();
    expect(
      await readOllamaPsWith(async () => {
        throw new Error("繋がらない");
      })
    ).toBeUndefined();
  });
});

describe("管理の外の負荷とみなすか（実測の数字で）", () => {
  test("何もしていないとき（0%・1,032MiB）は騒がない。1回だけ跳ねた 20% でも騒がない", () => {
    const judgement = judgeExternalLoad({
      gpuSamples: [[gpu(1032, 0)], [gpu(1032, 20)], [gpu(1032, 0)]],
      ollamaModels: [],
      providerId: "ollama",
    });
    expect(judgement.external).toBe(false);
    expect(judgement.reasons).toEqual([]);
  });

  test("ほかの使い手が生成している（68〜97%）なら、使用率で気づく", () => {
    const judgement = judgeExternalLoad({
      gpuSamples: [[gpu(5358, 97)], [gpu(5660, 68)], [gpu(5676, 96)]],
      ollamaModels: [],
      providerId: "ollama",
    });
    expect(judgement.external).toBe(true);
    expect(judgement.reasons[0]).toBe("GPU の使用率が 96% です");
  });

  test("読み込み中（4,840MiB・/api/ps は空）はメモリで気づく", () => {
    const judgement = judgeExternalLoad({
      gpuSamples: [[gpu(4840, 0)], [gpu(4840, 4)], [gpu(4840, 20)]],
      ollamaModels: [],
      providerId: "ollama",
    });
    expect(judgement.external).toBe(true);
    expect(judgement.reasons).toEqual([
      "ほかのアプリが GPU のメモリを 4.7GB 使っています（全体 8.0GB）",
    ]);
  });

  test("2026-09-25 朝の形（5,412MiB・14%・Ollama は空）も気づく", () => {
    const [sample] = parseNvidiaSmi(REAL_LINE);
    const judgement = judgeExternalLoad({
      gpuSamples: [[sample], [sample], [sample]],
      ollamaModels: [],
      providerId: "ollama",
    });
    expect(judgement.external).toBe(true);
  });

  test("Ollama 自身が載せた分は「ほかのアプリ」から差し引く（前の実行の残り）", () => {
    // 実測：こちらが載せた gemma4:e4b（文脈16,384）が残っているだけのとき、
    // メモリ 5,261MiB に対し一覧の size_vram は 3,103MiB（実際より約1.1GB少ない）。
    // 差し引いた 2,158MiB を「ほかのアプリ」と読んで騒がないこと
    for (const [used, vram] of [
      [5261, 3103],
      [5149, 3063],
    ]) {
      const judgement = judgeExternalLoad({
        gpuSamples: [[gpu(used, 0)], [gpu(used, 0)], [gpu(used, 0)]],
        ollamaModels: [{ name: "gemma4:e4b", sizeVramBytes: vram * 1024 * 1024 }],
        providerId: "ollama",
      });
      expect(judgement.external, `${used}MiB`).toBe(false);
    }
  });

  test("札を取らない使い手が読み込んでいる途中は、一覧の申告が少なく「ほかのアプリ」に見える", () => {
    // 実測（2026-09-25、別の担当が gemma4:26b を回していたとき）：メモリ 7,630MiB、
    // 一覧は gemma4:26b の 881MiB だけ。差し引いても 6.7GB 残るので気づく。
    // **同じ日の午後に、これは読み込みの途中ではなく「GPU と CPU に分けて載せた
    // 26b が残っている」形だったと分かった**（下の「分けて載せたモデル」）。
    // ここでは応答に size が無い（分けたかを決められない）ときの今までの扱いを押さえる
    const judgement = judgeExternalLoad({
      gpuSamples: [[gpu(7630, 0)], [gpu(7630, 0)], [gpu(7630, 0)]],
      ollamaModels: [{ name: "gemma4:26b", sizeVramBytes: 881 * 1024 * 1024 }],
      providerId: "ollama",
    });
    expect(judgement.external).toBe(true);
  });

  test("LM Studio へ送るときはメモリの線を使わない（こちらが載せた分を差し引けない）", () => {
    const judgement = judgeExternalLoad({
      gpuSamples: [[gpu(6000, 0)], [gpu(6000, 0)], [gpu(6000, 0)]],
      ollamaModels: [],
      providerId: "lmstudio",
    });
    expect(judgement.external).toBe(false);
    expect(judgement.summary).toContain("LM Studio へ送るので見ない");
  });

  test("NVIDIA でなければ、Ollama の情報だけでは騒がない", () => {
    const judgement = judgeExternalLoad({
      gpuSamples: [],
      ollamaModels: [{ name: "other:7b", sizeVramBytes: 5e9 }],
      providerId: "ollama",
    });
    expect(judgement.external).toBe(false);
    expect(judgement.summary).toContain("nvidia-smi なし");
  });

  test("線そのもの：使用率50%、メモリは「全体の37.5%」と3GBの大きいほう", () => {
    expect(GPU_BUSY_UTILIZATION_PERCENT).toBe(50);
    expect(otherVramLimitMiB(8188)).toBe(3072);
    expect(otherVramLimitMiB(4096)).toBe(3072);
    expect(otherVramLimitMiB(24576)).toBe(9216);
  });

  test("警告の本文は理由と、心当たりの例を並べる", () => {
    const text = externalLoadMessage({
      external: true,
      reasons: ["GPU の使用率が 96% です"],
      summary: "",
    });
    expect(text).toContain("GPU の使用率が 96% です。");
    expect(text).toContain("LM Studio");
  });
});

describe("測り方（nvidia-smi は3回まで、無ければ1回で諦める）", () => {
  test("3回測って中央値で決める", async () => {
    let calls = 0;
    const outputs = [
      "G, 1032 MiB, 8188 MiB, 90 %",
      "G, 1032 MiB, 8188 MiB, 0 %",
      "G, 1032 MiB, 8188 MiB, 0 %",
    ];
    const result = await probeExternalLoad("ollama", {
      runNvidiaSmi: async () => outputs[calls++],
      readOllamaPs: async () => [],
      sleep: async () => undefined,
    });
    expect(calls).toBe(3);
    expect(result.nvidiaSmiFound).toBe(true);
    expect(result.external).toBe(false);
  });

  test("nvidia-smi が無ければ1回で諦める", async () => {
    let calls = 0;
    const result = await probeExternalLoad("ollama", {
      runNvidiaSmi: async () => {
        calls += 1;
        return undefined;
      },
      readOllamaPs: async () => {
        throw new Error("繋がらない");
      },
      sleep: async () => undefined,
    });
    expect(calls).toBe(1);
    expect(result.nvidiaSmiFound).toBe(false);
    expect(result.external).toBe(false);
    expect(result.summary).toContain("Ollama の読み込みは不明");
  });
});

describe("いつ見るか・警告をいつまで出さないか", () => {
  test("札を新しく取ったときと、一定の間隔ごとだけ見る（毎チャンクでは見ない）", () => {
    const schedule = new LoadCheckSchedule();
    expect(schedule.due(0, true)).toBe(true);
    schedule.checked(0);
    expect(schedule.due(1_000, false)).toBe(false);
    expect(schedule.due(LOAD_CHECK_INTERVAL_MS, false)).toBe(true);
    expect(schedule.due(1_000, true)).toBe(true);
  });

  test("［このまま送る］のあとは、その実行の間と数分は出さない", () => {
    const schedule = new LoadCheckSchedule();
    schedule.snooze(0);
    // 実行の間は、札を新しく取り直しても出さない（持ち続けているので取り直さないが念のため）
    expect(schedule.due(LOAD_WARNING_SNOOZE_MS * 3, true)).toBe(false);
    schedule.leaseDropped();
    // 実行が終わっても、数分のうちは出さない
    expect(schedule.due(LOAD_WARNING_SNOOZE_MS - 1, true)).toBe(false);
    expect(schedule.due(LOAD_WARNING_SNOOZE_MS, true)).toBe(true);
  });
});

describe("直前の管理下の送信の名残（設計書6.76.2、作者の判断 2026-09-25「直す」）", () => {
  /*
    実機（0.87.3 の担当の報告）：MCP の一括処理 A の2話目の頭で、直前の生成の名残の
    98%/98%/0% を読み、「管理外の負荷の疑い」を添えた。**札が空いた直後の使用率は、
    管理下の誰かが送り終えたばかりの名残である**。直前の送信から間もないときは、
    使用率の線を見ない
  */
  const AFTERGLOW = [[gpu(5288, 98)], [gpu(5288, 98)], [gpu(5288, 0)]];
  const OURS = [{ name: "gemma4:e4b", sizeVramBytes: 3063 * 1024 * 1024 }];

  test("直前の送信から間もない（0.8秒）ときは、使用率で警告しない", () => {
    const judgement = judgeExternalLoad({
      gpuSamples: AFTERGLOW,
      ollamaModels: OURS,
      providerId: "ollama",
      sinceManagedSendMs: 800,
    });
    expect(judgement.external).toBe(false);
    expect(judgement.reasons).toEqual([]);
    // ログには、見なかったことと、その理由（経過）を残す
    expect(judgement.summary).toContain("使用率の線は見ない");
    expect(judgement.summary).toContain("0.8秒");
  });

  test("十分に経ってからは、今までどおり使用率で警告する", () => {
    const judgement = judgeExternalLoad({
      gpuSamples: AFTERGLOW,
      ollamaModels: OURS,
      providerId: "ollama",
      sinceManagedSendMs: MANAGED_SEND_SETTLE_MS,
    });
    expect(judgement.external).toBe(true);
    expect(judgement.reasons).toEqual(["GPU の使用率が 98% です"]);
  });

  test("最後の送信が分からない（台帳が読めない・古い窓）ときは今までどおり", () => {
    const judgement = judgeExternalLoad({
      gpuSamples: AFTERGLOW,
      ollamaModels: OURS,
      providerId: "ollama",
    });
    expect(judgement.external).toBe(true);
  });

  test("間もなくても、メモリの線は今までどおり見る（Ollama の申告分を差し引いている）", () => {
    const judgement = judgeExternalLoad({
      gpuSamples: [[gpu(7630, 98)], [gpu(7630, 98)], [gpu(7630, 0)]],
      ollamaModels: [{ name: "gemma4:26b", sizeVramBytes: 881 * 1024 * 1024 }],
      providerId: "ollama",
      sinceManagedSendMs: 500,
    });
    expect(judgement.external).toBe(true);
    expect(judgement.reasons).toHaveLength(1);
    expect(judgement.reasons[0]).toContain("ほかのアプリが GPU のメモリ");
  });

  test("線そのもの：3秒（実測の最長 0.53秒に、nvidia-smi の標本の幅と測る0.6秒を足した余裕）", () => {
    expect(MANAGED_SEND_SETTLE_MS).toBe(3000);
  });

  test("測るとき、台帳の最後の送信の時刻から経過を出す。読めなければ今までどおり", async () => {
    const outputs = [
      "G, 5288 MiB, 8188 MiB, 98 %",
      "G, 5288 MiB, 8188 MiB, 98 %",
      "G, 5288 MiB, 8188 MiB, 0 %",
    ];
    const probe = (lastEnded: () => Promise<number | undefined>) => {
      let calls = 0;
      return probeExternalLoad("ollama", {
        runNvidiaSmi: async () => outputs[calls++],
        readOllamaPs: async () => OURS,
        sleep: async () => undefined,
        now: () => 1_000_800,
        lastManagedSendEndedMs: lastEnded,
      });
    };
    expect((await probe(async () => 1_000_000)).external).toBe(false);
    expect((await probe(async () => 1_000_800 - MANAGED_SEND_SETTLE_MS)).external).toBe(true);
    expect((await probe(async () => undefined)).external).toBe(true);
    expect(
      (
        await probe(async () => {
          throw new Error("読めない");
        })
      ).external
    ).toBe(true);
    // 時計のずれで「未来に送り終えた」と読めたら、終えた直後として扱う
    expect((await probe(async () => 1_002_000)).external).toBe(false);
  });
});

describe("Ollama が GPU と CPU に分けて載せたモデル（2026-09-25 午後の3巡目）", () => {
  /*
    実測（作者の機械 RTX 4060 Ti 8GB・Ollama 0.34.2）：gemma4:26b（ファイル 17.3GB）を
    文脈16,384 で載せると、GPU 全体は 1,148MiB → 7,723MiB に増えるのに、`/api/ps` は
    size 1,227,557,434・size_vram 902,960,248（約0.9GB）と答える。差の約6.7GB を
    「ほかのアプリ」と読んで、26b を使うたびに警告していた（18回中17回）。
    **size と size_vram の両方が実際より小さく、差し引きでは直せない**。
    分けて載せたモデルは、読み込むときに空いている GPU のメモリをほぼ埋めるので、
    そのあいだは使用量からほかのアプリの分を読めない
  */
  const GEMMA26B_SPLIT = {
    name: "gemma4:26b",
    sizeBytes: 1227557434,
    sizeVramBytes: 902960248,
  };

  test("26b が残っているだけ（7,723MiB・使用率 0%）では騒がない", () => {
    const judgement = judgeExternalLoad({
      gpuSamples: [[gpu(7723, 0)], [gpu(7723, 0)], [gpu(7723, 0)]],
      ollamaModels: [GEMMA26B_SPLIT],
      providerId: "ollama",
    });
    expect(judgement.external).toBe(false);
    expect(judgement.reasons).toEqual([]);
    // ログには、メモリの線を見なかったことと、その理由を残す
    expect(judgement.summary).toContain("GPU と CPU に分けて");
  });

  test("26b のあとに e4b を送る前の測定（まだ 26b が載っている）でも騒がない", () => {
    // 実測の3巡目のログ：7,565〜7,779MiB・gemma4:26b(0.8〜0.9GB)
    for (const used of [7565, 7632, 7779]) {
      const judgement = judgeExternalLoad({
        gpuSamples: [[gpu(used, 2)], [gpu(used, 0)], [gpu(used, 0)]],
        ollamaModels: [GEMMA26B_SPLIT],
        providerId: "ollama",
      });
      expect(judgement.external, `${used}MiB`).toBe(false);
    }
  });

  test("分けて載せていても、使用率の線は今までどおり見る（ほかの使い手が生成している）", () => {
    const judgement = judgeExternalLoad({
      gpuSamples: [[gpu(7723, 97)], [gpu(7723, 96)], [gpu(7723, 90)]],
      ollamaModels: [GEMMA26B_SPLIT],
      providerId: "ollama",
    });
    expect(judgement.external).toBe(true);
    expect(judgement.reasons).toEqual(["GPU の使用率が 96% です"]);
  });

  test("GPU にすべて載ったモデル（size と size_vram が同じ）なら、メモリの線は今までどおり", () => {
    // 実測：gemma4:e4b は size と size_vram が同じ 3,254,161,242（5,393MiB のとき）。
    // そこへほかのアプリが 3GB 以上を足していれば気づく
    const judgement = judgeExternalLoad({
      gpuSamples: [[gpu(8100, 0)], [gpu(8100, 0)], [gpu(8100, 0)]],
      ollamaModels: [
        { name: "gemma4:e4b", sizeBytes: 3254161242, sizeVramBytes: 3254161242 },
      ],
      providerId: "ollama",
    });
    expect(judgement.external).toBe(true);
    expect(judgement.reasons[0]).toContain("ほかのアプリが GPU のメモリ");
  });

  test("/api/ps の size も読む（分けて載せたかの判定に使う）", () => {
    expect(
      parseOllamaPs({
        models: [
          { name: "gemma4:26b", size: 1227557434, size_vram: 902960248 },
          { name: "old", size_vram: 5 },
        ],
      })
    ).toEqual([GEMMA26B_SPLIT, { name: "old", sizeVramBytes: 5 }]);
  });
});

describe("分けて載せたモデルがあるときの使用率の線（作者の裁定 2026-09-26 深夜）", () => {
  /*
    **再現**：26b を GPU と CPU に分けて載せていると、GPU は CPU の計算を待つ
    あいだ遊ぶので、ほかの使い手が 26b で生成していても使用率は 34〜53% にしか
    ならない（2026-09-25 の実測。作者の機械 RTX 4060 Ti 8GB）。0.89.3 で分けて
    載せたときはメモリの線を見なくしたので、残る手がかりは使用率だけなのに、
    線が50%のままでは3回のうち2回（中央値 34%・38%）を見逃していた。
    分けて載せたモデルがあるときだけ、線を25%に下げる
  */
  const GEMMA26B_SPLIT = {
    name: "gemma4:26b",
    sizeBytes: 1227557434,
    sizeVramBytes: 902960248,
  };
  const judge = (utilizations: number[], sinceManagedSendMs?: number) =>
    judgeExternalLoad({
      gpuSamples: utilizations.map((value) => [gpu(7648, value)]),
      ollamaModels: [GEMMA26B_SPLIT],
      providerId: "ollama",
      ...(sinceManagedSendMs !== undefined ? { sinceManagedSendMs } : {}),
    });

  test("ほかの使い手の 26b の生成（実測の3回：中央値 34%・38%・53%）を、3回とも拾う", () => {
    for (const samples of [
      [49, 34, 34],
      [43, 37, 38],
      [100, 38, 53],
    ]) {
      const judgement = judge(samples);
      expect(judgement.external, samples.join("/")).toBe(true);
      expect(judgement.reasons[0]).toContain("GPU の使用率");
    }
  });

  test("26b が載っているだけ（実測の待機：中央値 0〜8%、1回の跳ね 12%）では騒がない", () => {
    for (const samples of [
      [0, 0, 0],
      [1, 3, 3],
      [0, 1, 0],
      [8, 8, 12],
      [1, 1, 1],
    ]) {
      expect(judge(samples).external, samples.join("/")).toBe(false);
    }
  });

  test("直前の送信の名残は、下げた線でも見ない（送り終えて3秒）", () => {
    expect(judge([49, 34, 34], 800).external).toBe(false);
    expect(judge([49, 34, 34], MANAGED_SEND_SETTLE_MS).external).toBe(true);
  });

  test("分けて載せたモデルが無ければ、線は50%のまま（読み込み中の 20% 台で騒がない）", () => {
    const judgement = judgeExternalLoad({
      gpuSamples: [[gpu(5283, 26)], [gpu(5283, 20)], [gpu(5283, 34)]],
      ollamaModels: [
        { name: "gemma4:e4b", sizeBytes: 3254161242, sizeVramBytes: 3254161242 },
      ],
      providerId: "ollama",
    });
    expect(judgement.reasons.some((reason) => reason.includes("使用率"))).toBe(false);
  });

  test("ログには下げた線と、その理由を残す", () => {
    const summary = judge([43, 37, 38]).summary;
    expect(summary).toContain(`線 ${SPLIT_GPU_BUSY_UTILIZATION_PERCENT}%`);
    expect(summary).toContain("分けて載せているので下げた");
  });

  test("線そのもの：25%（待機の最大 8%・読み込み中の最大 20% より上、生成の最小 34% より下）", () => {
    expect(SPLIT_GPU_BUSY_UTILIZATION_PERCENT).toBe(25);
    expect(GPU_BUSY_UTILIZATION_PERCENT).toBe(50);
  });
});
