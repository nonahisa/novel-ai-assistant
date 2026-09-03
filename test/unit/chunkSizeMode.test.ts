import { describe, expect, it, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CHUNK_SIZE_MODE_AUTO,
  CHUNK_SIZE_MODE_MANUAL,
  OUTPUT_RESPONSE_RATIO,
  OUTPUT_SAFETY_MARGIN,
  UNTUNED_CHUNK_CHARS,
  capMergeCharsByOutputTokens,
  capUntunedChunkChars,
  decideChunkSize,
  describeChunkScope,
  parseChunkSizeMode,
  resolveChunkChars,
  resolveMergeChars,
  type Chunk,
} from "../../src/core/chunker";
import { workspace } from "./support/vscodeStub";
import { readChunkSettings } from "../../src/features/chunkSettings";
import { saveModelTuning } from "../../src/core/modelTuning";

/**
 * チャンクの大きさの決め方（設計書6.23）。
 *
 * 作者の指示（2026-08-23）：「設定画面上に『モデルによって可変』を選べる
 * ようにし、それをデフォルトにしてください」。
 *
 * **既定は自動。** 131,072受けられるモデルへ2,000字ずつ送るのは、
 * 呼び出し回数の面でも指示の使い回しの面でも損である。
 */

describe("設定の言葉を読む", () => {
  it("既定は自動", () => {
    expect(parseChunkSizeMode(undefined)).toBe("auto");
    expect(parseChunkSizeMode(CHUNK_SIZE_MODE_AUTO)).toBe("auto");
  });

  it("「文字数を指定する」だけが手動", () => {
    expect(parseChunkSizeMode(CHUNK_SIZE_MODE_MANUAL)).toBe("manual");
  });

  /** 知らない値が入っていても止まらない。安全側（自動）へ落とす */
  it("知らない言葉は自動として扱う", () => {
    expect(parseChunkSizeMode("よくわからない値")).toBe("auto");
  });
});

describe("1チャンクの字数", () => {
  it("自動なら、モデルのコンテキスト長から決める", () => {
    const resolved = resolveChunkChars({
      mode: "auto",
      configured: 5000,
      contextWindow: 131072,
    });
    expect(resolved.chars).toBe(decideChunkSize(131072));
    expect(resolved.from).toBe("model");
  });

  /** **自動のときは、指定値を見ない。** 見ると「自動」の意味が無くなる */
  it("自動なら、字数の指定があっても使わない", () => {
    const resolved = resolveChunkChars({
      mode: "auto",
      configured: 321,
      contextWindow: 8192,
    });
    expect(resolved.chars).not.toBe(321);
  });

  it("手動なら、指定した字数を使う", () => {
    const resolved = resolveChunkChars({
      mode: "manual",
      configured: 321,
      contextWindow: 131072,
    });
    expect(resolved).toEqual({ chars: 321, from: "setting" });
  });

  /**
   * **「指定する」を選んだのに字数が空、は起こりうる。**
   * そこで止めるより、モデルから決めて進めるほうがよい。
   */
  it("手動なのに字数が無ければ、モデルから決め直す", () => {
    for (const configured of [undefined, 0, -1, 0.5]) {
      const resolved = resolveChunkChars({
        mode: "manual",
        configured,
        contextWindow: 8192,
      });
      expect(resolved.chars, String(configured)).toBe(decideChunkSize(8192));
      expect(resolved.from, String(configured)).toBe("fallback");
    }
  });

  it("小さいモデルでも下限を割らない", () => {
    expect(
      resolveChunkChars({ mode: "auto", configured: 0, contextWindow: 1024 })
        .chars
    ).toBeGreaterThanOrEqual(1500);
  });
});

describe("まとめて送るときの字数", () => {
  /** **モデルが受けられる量を使い切るのが、呼び出し回数をいちばん減らす** */
  it("自動なら、チャンクの大きさまで詰める", () => {
    expect(
      resolveMergeChars({ mode: "auto", configured: 6000, chunkChars: 20000 })
    ).toBe(20000);
  });

  it("手動なら、指定した字数を使う", () => {
    expect(
      resolveMergeChars({ mode: "manual", configured: 6000, chunkChars: 20000 })
    ).toBe(6000);
  });

  /** 分割の目安を超えて詰め込むと、そのチャンクが入り切らない */
  it("手動でも、チャンクより大きくはしない", () => {
    expect(
      resolveMergeChars({ mode: "manual", configured: 9000, chunkChars: 2000 })
    ).toBe(2000);
  });

  it("手動で0を指定すれば、まとめない", () => {
    expect(
      resolveMergeChars({ mode: "manual", configured: 0, chunkChars: 20000 })
    ).toBe(0);
  });
});

