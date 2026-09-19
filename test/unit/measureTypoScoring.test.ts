import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  applyTypoFix,
  formatSpreadLines,
  metricsOfRun,
  scoreTypo,
  spreadOfRuns,
} from "../../scripts/measureScoring.mjs";

/*
  誤字脱字検知（P-09、feature: typo）の**数え方**を確かめる
  （測定台は `test/fixtures/seeded/typo/`）。

  束も Ollama も要らない。**正解どおりの入力・わざと間違えた入力・
  何も返さない入力**の3通りを通す——**「何も指摘しない実装が満点になる」
  ことを防ぐのが、この試験のいちばんの役目**である（CLAUDE.md）。
*/

const ROOT = path.join(__dirname, "..", "fixtures", "seeded", "typo");

interface Seed {
  kind: string;
  wrong: string;
  right: string;
  where: string;
}

interface Trap {
  kind: string;
  word: string;
  count: number;
  guard: string | null;
}

interface Episode {
  file: string;
  seeded: Seed[];
  mustNotFlag: Trap[];
}

interface Answers {
  episodes: Episode[];
  traps: Array<{ no: number; name: string; checkedBy: string }>;
  totals: {
    仕込み: Record<string, number>;
    罠: Record<string, number>;
  };
}

const ANSWERS: Answers = JSON.parse(
  fs.readFileSync(path.join(ROOT, "answers.json"), "utf8")
);

const SEED_TOTAL = ANSWERS.episodes.reduce(
  (sum, episode) => sum + episode.seeded.length,
  0
);
const TRAP_TOTAL = ANSWERS.episodes.reduce(
  (sum, episode) => sum + episode.mustNotFlag.length,
  0
);

/* ── 返り値の形を組む（`core/typoCheckValidation.ts` の AcceptedTypoIssue） ── */

interface Issue {
  line: number;
  original: string;
  target: string;
  suggestion: string;
  reason: string;
  confidence: string;
}

function issue(
  original: string,
  target: string,
  suggestion: string,
  reason = "誤変換"
): Issue {
  return { line: 1, original, target, suggestion, reason, confidence: "high" };
}

/** `results[]` の形（`chunkId` は `<相対パス>#<話数>-<番号>@<最大字数>`） */
function resultsOf(byFile: Map<string, Issue[]>): unknown[] {
  return [...byFile].map(([file, accepted], index) => ({
    chunkId: `${file}#${index + 1}-1@8000`,
    accepted,
    rejected: [],
  }));
}

/**
 * 仕込みを「正しく直した」指摘。
 *
 * 引用は `answers.json` の `where` をそのまま使う（本文の逐語である）。
 * 直す語は仕込みそのもので、修正案は正しい形にする。
 */
function correctFix(seed: Seed): Issue {
  // 「霧がが」だけは、正しい形（「霧が晴れ」）が助詞の1字ぶん重なる。
  // 実際のモデルは「霧がが」→「霧が」と返すので、その形で組む
  const suggestion = seed.wrong === "霧がが" ? "霧が" : seed.right;
  return issue(seed.where, seed.wrong, suggestion);
}

/** 満点の返り値（12件の仕込みを、すべて正しく直す） */
function perfectRun(): unknown[] {
  const byFile = new Map<string, Issue[]>();
  for (const episode of ANSWERS.episodes) {
    byFile.set(episode.file, episode.seeded.map(correctFix));
  }
  return resultsOf(byFile);
}

/** 何も返さない返り値（チャンクは通ったが、指摘が0件） */
function emptyRun(): unknown[] {
  const byFile = new Map<string, Issue[]>();
  for (const episode of ANSWERS.episodes) byFile.set(episode.file, []);
  return resultsOf(byFile);
}

