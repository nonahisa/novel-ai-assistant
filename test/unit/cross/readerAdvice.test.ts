import { describe, expect, test, vi } from "vitest";
import {
  buildReaderAdviceMaterial,
  buildReaderAdviceMaterials,
  HIATUS_MIN_DAYS,
  READER_ADVICE_FULL_SERIES_MAX,
  READER_ADVICE_SOURCES,
  type ReaderAdviceMaterial,
} from "../../../src/core/readerAdvice";
import { computeReaderRates } from "../../../src/core/readerRates";
import { buildPostingSiteRecords } from "../../../src/core/postingSiteRecords";
import {
  emptyPostingLedger,
  withReaderStats,
  type PostingLedger,
  type ReaderStatsRecord,
} from "../../../src/models/posting";
import {
  READER_ADVICE_EXAMPLES,
  READER_ADVICE_GUIDELINES,
  buildReaderAdvicePrompt,
  buildReaderAdviceTonePrompt,
  buildReaderReactionChatBlock,
  formatReaderAdviceMaterial,
  questionMentionsReaderReaction,
} from "../../../src/prompts/readerAdvice";
import {
  mentionedEpisodes,
  validateReaderAdviceAnswer,
} from "../../../src/core/readerAdviceValidation";
import { readerReactionChatBlockFor } from "../../../src/core/readerAdviceChat";
import type { AdviceProfile } from "../../../src/core/advicePolicy";
import { buildWritingStatsPanelHtml } from "../../../src/views/writingStatsPanelHtml";

/**
 * 読者の反応の助言（残課題 B9。設計書6.79.7.3）。
 *
 * **作者の方針転換（2026-09-23 朝）**：決め打ちの助言文をやめ、コードは
 * 材料（率・話ごとのPV・休載らしい区間・休載前の最終話での離脱率）を正確に
 * 作り、読むのはAIに任せる。記事の目安は例示として渡す。
 *
 * **見逃しと誤検出の両方**を見る——休載のある作品で休載を見つけること、
 * 休載の無い作品で休載と言わないこと。
 */

const DAY = 24 * 60 * 60 * 1000;
/** 読んだ時点（すべての記録で同じ） */
const readAt = "2026-09-23T03:00:00.000Z";
const readTime = Date.parse(readAt);

function isoDaysBeforeRead(days: number): string {
  return new Date(readTime - days * DAY).toISOString();
}

function episode(
  number: number,
  pv: number,
  patch: Partial<ReaderStatsRecord> = {}
): ReaderStatsRecord {
  return {
    site: "kakuyomu",
    readAt,
    scope: "episode",
    episode: number,
    metrics: { pv },
    source: "helper",
    ...patch,
  };
}

function work(metrics: ReaderStatsRecord["metrics"]): ReaderStatsRecord {
  return { site: "kakuyomu", readAt, scope: "work", metrics, source: "helper" };
}

/**
 * 話ごとのPVと、公開した日（読んだ時点から何日前か）の並びから記録を作る。
 * 日付を渡さない話には更新日を付けない。
 */
function series(
  pvs: readonly number[],
  daysBefore?: readonly (number | undefined)[],
  workMetrics: ReaderStatsRecord["metrics"] = { bookmarks: 10, reviews: 10 }
): ReaderStatsRecord[] {
  return [
    work(workMetrics),
    ...pvs.map((pv, index) => {
      const days = daysBefore?.[index];
      return episode(
        index + 1,
        pv,
        days === undefined ? {} : { updatedAt: isoDaysBeforeRead(days) }
      );
    }),
  ];
}

function materialOf(records: ReaderStatsRecord[]): ReaderAdviceMaterial {
  return buildReaderAdviceMaterial("カクヨム", computeReaderRates(records), records);
}

/** 毎週1話（最後の話は読んだ時点の7日前） */
function weekly(count: number): number[] {
  return Array.from({ length: count }, (_, index) => (count - index) * 7);
}

/** 1話ごとに少しずつ減るPV */
function decaying(count: number, first = 1000): number[] {
  return Array.from({ length: count }, (_, index) =>
    Math.round(first * Math.pow(0.97, index))
  );
}