/**
 * **書ける量で、まとめ送信の上限をさらに絞る**（設計書6.65.14の2）。
 *
 * 作者の指摘（2026-09-03）「設定に入れないのはなぜでしょうか？
 * チューニングの意味がないように思う」を受け、書ける量の測定（6.61）を
 * まとめ送信の上限へ繋いだ。`min(従来の上限, 書ける量トークン × 安全率0.8
 * ÷ 応答率0.3)`。
 *
 * **応答率0.3は「入力1字あたり応答0.3トークン」の見込みそのもの**で、
 * 字とトークンをまたぐ換算（`TOKENS_PER_CHAR`）はこの式に含まない
 * ——含めると二重に換算してしまう（本体の裁定、2026-09-03）。
 */
describe("capMergeCharsByOutputTokens（純関数）", () => {
  it("台帳の実測が小さいモデルでは、上限を絞る（6,500トークン→約17,333字）", () => {
    const requested = 20000;
    const capped = capMergeCharsByOutputTokens(requested, 6500);

    expect(capped).toBeLessThan(requested);
    expect(capped).toBeGreaterThan(0);
    // 式をそのまま書き下して確かめる（定数が変わっても追随する）
    expect(capped).toBe(
      Math.floor((6500 * OUTPUT_SAFETY_MARGIN) / OUTPUT_RESPONSE_RATIO)
    );
    expect(capped).toBe(17333);
  });

  it("書ける量が十分大きければ、絞らない（従来の上限のまま）", () => {
    expect(capMergeCharsByOutputTokens(20000, 1_000_000)).toBe(20000);
  });

  it("台帳に実測が無ければ、従来どおり", () => {
    expect(capMergeCharsByOutputTokens(20000, undefined)).toBe(20000);
  });

  /** 0は「まとめない」という設定の意味を持つ特別な値であって、上限の字数ではない */
  it("『まとめない』（0）は、実測があっても絞らない", () => {
    expect(capMergeCharsByOutputTokens(0, 6500)).toBe(0);
  });
});

describe("readChunkSettings と台帳の繋ぎ込み", () => {
  afterEach(() => {
    // 既定へ戻す。他のテストファイルの `workspace` と共有の作り物なので、
    // 差し替えたままにすると後続のテストに影響する
    workspace.getConfiguration = () => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
    });
  });

  function installSettings(values: Record<string, unknown>): void {
    workspace.getConfiguration = () =>
      ({
        get: <T>(key: string, defaultValue?: T): T =>
          (key in values ? values[key] : defaultValue) as T,
        inspect: () => ({ workspaceValue: undefined }),
        update: async (key: string, value: unknown) => {
          values[key] = value;
        },
      }) as unknown as ReturnType<typeof workspace.getConfiguration>;
  }

  it("providerId/modelを渡すと、台帳の実測でmergeCharsが絞られる", async () => {
    installSettings({});
    // **読める量の実測（measuredChars）も一緒に持たせる。** 6.65.16の
    // 未チューニング安全既定はチャンク上限そのものを6,000字に抑えるので、
    // 読める量が未測定のままだとチャンクが先に縮み、この検査がmergeChars
    // の絞り込み（6.65.14）だけを見られなくなる。実際の作者のgemma4:12bは
    // 読める量・書ける量の両方が実測済みなので、この形が実態に合う
    await saveModelTuning("ollama", "gemma4:12b", {
      measuredOutputTokens: 6500,
      measuredChars: 60000,
    });

    const withoutTuning = readChunkSettings(262144);
    const withTuning = readChunkSettings(262144, undefined, {
      providerId: "ollama",
      model: "gemma4:12b",
    });

    expect(withTuning.mergeChars).toBeLessThan(withoutTuning.mergeChars);
    expect(withTuning.mergeCharsBeforeOutputCap).toBe(withoutTuning.mergeChars);
    // 絞られていないほうには、絞る前の値を持たせない
    expect(withoutTuning.mergeCharsBeforeOutputCap).toBeUndefined();
  });

  /** **渡さない呼び出し側の挙動は変えない。** 対応させるまでの逃げ道 */
  it("providerId/modelを渡さなければ、これまでどおり絞らない", async () => {
    installSettings({});
    await saveModelTuning("ollama", "gemma4:12b", {
      measuredOutputTokens: 6500,
    });

    const settings = readChunkSettings(262144);

    expect(settings.mergeCharsBeforeOutputCap).toBeUndefined();
  });

  it("台帳に実測が無いモデルを指定しても、絞らない", async () => {
    installSettings({});

    const settings = readChunkSettings(262144, undefined, {
      providerId: "ollama",
      model: "測っていないモデル",
    });

    expect(settings.mergeCharsBeforeOutputCap).toBeUndefined();
  });
});