describe("誤字脱字の答え合わせ", () => {
  it("正解どおりに返すと満点になる", () => {
    const scored = scoreTypo(ANSWERS, perfectRun());
    expect(scored.seeds.found).toBe(SEED_TOTAL);
    expect(scored.seeds.total).toBe(SEED_TOTAL);
    expect(scored.missed).toEqual([]);
    expect(scored.wrongFix.count).toBe(0);
    expect(scored.falsePositives.count).toBe(0);
    expect(scored.otherFlags).toBe(0);
  });

  it("種別ごとの内訳も、仕込みの数と合う", () => {
    const scored = scoreTypo(ANSWERS, perfectRun());
    for (const [kind, bucket] of Object.entries(scored.seeds.byKind)) {
      const entry = bucket as { found: number; total: number };
      expect(entry.found, kind).toBe(entry.total);
      expect(entry.total, kind).toBe(ANSWERS.totals.仕込み[kind]);
    }
  });

  it("**何も返さない入力は0点になる**（誤検出が0でも満点にしない）", () => {
    const scored = scoreTypo(ANSWERS, emptyRun());
    expect(scored.seeds.found).toBe(0);
    expect(scored.missed).toHaveLength(SEED_TOTAL);
    // 誤検出も仕込み以外も0。**それでも点は0でなければならない**
    expect(scored.falsePositives.count).toBe(0);
    expect(scored.otherFlags).toBe(0);
    expect(scored.wrongFix.count).toBe(0);
  });

  it("**何も返さない入力の表に、満点と読ませない断りが出る**", () => {
    const { metrics } = metricsOfRun("typo", ANSWERS, {
      results: emptyRun(),
      failures: [],
      elapsedMs: 1000,
    });
    const lines: string[] = formatSpreadLines(spreadOfRuns([{ metrics }]));
    expect(lines.join("\n")).toContain(`0/${SEED_TOTAL}`);
    expect(lines.join("\n")).toContain("1件も拾えていません");
  });

  it("切り方が違っても、当てて本文が直るなら拾えたと数える", () => {
    // 「ゆっくりりと」→「ゆっくりと」を、「りり」→「り」と返すモデルがある。
    // **どちらも本文は正しく直る**ので、点が動いてはいけない
    const byFile = new Map<string, Issue[]>([
      [
        "本文/003_星待ちの夜.txt",
        [issue("源治は膝に手をついて、ゆっくりりと立ち上がった", "りり", "り")],
      ],
    ]);
    const scored = scoreTypo(ANSWERS, resultsOf(byFile));
    expect(scored.seeds.found).toBe(1);
    expect(scored.wrongFix.count).toBe(0);
  });

  it("場所は当てても、当てて直らなければ拾えたに数えない", () => {
    const byFile = new Map<string, Issue[]>([
      [
        "本文/001_霧の朝.txt",
        // 「以外」を指しているが、直した先が誤り（本文は直らない）
        [issue("源治の見立ては以外とよく当たる", "以外", "位外")],
      ],
    ]);
    const scored = scoreTypo(ANSWERS, resultsOf(byFile));
    expect(scored.seeds.found).toBe(0);
    expect(scored.wrongFix.count).toBe(1);
    expect(scored.wrongFix.items[0].wrong).toBe("以外");
    // 見逃しの内訳にも、理由つきで残る
    expect(scored.missed[0].note).toBe("場所は当てたが直らない");
  });

  it("誤りの形が残る修正案は、拾えたに数えない", () => {
    // 「曇っていている」→「曇っていているのだった」のように、
    // 誤りを抱えたまま書き足す返り方がある（当てても直らない）
    const byFile = new Map<string, Issue[]>([
      [
        "本文/002_風の午後.txt",
        [
          issue(
            "空は朝からずっと曇っていている",
            "曇っていている",
            "曇っていているようだ"
          ),
        ],
      ],
    ]);
    const scored = scoreTypo(ANSWERS, resultsOf(byFile));
    expect(scored.seeds.found).toBe(0);
    expect(scored.wrongFix.count).toBe(1);
  });

  it("罠をすべて直そうとすると、誤検出が罠の数だけ出る", () => {
    const byFile = new Map<string, Issue[]>();
    for (const episode of ANSWERS.episodes) {
      byFile.set(
        episode.file,
        episode.mustNotFlag.map((trap) =>
          // その語を別の語へ変える＝作品世界の語を壊す指摘
          issue(`…${trap.word}…`, trap.word, "×")
        )
      );
    }
    const scored = scoreTypo(ANSWERS, resultsOf(byFile));
    expect(scored.falsePositives.count).toBe(TRAP_TOTAL);
    expect(scored.seeds.found).toBe(0);
    expect(scored.missed).toHaveLength(SEED_TOTAL);
    // 種別ごとの内訳も、答えの数と合う
    for (const [kind, count] of Object.entries(scored.falsePositives.byKind)) {
      expect(count, kind).toBe(ANSWERS.totals.罠[kind]);
    }
  });

  it("引用の中に罠の語があるだけなら、誤検出に数えない", () => {
    // 直す先は仕込み（「霧がが」）で、罠（「霧鈴」）はそのまま残る
    const byFile = new Map<string, Issue[]>([
      [
        "本文/001_霧の朝.txt",
        [issue("霧鈴が鳴った。昼前には霧がが晴れて", "霧がが", "霧が")],
      ],
    ]);
    const scored = scoreTypo(ANSWERS, resultsOf(byFile));
    expect(scored.falsePositives.count).toBe(0);
    expect(scored.seeds.found).toBe(1);
  });

  it("仕込みにも罠にも当たらない指摘は、別に数える", () => {
    const byFile = new Map<string, Issue[]>([
      ["本文/001_霧の朝.txt", [issue("石段に霜が残っていて", "霜", "しも")]],
    ]);
    const scored = scoreTypo(ANSWERS, resultsOf(byFile));
    expect(scored.otherFlags).toBe(1);
    expect(scored.falsePositives.count).toBe(0);
    expect(scored.seeds.found).toBe(0);
  });

  it("1つの指摘を2つの仕込みに使い回さない", () => {
    // 同じ指摘を2件返しても、拾えるのは1件だけ
    const byFile = new Map<string, Issue[]>([
      [
        "本文/001_霧の朝.txt",
        [
          issue("源治の見立ては以外とよく当たる", "以外", "意外"),
          issue("源治の見立ては以外とよく当たる", "以外", "意外"),
        ],
      ],
    ]);
    const scored = scoreTypo(ANSWERS, resultsOf(byFile));
    expect(scored.seeds.found).toBe(1);
    expect(scored.otherFlags).toBe(1);
  });

  it("当て方は、製品と同じ（original の target を suggestion へ置き換える）", () => {
    expect(
      applyTypoFix(issue("昼前には霧がが晴れて", "霧がが", "霧が"))
    ).toBe("昼前には霧が晴れて");
    // 対象が引用に無ければ、当てられない（製品は検算で弾く形）
    expect(applyTypoFix(issue("昼前には霧がが晴れて", "雪", "雨"))).toBe(
      "昼前には霧がが晴れて"
    );
  });

  it("指標の表には、拾えた数と誤検出が必ず並ぶ", () => {
    const { metrics } = metricsOfRun("typo", ANSWERS, {
      results: perfectRun(),
      failures: [],
      elapsedMs: 1000,
    });
    expect(metrics.typoFound).toBe(SEED_TOTAL);
    expect(metrics.typoFoundTotal).toBe(SEED_TOTAL);
    expect(metrics.typoMissed).toBe(0);
    expect(metrics.typoFalsePositives).toBe(0);

    const lines: string[] = formatSpreadLines(spreadOfRuns([{ metrics }]));
    const text = lines.join("\n");
    expect(text).toContain("仕込んだ誤字を拾えた");
    expect(text).toContain("見逃し");
    expect(text).toContain("誤検出");
    expect(text).toContain(`${SEED_TOTAL}/${SEED_TOTAL}`);
  });
});

