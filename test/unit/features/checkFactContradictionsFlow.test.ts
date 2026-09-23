import { beforeEach, describe, expect, test, vi } from "vitest";
import { window } from "./support/vscodeStub";
import type { AIRegistry } from "../../src/ai/registry";
import type { WorkEntry } from "../../src/models/types";

/**
 * 矛盾検知（事実の照合。設計書6.88の第4段）を、入口から1回通す。
 *
 * **単体テストが通っても実データで動かない**のが、この作品で繰り返し
 * 起きた失敗である。ここで確かめるのは「端から端までの配線」——
 * 抽出のプロンプトを呼び、検算を通し、機械照合が候補を出し、
 * その候補だけを判定のAIへ渡し、提案パネルの形になるところまでである。
 * AIは偽物で、返す JSON はテストが決める。
 *
 * **判定は `contradiction` の割当で呼ぶ**（抽出は `factExtract`）。
 * 2つが別々に引かれていることも、ここで見る。
 */

const state = vi.hoisted(() => ({
  /** `ensureConfigured` が引かれた機能キーの並び */
  features: [] as string[],
  /** AIへ送った内容（機能名つき） */
  sent: [] as Array<{ feature: string; userPrompt: string }>,
  /** 事実の抽出の応答（JSON文字列） */
  extractResponse: "",
  /** 判定の応答（JSON文字列） */
  verifyResponse: "",
  logged: [] as string[],
  /** 走査が返す話。合本の試験では1件で全話を指す */
  episodes: [] as Array<{
    filePath: string;
    fileName: string;
    chapterStart: number | null;
    chapterEnd: number | null;
  }>,
  /** 読み込みが返す本文 */
  source: "",
  /**
   * 抽出の応答を、送られた本文から組み立てる指定。
   *
   * **行番号をテスト側で決め打ちしない。** 合本は話ごとに切られ、
   * さらにまとめ直されることがあるので、どの番号が振られるかは
   * 切り方で変わる。決め打ちすると、番号がずれた本物の壊れ方を
   * テストが隠してしまう。送られた本文（行番号つき）から語を探す。
   */
  extractNeedles: null as Array<{ needle: string; value: string }> | null,
}));

vi.mock("../../src/ai/registry", () => ({
  ensureConfigured: vi.fn(async (_registry: unknown, feature: string) => {
    state.features.push(feature);
    return {
      provider: {
        id: "ollama",
        displayName: "Ollama",
        isPaid: false,
        async testConnection() {
          return { ok: true };
        },
        async generate(request: {
          userPrompt: string;
          meta?: { feature?: string };
        }) {
          const name = request.meta?.feature ?? "";
          state.sent.push({ feature: name, userPrompt: request.userPrompt });
          let text = state.extractResponse;
          if (name === "fact_contradiction_verify") {
            text = state.verifyResponse;
          } else if (state.extractNeedles) {
            // 送られた本文（行番号つき）から、語を含む行を探して事実にする。
            // 含まれていないチャンクでは0行目になり、検算が弾く
            const lines = request.userPrompt.split("\n");
            text = JSON.stringify({
              facts: state.extractNeedles.map((item) => {
                const found = lines.find(
                  (line) => /^\d+: /.test(line) && line.includes(item.needle)
                );
                const number = found ? parseInt(found.split(":")[0], 10) : 0;
                return {
                  line_start: number,
                  line_end: number,
                  subject: "文佳",
                  predicate: "髪の色",
                  value: item.value,
                  kind: "static",
                  story_time: null,
                  modality: "narration",
                  pov: null,
                  speaker: null,
                  topic: null,
                };
              }),
            });
          }
          return { text, truncated: false, elapsedMs: 1 };
        },
      },
      model: "test-model",
    };
  }),
}));

vi.mock("../../src/core/scanner", () => ({
  scanWork: vi.fn(async () => ({ episodes: state.episodes })),
}));

/** 3行の本文。1行目に銀髪、3行目に黒髪（＝機械が食い違いを見つける形） */
const SOURCE = ["銀髪が揺れた。", "彼女は歩いた。", "黒髪が揺れた。"].join("\n");

/** ばらのファイル1本。これまでどおりの並び */
const PLAIN_EPISODES = [
  {
    filePath: "C:/works/w/003.txt",
    fileName: "003.txt",
    chapterStart: 3,
    chapterEnd: 3,
  },
];

/**
 * 合本（全話が1ファイル）。走査では**1件の話**になり、
 * `chapterStart` は中の最小（＝1）になる。
 *
 * 区切り行の形は `collectedFile.test.ts` と同じ（なろうのDLファイル）。
 * 1話目に銀髪、3話目に黒髪を置いて、話をまたぐ食い違いを作る。
 */
const COLLECTED = [
  "【タイトル】",
  "見本の作品",
  "",
  "【あらすじ】",
  "　試すための短い話。",
  "",
  "------------------------- エピソード1開始 -------------------------",
  "【エピソードタイトル】",
  "１話　出会い",
  "",
  "【本文】",
  "",
  "　銀髪が揺れた。",
  "",
  "------------------------- エピソード2開始 -------------------------",
  "【エピソードタイトル】",
  "２話　再会",
  "",
  "【本文】",
  "",
  "　彼女は歩いた。",
  "",
  "------------------------- エピソード3開始 -------------------------",
  "【エピソードタイトル】",
  "３話　別離",
  "",
  "【本文】",
  "",
  "　黒髪が揺れた。",
  "",
].join("\r\n");