/**
 * **未チューニングの安全既定**（設計書6.65.16の1）。
 *
 * 作者の依頼（2026-09-03）「非力なマシンのローカルLLMでも動く程度に」。
 * 従来の既定は「モデルの申告値を信じて自動的に広げる」で、131kを名乗る
 * 小型モデルでも初回から20,000字を送っていた。**読める量の実測
 * （`measuredChars`）が台帳に無いモデルだけ**、自動モードのチャンク上限を
 * 6,000字に抑える。実測があるモデル・手動モードは、これまでどおり
 * 最大20,000字まで広げる。
 */
describe("capUntunedChunkChars（純関数）", () => {
  it("実測が無ければ、6,000字に抑える", () => {
    expect(capUntunedChunkChars(20000, undefined)).toBe(UNTUNED_CHUNK_CHARS);
  });

  it("実測があれば、そのまま通す", () => {
    expect(capUntunedChunkChars(20000, 60000)).toBe(20000);
  });

  /** 6,000字よりもともと小さい値を、6,000字へ引き上げたりはしない */
  it("もともと6,000字未満なら、そのまま", () => {
    expect(capUntunedChunkChars(3000, undefined)).toBe(3000);
  });
});

describe("readChunkSettings と未チューニングの安全既定の繋ぎ込み", () => {
  afterEach(() => {
    workspace.getConfiguration = () => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
    });
  });

  function installSettings(values: Record<string, unknown>): void {
    workspace.getConfiguration = () =>
      ({
        get: <T>(key: string, defaultValue?: T): T =>
          (key in values ? values[key] : defaultValue) as T,
        inspect: () => ({ workspaceValue: undefined }),
        update: async (key: string, value: unknown) => {
          values[key] = value;
        },
      }) as unknown as ReturnType<typeof workspace.getConfiguration>;
  }

  it("自動モード＋未チューニングなら、6,000字に抑える", () => {
    installSettings({});

    const settings = readChunkSettings(262144, undefined, {
      providerId: "ollama",
      model: "測っていないモデル",
    });

    expect(settings.chunk.chars).toBe(UNTUNED_CHUNK_CHARS);
    expect(settings.chunkCharsBeforeUntunedCap).toBe(decideChunkSize(262144));
  });

  it("自動モード＋読める量の実測があれば、従来の導出のまま（最大20,000字）", async () => {
    installSettings({});
    await saveModelTuning("ollama", "gemma4:12b", { measuredChars: 90000 });

    const settings = readChunkSettings(262144, undefined, {
      providerId: "ollama",
      model: "gemma4:12b",
    });

    expect(settings.chunk.chars).toBe(decideChunkSize(262144));
    expect(settings.chunkCharsBeforeUntunedCap).toBeUndefined();
  });

  it("手動モードなら、未チューニングでも作者の指定した字数を尊重する", () => {
    installSettings({ chunkSizeMode: CHUNK_SIZE_MODE_MANUAL, chunkChars: 15000 });

    const settings = readChunkSettings(262144, undefined, {
      providerId: "ollama",
      model: "測っていないモデル",
    });

    expect(settings.chunk.chars).toBe(15000);
    expect(settings.chunkCharsBeforeUntunedCap).toBeUndefined();
  });

  /** 渡す側を1機能ずつ揃えるまでの逃げ道。挙動を変えない */
  it("outputTuningを渡さなければ、これまでどおり抑えない", () => {
    installSettings({});

    const settings = readChunkSettings(262144);

    expect(settings.chunk.chars).toBe(decideChunkSize(262144));
    expect(settings.chunkCharsBeforeUntunedCap).toBeUndefined();
  });
});

/**
 * **まとめたチャンクでは、話が1つとは限らない**（設計書6.23）。
 *
 * 矛盾検知はAIへ「いま見ているのは第何話か」を渡す。1つ目の話の名前だけを
 * 渡すと、2話目以降の本文を1話目だと言って読ませることになる。
 */