describe("材料：休載の見分け", () => {
  test("ふだんの間隔より大きく空いた所を、休載らしい区間として見つける（見逃さない）", () => {
    // 第1〜10話は毎週、第10話と第11話のあいだが120日、そのあとまた毎週
    const days = [
      ...Array.from({ length: 10 }, (_, index) => 300 - index * 7), // 300..237
      ...Array.from({ length: 10 }, (_, index) => 117 - index * 7), // 117..54
    ];
    const pvs = decaying(20);
    const material = materialOf(series(pvs, days));

    expect(material.hiatus.status).toBe("found");
    expect(material.hiatus.usualDays).toBe(7);
    expect(material.hiatus.thresholdDays).toBe(HIATUS_MIN_DAYS);
    expect(material.hiatus.gaps).toHaveLength(1);
    const gap = material.hiatus.gaps[0];
    expect(gap.beforeEpisode).toBe(10);
    expect(gap.afterEpisode).toBe(11);
    expect(gap.days).toBe(120);
    // 休む前の最終話での離脱率（作者の依頼）＝ 1 − 第10話のPV ÷ 第1話のPV
    expect(gap.dropoutBefore?.ratio).toBeCloseTo(1 - pvs[9] / pvs[0], 10);
    expect(gap.pvBefore).toBe(pvs[9]);
    expect(gap.pvAfter).toBe(pvs[10]);

    const text = formatReaderAdviceMaterial(material);
    expect(text).toContain("休載らしい区間：第10話");
    expect(text).toContain("休む前の最終話（第10話）での離脱率");
  });

  test("毎週きちんと更新している作品では、休載と言わない（誤検出しない）", () => {
    const material = materialOf(series(decaying(30), weekly(30)));
    expect(material.hiatus.status).toBe("none");
    expect(material.hiatus.gaps).toEqual([]);
    expect(material.hiatus.stalled).toBeUndefined();
    expect(formatReaderAdviceMaterial(material)).toContain("休載らしい区間はありません");
  });

  test("毎日更新の作品の10日の休みは、長期休載とは呼ばない（28日の下限）", () => {
    const days = [
      ...Array.from({ length: 15 }, (_, index) => 60 - index), // 60..46
      ...Array.from({ length: 15 }, (_, index) => 35 - index), // 35..21（11日空き）
    ];
    const material = materialOf(series(decaying(30), days));
    expect(material.hiatus.status).toBe("none");
  });

  test("あとから直した古い話の新しい日付で、休載を作り出さない", () => {
    const days = weekly(20);
    // 第5話だけ、読んだ前日に直した（最終更新が新しい）
    days[4] = 1;
    const material = materialOf(series(decaying(20), days));
    expect(material.hiatus.status).toBe("none");
    expect(material.hiatus.gaps).toEqual([]);
  });

  test("更新日が1つも無ければ見分けず、そう言う（黙って「休載なし」にしない）", () => {
    const material = materialOf(series(decaying(10)));
    expect(material.hiatus.status).toBe("unknown");
    expect(material.hiatus.reason).toContain("更新日");
    const text = formatReaderAdviceMaterial(material);
    expect(text).toContain("見分けられません");
    expect(text).not.toContain("休載らしい区間はありません");
    // 基準の話が決まらないことも、材料の限界として添える
    expect(material.notes.join("")).toContain("まだ読まれ切っておらず");
    // 更新日の意味の注意は、更新日が無いときは要らない
    expect(material.notes.join("")).not.toContain("最終更新");
  });

  test("更新が少なすぎると、ふだんの間隔が分からないので見分けない", () => {
    const material = materialOf(series(decaying(3), [21, 14, 7]));
    expect(material.hiatus.status).toBe("unknown");
    expect(material.hiatus.reason).toContain("ふだんの間隔");
  });

  test("最後の更新から長く止まっていれば言う。ただし完結か休載かは決めない", () => {
    const days = weekly(10).map((value) => value + 90);
    const material = materialOf(series(decaying(10), days));
    expect(material.hiatus.stalled?.lastEpisode).toBe(10);
    expect(material.hiatus.stalled?.days).toBe(97);
    expect(formatReaderAdviceMaterial(material)).toContain(
      "完結したのか休んでいるのかは、材料からは分かりません"
    );
  });

  test("更新日は最終編集の日時だという限界を、材料に添える", () => {
    const material = materialOf(series(decaying(10), weekly(10)));
    expect(material.notes.join("")).toContain("公開日ではありません");
  });
});