const COLLECTED_EPISODES = [
  {
    filePath: "C:/works/w/all.txt",
    fileName: "all.txt",
    chapterStart: 1,
    chapterEnd: 3,
  },
];

vi.mock("../../src/core/textFile", () => ({
  readTextFile: vi.fn(async () => ({
    text: state.source,
    hasConflictMarkers: false,
  })),
  hashText: (text: string) => `hash-${text.length}`,
}));

vi.mock("../../src/core/workFormatStore", () => ({
  readWorkFormat: vi.fn(async () => ({ kind: "novel" })),
}));

vi.mock("../../src/core/characterStore", () => ({
  CharacterStore: class {
    async loadAll() {
      // 資料が無くても走る（事実は本文から抜ける）
      return { characters: [], errors: [] };
    }
  },
}));

vi.mock("../../src/core/chunkCache", () => ({
  ChunkCache: class {
    async load() {}
    get() {
      return undefined;
    }
    async set() {}
    async save() {}
  },
}));

// 順番待ちの札は、ここでは本体をそのまま走らせるだけでよい
vi.mock("../../src/features/aiTurn", () => ({
  withAiTurn: async (_options: unknown, run: () => Promise<void>) => run(),
}));

const { checkFactContradictions } = await import(
  "../../src/features/checkFactContradictions"
);

const work: WorkEntry = {
  id: "w1",
  title: "試しの作品",
  folderPath: "C:/works/w",
  registeredAt: "2026-09-11T00:00:00.000Z",
};

function registry(): AIRegistry {
  return {
    resolveModelInfo: vi.fn(async () => ({ contextWindow: 32768 })),
  } as unknown as AIRegistry;
}

/** 「1行目は銀髪、3行目は黒髪」を返す抽出の応答 */
const TWO_FACTS = JSON.stringify({
  facts: [
    {
      line_start: 1,
      line_end: 1,
      subject: "文佳",
      predicate: "髪の色",
      value: "銀髪",
      kind: "static",
      story_time: null,
      modality: "narration",
      pov: null,
      speaker: null,
      topic: null,
    },
    {
      line_start: 3,
      line_end: 3,
      subject: "文佳",
      predicate: "髪の色",
      value: "黒髪",
      kind: "static",
      story_time: null,
      modality: "narration",
      pov: null,
      speaker: null,
      topic: null,
    },
  ],
});

beforeEach(() => {
  state.features = [];
  state.sent = [];
  state.logged = [];
  state.episodes = PLAIN_EPISODES;
  state.source = SOURCE;
  state.extractNeedles = null;
  state.extractResponse = TWO_FACTS;
  state.verifyResponse = JSON.stringify({
    verdict: "採用",
    reason: "",
    explanation: "どちらも地の文で、両立しない",
    confidence: "high",
  });
  Object.assign(window, {
    showInformationMessage: vi.fn(async () => "実行"),
    showWarningMessage: vi.fn(async () => undefined),
    createOutputChannel: () => ({
      appendLine: (line: string) => state.logged.push(line),
      show() {},
      dispose() {},
    }),
    withProgress: vi.fn(
      async (
        _options: unknown,
        task: (
          progress: { report: () => void },
          token: {
            isCancellationRequested: boolean;
            onCancellationRequested: () => void;
          }
        ) => Promise<unknown>
      ) =>
        task(
          { report: vi.fn() },
          { isCancellationRequested: false, onCancellationRequested: vi.fn() }
        )
    ),
  });
});