describe("まとめたチャンクが含む話", () => {
  function chunk(files: string[]): Chunk {
    return {
      filePath: files[0],
      index: 0,
      text: files.map(() => "本文").join("\n"),
      startLine: 0,
      chapterStart: null,
      chapterEnd: null,
      hash: "h",
      segments: files.map((filePath, index) => ({
        filePath,
        chapterStart: null,
        chapterEnd: null,
        start: index * 3,
        end: index * 3 + 2,
        startLine: 0,
      })),
    };
  }

  const label = (filePath: string) =>
    ({ "1.md": "第1話", "2.md": "第2話", "3.md": "第3話" })[filePath];

  it("1話だけなら、その話の名前", () => {
    expect(describeChunkScope(chunk(["1.md"]), label)).toBe("第1話");
  });

  /** 全部並べると、20話まとめたときに読めなくなる */
  it("複数なら、端どうしを繋ぐ", () => {
    expect(describeChunkScope(chunk(["1.md", "2.md", "3.md"]), label)).toBe(
      "第1話〜第3話"
    );
  });

  it("名前が引けなければ、何も言わない", () => {
    expect(describeChunkScope(chunk(["4.md"]), label)).toBe("");
  });

  it("同じ話が2回出ても、重ねて数えない", () => {
    // 1つのファイルが2つに割れているとき
    expect(describeChunkScope(chunk(["1.md", "1.md"]), label)).toBe("第1話");
  });
});

/**
 * **まとめ送信の決め方を、機能ごとに持たない**（設計書6.23・6.58）。
 *
 * `extractCharacters.ts` は `readChunkSettings` を呼びながら、その結果の
 * `mergeChars` を捨てて `mergeChunkChars`（既定6,000）を自前で読み直して
 * いた。そのため「モデルによって可変」を選んでいても**まとめ送信だけが
 * 6,000字で頭打ち**になり、チャンクの上限を上げても束ねる量が増えなかった
 * （作者の指摘、2026-09-01）。設定の説明文のほうは初めから
 * 「可変のときはモデルが受けられる量まで詰めます」と書いてあり、
 * **文書が正しくコードが古い**状態だった。
 */
describe("まとめ送信の決め方は1か所だけが持つ", () => {
  /** 設定を直接読んでよいのは、決め方を持つ `chunkSettings.ts` だけ */
  const ALLOWED = ["src/features/chunkSettings.ts"];

  it("mergeChunkChars を読むのは chunkSettings.ts だけ", () => {
    const root = path.join(__dirname, "..", "..");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const relative = path
          .relative(root, full)
          .split(path.sep)
          .join("/");
        if (ALLOWED.includes(relative)) continue;
        // コメントの中の言及は数えない（経緯を書き残すため）
        const code = fs
          .readFileSync(full, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/.*$/gm, "");
        if (code.includes("mergeChunkChars")) offenders.push(relative);
      }
    };
    walk(path.join(root, "src"));

    expect(offenders).toEqual([]);
  });
});

/**
 * **プロバイダの設定は、そのプロバイダが1か所で受ける**（設計書6.58）。
 *
 * `novelai.ollama.numCtx` は、誤字脱字・抽出・設定パネルの3か所が
 * それぞれ自前で読んでいた。**AIを呼ぶ17か所のうち、指定が効くのは
 * その3つだけ**で、推敲・矛盾検知・伏線・あらすじ・紹介文などでは
 * 効かなかった（作者の指摘、2026-09-01）。同じ設定が機能によって
 * 効いたり効かなかったりするのは、作者から見て理由が無い。
 */
describe("プロバイダの設定を、機能ごとに読まない", () => {
  const PROVIDER_SETTINGS: ReadonlyArray<{ key: string; owner: string }> = [
    { key: "ollama.numCtx", owner: "src/ai/ollamaProvider.ts" },
  ];

  it.each(PROVIDER_SETTINGS)(
    "$key を読むのは $owner だけ",
    ({ key, owner }) => {
      const root = path.join(__dirname, "..", "..");
      const offenders: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
            continue;
          }
          if (!entry.name.endsWith(".ts")) continue;
          const relative = path.relative(root, full).split(path.sep).join("/");
          if (relative === owner) continue;
          const code = fs
            .readFileSync(full, "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/.*$/gm, "");
          if (code.includes(`"${key}"`)) offenders.push(relative);
        }
      };
      walk(path.join(root, "src"));

      expect(offenders).toEqual([]);
    }
  );
});