describe("材料：率・長さ・PV", () => {
  test("率・基準の話・作品の長さ・序盤・減った話が入る", () => {
    const pvs = [100, 90, 60, 58, 49];
    const material = materialOf(series(pvs, weekly(5)));
    expect(material.dropout.percent).toBe("51.0%");
    expect(material.base?.episode).toBe(5);
    expect(material.length.lastEpisode).toBe(5);
    expect(material.length.spanDays).toBe(28);
    expect(material.firstStep?.percent).toBe("10.0%");
    expect(material.drops.map((drop) => drop.episode)).toContain(3);
    expect(material.existingEpisodes).toEqual([1, 2, 3, 4, 5]);
  });

  test("跳ねた話の直後を「急に減った」と数えない（それまでの最少と比べる）", () => {
    const material = materialOf(series([100, 80, 300, 78, 70], weekly(5)));
    const four = material.drops.find((drop) => drop.episode === 4);
    expect(four?.fromEpisode).toBe(2);
  });

  test(`${READER_ADVICE_FULL_SERIES_MAX}話を超える作品は、話ごとのPVを要所だけに絞る`, () => {
    const material = materialOf(series(decaying(219, 20000), weekly(219)));
    expect(material.summarized).toBe(true);
    const shown = material.pvPoints.map((point) => point.episode);
    expect(shown.length).toBeLessThan(60);
    for (const wanted of [1, 2, 3, 50, 100, 150, 200, 219]) {
      expect(shown).toContain(wanted);
    }
    // 第50話時点の離脱率（中堅の目安が「50話で」の値なので）
    expect(material.at50?.episode).toBe(50);
    // 要約しても、照合用の話数は全部持つ
    expect(material.existingEpisodes).toHaveLength(219);
  });

  test("材料の文に、決め打ちの判定の言葉が入らない", () => {
    const text = formatReaderAdviceMaterial(
      materialOf(series([100, 10, 5, 4, 3], weekly(5)))
    );
    for (const word of ["目安より高い", "書き直", "成立していない", "書籍化レベルに届いて"]) {
      expect(text, word).not.toContain(word);
    }
  });

  test("台帳からサイトごとに組む（話ごとの記録が無いサイトは入れない）", () => {
    let ledger: PostingLedger = emptyPostingLedger();
    for (const entry of series([100, 90, 80], weekly(3))) {
      ledger = withReaderStats(ledger, entry);
    }
    ledger = withReaderStats(ledger, {
      site: "narou",
      readAt,
      scope: "work",
      metrics: { pv: 10 },
      source: "manual",
    });
    const materials = buildReaderAdviceMaterials(ledger);
    expect(materials.map((material) => material.siteLabel)).toEqual(["カクヨム"]);
    expect(buildReaderAdviceMaterials(ledger, "narou")).toEqual([]);
  });
});