describe("端から端まで", () => {
  test("抽出→機械照合→判定を通って、提案パネルの形になる", async () => {
    const result = await checkFactContradictions(work, registry());

    expect(result).toBeDefined();
    expect(result?.acceptedFacts).toBe(2);
    expect(result?.candidateCount).toBe(1);
    expect(result?.issues).toHaveLength(1);

    const issue = result!.issues[0];
    // 場所は**後ろ側の事実**のもの（3行目の黒髪）
    expect(issue.filePath).toBe("C:/works/w/003.txt");
    expect(issue.line).toBe(3);
    // 引用は本文の行そのもの
    expect(issue.excerpt).toBe("黒髪が揺れた。");
    expect(issue.category).toBe("設定");
    expect(issue.settingSays).toContain("銀髪");
    expect(issue.textSays).toContain("黒髪");
    // 判定で分かったことは、作者の判断材料として残す
    expect(issue.note).toContain("両立しない");
  });

  test("抽出と判定で、別々の割当を引く", async () => {
    await checkFactContradictions(work, registry());

    // 抽出＝ローカルで足りる／判定＝高精度、と分けられるようにする（6.88.9）
    expect(state.features).toEqual(["factExtract", "contradiction"]);
  });

  test("判定へ渡すのは、候補の2か所と前後の行だけ", async () => {
    await checkFactContradictions(work, registry());

    const verify = state.sent.find(
      (entry) => entry.feature === "fact_contradiction_verify"
    );

    expect(verify).toBeDefined();
    // 前後の行が行番号つきで入る（本文全体を渡すわけではない）
    expect(verify?.userPrompt).toContain("1: 銀髪が揺れた。");
    expect(verify?.userPrompt).toContain("3: 黒髪が揺れた。");
    expect(verify?.userPrompt).toContain("引用: 黒髪が揺れた。");
  });

  test("候補が0件ならAIを呼ばない", async () => {
    // 事実が1件だけなら、機械照合は何も見つけない
    state.extractResponse = JSON.stringify({
      facts: [
        {
          line_start: 1,
          line_end: 1,
          subject: "文佳",
          predicate: "髪の色",
          value: "銀髪",
          kind: "static",
          story_time: null,
          modality: "narration",
          pov: null,
          speaker: null,
          topic: null,
        },
      ],
    });

    const result = await checkFactContradictions(work, registry());

    expect(result?.candidateCount).toBe(0);
    expect(result?.issues).toEqual([]);
    // 判定のAIは引かれてすらいない（呼ぶだけ無駄で、有料なら料金にもなる）
    expect(state.features).toEqual(["factExtract"]);
    expect(
      state.sent.filter(
        (entry) => entry.feature === "fact_contradiction_verify"
      )
    ).toEqual([]);
  });

  test("判定で却下されたら、提案パネルには出さない", async () => {
    state.verifyResponse = JSON.stringify({
      verdict: "却下",
      reason: "作中の変化",
      explanation: "髪を切った描写がある",
      confidence: "high",
    });

    const result = await checkFactContradictions(work, registry());

    expect(result?.candidateCount).toBe(1);
    expect(result?.issues).toEqual([]);
    // **黙って消さない**（設計書6.10.5）。取り下げた理由を持ち帰る
    expect(result?.verifyNote).toContain("作中の変化");
  });

  test("検算で弾いた事実は、理由ごと数える", async () => {
    state.extractResponse = JSON.stringify({
      facts: [
        // 本文に無い行
        {
          line_start: 99,
          line_end: 99,
          subject: "文佳",
          predicate: "髪の色",
          value: "銀髪",
          kind: "static",
          story_time: null,
          modality: "narration",
          pov: null,
          speaker: null,
          topic: null,
        },
        // 中身の無い値
        {
          line_start: 1,
          line_end: 1,
          subject: "文佳",
          predicate: "髪の色",
          value: "不明",
          kind: "static",
          story_time: null,
          modality: "narration",
          pov: null,
          speaker: null,
          topic: null,
        },
      ],
    });

    const result = await checkFactContradictions(work, registry());

    expect(result?.acceptedFacts).toBe(0);
    expect(result?.rejectedFacts).toBe(2);
    expect(result?.rejectionNote).toContain("行が範囲外");
    expect(result?.rejectionNote).toContain("中身の無い値");
  });

  test("完了の1行を、必ずログへ残す", async () => {
    await checkFactContradictions(work, registry());

    expect(state.logged.join("\n")).toContain("矛盾検知（事実の照合）を終了");
  });
});

/**
 * 合本（全話が1ファイル）。
 *
 * **話数はファイル単位では引けない。** 走査は合本を1件の話として返すので、
 * ファイルの場所から引くと全部が先頭の話（第1話）になる。指摘の場所が
 * 全件「第1話」になって、作者は直しに行く先を間違える（作者の報告、
 * 2026-09-12）。話数はチャンクの内訳（`ChunkSegment.chapterStart`）から引く。
 */
describe("合本（全話が1ファイル）", () => {
  beforeEach(() => {
    state.episodes = COLLECTED_EPISODES;
    state.source = COLLECTED;
    state.extractNeedles = [
      { needle: "銀髪が揺れた", value: "銀髪" },
      { needle: "黒髪が揺れた", value: "黒髪" },
    ];
  });

  test("第3話の本文から取った事実は、第3話になる", async () => {
    const result = await checkFactContradictions(work, registry());

    expect(result?.acceptedFacts).toBe(2);
    expect(result?.issues).toHaveLength(1);

    const issue = result!.issues[0];
    // 前側は1話目の銀髪、後側は3話目の黒髪
    expect(issue.settingSays).toContain("第1話");
    expect(issue.settingSays).toContain("銀髪");
    expect(issue.textSays).toContain("第3話");
    expect(issue.textSays).toContain("黒髪");
  });

  test("飛び先は、合本の中の正しい行を指す", async () => {
    const result = await checkFactContradictions(work, registry());

    const issue = result!.issues[0];
    expect(issue.filePath).toBe("C:/works/w/all.txt");
    // 引用は本文の行そのもの（字下げは落とす。行番号を戻し損ねると別の行が出る）
    expect(issue.excerpt).toBe("黒髪が揺れた。");
    const lines = COLLECTED.replace(/\r\n?/g, "\n").split("\n");
    expect(lines[issue.line - 1]).toBe("　黒髪が揺れた。");
  });
});