describe("測定台そのものの健全さ", () => {
  /*
    **答えと本文がずれたら、そこから先の測定はすべて嘘になる。**
    本文を直したのに `answers.json` を直し忘れる、という壊れ方が
    いちばん起きやすいので、ここで数え直す。
  */
  const bodyOf = (file: string): string =>
    fs.readFileSync(path.join(ROOT, file), "utf8");

  const countOf = (text: string, word: string): number =>
    text.split(word).length - 1;

  it("仕込みの語は、本文に1か所ずつしか無い", () => {
    for (const episode of ANSWERS.episodes) {
      const text = bodyOf(episode.file);
      for (const seed of episode.seeded) {
        expect(countOf(text, seed.wrong), `${episode.file} ${seed.wrong}`).toBe(
          1
        );
        expect(countOf(text, seed.where), `${episode.file} ${seed.where}`).toBe(
          1
        );
      }
    }
  });

  it("直した形は、その話の本文に出てこない", () => {
    /*
      同じ話に正しい形があると、当てたのかどうかを見分けられない
      （答え合わせは話ごとに行う）。

      **別の話に出てくるのは、わざとである**——「以外」（誤り、第1話）と
      「意外」（正しい、第3話）のように、仕込みと罠を対にしてある（罠8）。
    */
    for (const episode of ANSWERS.episodes) {
      const text = bodyOf(episode.file);
      for (const seed of episode.seeded) {
        expect(countOf(text, seed.right), `${episode.file} ${seed.right}`).toBe(
          0
        );
      }
    }
  });

  it("罠の語の数は、答えと本文で一致する", () => {
    for (const episode of ANSWERS.episodes) {
      const text = bodyOf(episode.file);
      for (const trap of episode.mustNotFlag) {
        expect(countOf(text, trap.word), `${episode.file} ${trap.word}`).toBe(
          trap.count
        );
      }
    }
  });

  it("合計の欄は、仕込み・罠の並びと合う", () => {
    const seedKinds: Record<string, number> = {};
    const trapKinds: Record<string, number> = {};
    for (const episode of ANSWERS.episodes) {
      for (const seed of episode.seeded) {
        seedKinds[seed.kind] = (seedKinds[seed.kind] ?? 0) + 1;
      }
      for (const trap of episode.mustNotFlag) {
        trapKinds[trap.kind] = (trapKinds[trap.kind] ?? 0) + 1;
      }
    }
    for (const [kind, count] of Object.entries(seedKinds)) {
      expect(ANSWERS.totals.仕込み[kind], kind).toBe(count);
    }
    for (const [kind, count] of Object.entries(trapKinds)) {
      expect(ANSWERS.totals.罠[kind], kind).toBe(count);
    }
    expect(ANSWERS.totals.仕込み.合計).toBe(SEED_TOTAL);
    expect(ANSWERS.totals.罠.合計).toBe(TRAP_TOTAL);
  });

  it("各話は 1,200〜1,500字に収まる", () => {
    // 1チャンクに収まる長さであること（切れると、話ごとの答え合わせがずれる）
    for (const episode of ANSWERS.episodes) {
      const chars = [...bodyOf(episode.file).replace(/\n/g, "")].length;
      expect(chars, episode.file).toBeGreaterThanOrEqual(1200);
      expect(chars, episode.file).toBeLessThanOrEqual(1500);
    }
  });
});