describe("プロンプト（P-40）", () => {
  const material = materialOf(series([100, 90, 60, 58, 49], weekly(5)));

  test("約束：目安は例示・やる気を一律に削がない・休載前の値を先に・数字を作らない・ブクマは目安なし", () => {
    const prompt = buildReaderAdvicePrompt({ workTitle: "作品", materials: [material] });
    expect(prompt).toContain(READER_ADVICE_GUIDELINES);
    expect(prompt).toContain(READER_ADVICE_EXAMPLES);
    expect(READER_ADVICE_GUIDELINES).toContain("例示");
    expect(READER_ADVICE_GUIDELINES).toContain("やる気を一律に削がない");
    expect(READER_ADVICE_GUIDELINES).toContain("休載前の最終話");
    expect(READER_ADVICE_GUIDELINES).toContain("材料にあるものだけ");
    expect(READER_ADVICE_GUIDELINES).toContain("確かめどころ");
    expect(READER_ADVICE_GUIDELINES).toContain("ブックマーク率には、作者の記事に目安がありません");
    expect(prompt).toContain(formatReaderAdviceMaterial(material));
  });

  test("【古い可能性】に分けた事柄は例示に入れない", () => {
    for (const word of ["更新時刻", "トップページ", "完結欄", "11時", "9・14・19", "新規流入", "1人10ポイント", "日間PV"]) {
      expect(READER_ADVICE_EXAMPLES, word).not.toContain(word);
    }
    // 目安の数字は定数から組まれている
    expect(READER_ADVICE_EXAMPLES).toContain("50話で約70%");
    expect(READER_ADVICE_EXAMPLES).toContain("3割を超えれば");
  });

  test("言い方の指針：診断していれば足し、相談の欄（profileSignals）の頼み方は入れない", () => {
    const profile = {
      scores: { reader: 1, self: 1, taste: 5 },
      updatedAt: "2026-09-10T00:00:00.000Z",
    } as unknown as AdviceProfile;
    const tone = buildReaderAdviceTonePrompt(profile, new Date("2026-09-23T00:00:00Z"));
    expect(tone).toContain("【この作者への言い方】");
    expect(tone).toContain("【タイプ】");
    expect(tone).not.toContain("profileSignals");
    expect(buildReaderAdviceTonePrompt(undefined, new Date())).toBeUndefined();

    const prompt = buildReaderAdvicePrompt({ workTitle: "作品", materials: [material], tone });
    expect(prompt).toContain("【この作者への言い方】");
  });
});

describe("AIの答えの確かめ", () => {
  const material = materialOf(series(decaying(20), weekly(20)));
  const json = (value: unknown) => JSON.stringify(value);

  test("ふつうの答えはそのまま通り、印は付かない", () => {
    const answer = validateReaderAdviceAnswer(
      json({
        summary: "第1話から第2話へはよく続いています。",
        points: [{ title: "序盤", body: "第2話までの離れ方は小さめです。" }],
      }),
      [material]
    );
    expect(answer?.summary).toContain("第1話");
    expect(answer?.summaryMarks).toEqual([]);
    expect(answer?.points[0].marks).toEqual([]);
    expect(answer?.notes).toEqual([]);
  });

  test("記録に無い話数には印を付ける（見逃さない）", () => {
    const answer = validateReaderAdviceAnswer(
      json({
        summary: "",
        points: [{ title: "急な減り", body: "第250話で大きく減っています。" }],
      }),
      [material]
    );
    expect(answer?.points[0].marks.join("")).toContain("第250話は、読者の反応の記録にありません");
  });

  test("記事の目安「50話で約70%」を引いただけの文には、話数の印を付けない（誤検出しない）", () => {
    const answer = validateReaderAdviceAnswer(
      json({
        summary: "記事には50話で約70%なら中堅という見方がありますが、例示です。",
        points: [],
      }),
      [material]
    );
    expect(answer?.summaryMarks).toEqual([]);
  });

  test("話数の拾い方：第N話・範囲・N話目", () => {
    expect(mentionedEpisodes("第3〜5話と第１２話、7話目")).toEqual([3, 5, 7, 12]);
  });

  test("材料に無い百分率には印を付ける", () => {
    const answer = validateReaderAdviceAnswer(
      json({ summary: "離脱率は12.5%です。", points: [] }),
      [material]
    );
    expect(answer?.summaryMarks.join("")).toContain("12.5%は、渡した材料にない数字です");

    const known = material.dropout.percent as string;
    const ok = validateReaderAdviceAnswer(
      json({ summary: `離脱率は${known}です。`, points: [] }),
      [material]
    );
    expect(ok?.summaryMarks).toEqual([]);
  });

  test("字数の上限を超えたら切り詰めて、そう書く", () => {
    const answer = validateReaderAdviceAnswer(
      json({ summary: "あ".repeat(300), points: [{ title: "い".repeat(50), body: "う".repeat(500) }] }),
      [material]
    );
    expect([...(answer?.summary ?? "")]).toHaveLength(120);
    expect(answer?.summary.endsWith("…")).toBe(true);
    expect([...(answer?.points[0].title ?? "")]).toHaveLength(20);
    expect([...(answer?.points[0].body ?? "")]).toHaveLength(200);
    expect(answer?.notes.join("")).toContain("3 か所を切り詰めました");
  });

  test("指示の言葉がそのまま返ってきたら外す（CLAUDE.md の失敗3）", () => {
    const answer = validateReaderAdviceAnswer(
      json({
        summary: "全体の見立て",
        points: [
          { title: "（20字以内）", body: "特になし" },
          { title: "見出し", body: "本文" },
          { title: "（20字以内）", body: "第3話で離れ方が大きくなります。" },
        ],
      }),
      [material]
    );
    expect(answer?.summary).toBe("");
    expect(answer?.points).toHaveLength(1);
    expect(answer?.points[0].title).toBe("");
    expect(answer?.points[0].body).toContain("第3話");
    expect(answer?.notes.join("")).toContain("指示の言葉がそのまま返ってきた");
  });

  test("見てほしい所が4つを超えたら、あとを外してそう書く", () => {
    const points = Array.from({ length: 6 }, (_, index) => ({
      title: `点${index}`,
      body: `第${index + 1}話を見てください。`,
    }));
    const answer = validateReaderAdviceAnswer(json({ summary: "要約", points }), [material]);
    expect(answer?.points).toHaveLength(4);
    expect(answer?.notes.join("")).toContain("あとの 2 つを外しました");
  });

  test("読めない答え・中身の無い答えは undefined", () => {
    expect(validateReaderAdviceAnswer("すみません", [material])).toBeUndefined();
    expect(
      validateReaderAdviceAnswer(json({ summary: "なし", points: [] }), [material])
    ).toBeUndefined();
    // 前置きとコードの囲みが付いていても読む
    expect(
      validateReaderAdviceAnswer(
        "答えです\n```json\n" + json({ summary: "よく読まれています。", points: [] }) + "\n```",
        [material]
      )?.summary
    ).toBe("よく読まれています。");
  });
});

describe("相談：読者の反応の話のときだけ材料を足す", () => {
  test("反応の話に当たる", () => {
    for (const question of [
      "PVが伸びないのはなぜ？",
      "離脱率が高い気がする",
      "ブクマが増えない",
      "評価率ってどう見ればいい？",
      "休載のあと読者が減った",
      "読者の反応をどう読めばいい？",
    ]) {
      expect(questionMentionsReaderReaction(question), question).toBe(true);
    }
  });

  test("反応の話でなければ当てない（読者の区分の話・本文の評価の話）", () => {
    for (const question of [
      "読者型はわかりませんか？",
      "この作品の想定読者は？",
      "この場面の評価は？",
      "主人公の年齢は？",
    ]) {
      expect(questionMentionsReaderReaction(question), question).toBe(false);
    }
  });

  test("当たらなければ台帳を読まない", async () => {
    const load = vi.fn(async () => emptyPostingLedger());
    expect(await readerReactionChatBlockFor("主人公の年齢は？", load)).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });

  test("当たれば、ボタンと同じ材料と約束を足す", async () => {
    let ledger: PostingLedger = emptyPostingLedger();
    for (const entry of series([100, 90, 60, 58, 49], weekly(5))) {
      ledger = withReaderStats(ledger, entry);
    }
    const block = await readerReactionChatBlockFor("PVが伸びない", async () => ledger);
    expect(block?.sites).toEqual(["カクヨム"]);
    const material = buildReaderAdviceMaterials(ledger)[0];
    expect(block?.text).toContain(formatReaderAdviceMaterial(material));
    expect(block?.text).toContain(READER_ADVICE_GUIDELINES);
    expect(block?.text).toContain(READER_ADVICE_EXAMPLES);
  });

  test("記録が無い作品では、無いことと、数字を作らないことだけを渡す", () => {
    const text = buildReaderReactionChatBlock([]);
    expect(text).toContain("記録がまだありません");
    expect(text).toContain("推測で作らない");
  });
});

describe("サイトの記録へ載る", () => {
  test("話ごとの記録があれば材料の文と例示の記事が付き、無ければ付かない", () => {
    let ledger = emptyPostingLedger();
    for (const entry of series([100, 90, 60, 58, 49], weekly(5))) {
      ledger = withReaderStats(ledger, entry);
    }
    const record = buildPostingSiteRecords(ledger).find(
      (entry) => entry.site === "kakuyomu"
    );
    expect(record?.readerAdvice?.materialText).toContain("【率】");
    expect(record?.readerAdvice?.sources).toContainEqual(READER_ADVICE_SOURCES.article1);

    const workOnly = withReaderStats(emptyPostingLedger(), work({ pv: 10, bookmarks: 1 }));
    expect(
      buildPostingSiteRecords(workOnly).find((entry) => entry.site === "kakuyomu")
        ?.readerAdvice
    ).toBeNull();
  });
});

/**
 * 画面の組み立て（WebViewのスクリプト）を、そのまま呼べる形にして確かめる。
 * 手は readerRates.test.ts と同じ（中括弧の対応で切り出す）。
 */
const panelHtml = buildWritingStatsPanelHtml("NONCE123", "vscode-resource:");
const panelScript = (() => {
  const found = panelHtml.match(/<script nonce="NONCE123">([\s\S]*?)<\/script>/);
  if (!found) throw new Error("スクリプトが見つかりません");
  return found[1];
})();

function extractFunction(source: string, name: string): string {
  const head = source.indexOf("function " + name + "(");
  expect(head, name + " が見つからない").toBeGreaterThanOrEqual(0);
  let depth = 0;
  let started = false;
  for (let index = head; index < source.length; index++) {
    if (source[index] === "{") {
      depth++;
      started = true;
    } else if (source[index] === "}") {
      depth--;
      if (started && depth === 0) return source.slice(head, index + 1);
    }
  }
  throw new Error(name + " の終わりが見つからない");
}

describe("画面：助言", () => {
  type Render = (
    site: string,
    advice: { materialText: string; sources: unknown[] } | null,
    outcome?: unknown,
    busy?: boolean
  ) => string;
  const render = () =>
    new Function(
      [
        "escapeHtml",
        "readerAdviceSources",
        "readerAdviceMarks",
        "renderReaderAdviceAnswer",
        "renderReaderAdvice",
      ]
        .map((name) => extractFunction(panelScript, name))
        .concat(["return renderReaderAdvice;"])
        .join("\n")
    )() as Render;

  const advice = {
    materialText: formatReaderAdviceMaterial(
      materialOf(series([100, 10, 5, 4, 3], weekly(5)))
    ),
    sources: Object.values(READER_ADVICE_SOURCES),
  };

  test("決め打ちの助言文は出さず、ボタンと材料だけを出す", () => {
    const html = render()("kakuyomu", advice);
    expect(html).toContain("AIに助言をもらう");
    expect(html).toContain('data-advice-site="kakuyomu"');
    expect(html).toContain("AIへ渡す材料");
    expect(html).toContain("料金と所要時間の目安");
    expect(html).toContain('data-url="' + READER_ADVICE_SOURCES.article1.url + '"');
    for (const word of ["目安より高い", "書き直", "成立していない", "記事が挙げている手", "数字の読み方の注意"]) {
      expect(html, word).not.toContain(word);
    }
  });

  test("答えが届いたら、見立て・見てほしい所・印・どのAIの答えかを並べ、聞き直せる", () => {
    const html = render()("kakuyomu", advice, {
      kind: "answer",
      answer: {
        summary: "序盤でよく続いています。",
        summaryMarks: [],
        points: [{ title: "確かめどころ", body: "第9話を見てください。", marks: ["第9話は、読者の反応の記録にありません（AIの読み違いかもしれません）。"] }],
        notes: [],
      },
      fromCache: true,
      model: "gemma4:e4b",
      provider: "Ollama",
    });
    expect(html).toContain("序盤でよく続いています。");
    expect(html).toContain("第9話は、読者の反応の記録にありません");
    expect(html).toContain("gemma4:e4b");
    expect(html).toContain("前の答えを出しています");
    expect(html).toContain("AIに聞き直す");
    expect(html).toContain('data-force="1"');
  });

  test("聞いている最中はボタンを押せない。失敗は理由を出す", () => {
    expect(render()("kakuyomu", advice, undefined, true)).toContain("disabled");
    expect(
      render()("kakuyomu", advice, { kind: "failed", message: "AIに接続できません。" })
    ).toContain("AIに接続できません。");
  });

  test("材料が無ければ何も出さない", () => {
    expect(render()("kakuyomu", null)).toBe("");
  });
});
