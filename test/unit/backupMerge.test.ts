import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import {
  backupEpisodesOf,
  buildBackupDiffRecord,
  describeMergePlan,
  diffBodies,
  isEmptyMergePlan,
  planBackupMerge,
  summarizeMergeResult,
  type LocalManuscriptSource,
} from "../../src/core/backupMerge";
import { countProposableHunks, hunkProposalsOf } from "../../src/core/backupHunks";
import { inspectWorkBackup } from "../../src/core/workZip";
import {
  emptyPostingLedger,
  withReaderStats,
  type PostingLedger,
} from "../../src/models/posting";

/**
 * 既にある作品へ、バックアップのうち「足してよいもの」だけを足す計画
 * （作者の依頼、2026-09-23）。
 *
 * 材料は、作者のなろうの合本（`コールドスリープ/N5078JI.txt`）の**形だけ**を
 * 写して組んだもの——頭に作品情報と【評価】、章の最初の話にだけ【第N章】、
 * 各話の末尾に【リアクション】「いいね: N件」。本文は試験用の文である。
 */

const SEP = (n: number) =>
  `------------------------- エピソード${n}開始 -------------------------`;

interface EpisodeSpec {
  n: number;
  title: string;
  body: string[];
  part?: [number, string];
  likes?: number;
}

function episodeBlock(spec: EpisodeSpec): string[] {
  return [
    SEP(spec.n),
    ...(spec.part ? [`【第${spec.part[0]}章】`, spec.part[1], ""] : []),
    "【エピソードタイトル】",
    `${spec.n}話　${spec.title}`,
    "",
    "【本文】",
    ...spec.body,
    "",
    ...(spec.likes === undefined ? [] : ["【リアクション】", `いいね: ${spec.likes}件`, ""]),
  ];
}

const HEAD = [
  "【Nコード】",
  "N5078JI",
  "",
  "【タイトル】",
  "眠りから覚めたら",
  "",
  "【評価】",
  "総合評価ポイント: 2470pt",
  "お気に入り登録: 692件",
  "",
];

const EPISODES: EpisodeSpec[] = [
  { n: 1, title: "目覚め", part: [1, "主治医"], body: ["　目が覚めた。", "　白い天井だった。"], likes: 19 },
  { n: 2, title: "検査", body: ["　検査が続く。"], likes: 16 },
  { n: 3, title: "外へ", part: [2, "学園"], body: ["　外は明るかった。"], likes: 15 },
];

function collectedText(episodes: EpisodeSpec[], head: string[] = HEAD): string {
  return [...head, ...episodes.flatMap(episodeBlock)].join("\n");
}

function narouInspection(episodes: EpisodeSpec[] = EPISODES) {
  return inspectWorkBackup(
    zipSync({ "N5078JI.txt": new TextEncoder().encode(collectedText(episodes)) }),
    "N5078JI.zip"
  );
}

/** 分け済みの話ごとのファイル（「合本を話ごとに分ける」の形。区切り行が残る） */
function splitSources(episodes: EpisodeSpec[]): LocalManuscriptSource[] {
  return episodes.map((spec) => ({
    relPath: `本文/${String(spec.n).padStart(4, "0")}.txt`,
    manuscriptName: `${String(spec.n).padStart(4, "0")}.txt`,
    text: episodeBlock(spec).join("\n"),
  }));
}

/** 手元が合本のまま（作者のコールドスリープの形） */
function collectedSource(episodes: EpisodeSpec[]): LocalManuscriptSource[] {
  return [
    {
      relPath: "本文/N5078JI.txt",
      manuscriptName: "N5078JI.txt",
      text: collectedText(episodes),
    },
  ];
}

const READ_AT = "2026-09-23T10:00:00.000Z";

function plan(
  local: LocalManuscriptSource[],
  options: {
    ledger?: PostingLedger | null;
    chapters?: { name: string; startEpisodePath: string }[] | null;
    episodes?: EpisodeSpec[];
  } = {}
) {
  return planBackupMerge({
    inspection: narouInspection(options.episodes),
    local,
    existingChapters: options.chapters === undefined ? [] : options.chapters,
    ledger: options.ledger === undefined ? emptyPostingLedger() : options.ledger,
    readAt: READ_AT,
  });
}

describe("章", () => {
  it("手元が話ごとのファイルなら、章の最初の話のファイルを指して章を立てる", () => {
    const result = plan(splitSources(EPISODES));

    expect(result.chapters).toMatchObject({
      kind: "create",
      chapters: [
        { name: "主治医", startEpisodePath: "本文/0001.txt" },
        { name: "学園", startEpisodePath: "本文/0003.txt" },
      ],
    });
  });

  it("**台帳に章が1つでもあれば立てない**", () => {
    const result = plan(splitSources(EPISODES), {
      chapters: [{ name: "作者の章", startEpisodePath: "本文/0002.txt" }],
    });

    expect(result.chapters).toEqual({ kind: "existing", count: 2, existingCount: 1 });
    expect(describeMergePlan(result).join("\n")).toContain("立てません");
  });

  it("台帳を読めなかったら立てない", () => {
    const result = plan(splitSources(EPISODES), { chapters: null });

    expect(result.chapters.kind).toBe("unreadable");
  });

  it("手元が合本のままだと、途中から始まる章は置けないので1つも立てない", () => {
    const result = plan(collectedSource(EPISODES));

    expect(result.chapters).toEqual({
      kind: "blocked",
      count: 2,
      insideCollected: 1,
      missing: 0,
    });
    expect(describeMergePlan(result).join("\n")).toContain("合本を話ごとに分ける");
  });

  it("始まりの話が手元に無い章があれば、1つも立てない", () => {
    const result = plan(splitSources(EPISODES.slice(0, 2)));

    expect(result.chapters).toMatchObject({ kind: "blocked", missing: 1 });
  });
});

describe("いいね・評価", () => {
  it("話ごとのいいねと作品全体の評価を、出どころ backup として積む", () => {
    const result = plan(splitSources(EPISODES));

    expect(result.readerStats).toEqual([
      {
        site: "narou",
        readAt: READ_AT,
        scope: "work",
        metrics: { points: 2470, bookmarks: 692 },
        source: "backup",
      },
      { site: "narou", readAt: READ_AT, scope: "episode", episode: 1, metrics: { likes: 19 }, source: "backup" },
      { site: "narou", readAt: READ_AT, scope: "episode", episode: 2, metrics: { likes: 16 }, source: "backup" },
      { site: "narou", readAt: READ_AT, scope: "episode", episode: 3, metrics: { likes: 15 }, source: "backup" },
    ]);
  });

  it("**同じバックアップを2度持ち込んでも、同じ数字は積まない**", () => {
    const first = plan(splitSources(EPISODES));
    let ledger = emptyPostingLedger();
    for (const record of first.readerStats) ledger = withReaderStats(ledger, record);

    const second = plan(splitSources(EPISODES), { ledger });

    expect(second.readerStats).toEqual([]);
    expect(second.readerStatsAlready).toBe(4);
  });

  it("数字が変わった話だけは積む（それが推移である）", () => {
    const first = plan(splitSources(EPISODES));
    let ledger = emptyPostingLedger();
    for (const record of first.readerStats) ledger = withReaderStats(ledger, record);

    const grown = EPISODES.map((spec) =>
      spec.n === 2 ? { ...spec, likes: 20 } : spec
    );
    const second = plan(splitSources(grown), { ledger, episodes: grown });

    expect(second.readerStats).toEqual([
      { site: "narou", readAt: READ_AT, scope: "episode", episode: 2, metrics: { likes: 20 }, source: "backup" },
    ]);
  });

  it("サイトの作品情報がまだ無ければ、Nコードを書き留める", () => {
    const result = plan(splitSources(EPISODES));

    expect(result.profile).toEqual({
      site: "narou",
      value: { workId: "n5078ji", workUrl: "https://ncode.syosetu.com/n5078ji/" },
    });
  });

  it("サイトの作品情報が既にあれば触らない（作者のメモを押し流さない）", () => {
    const ledger: PostingLedger = {
      ...emptyPostingLedger(),
      siteProfiles: [{ site: "narou", note: "作者のメモ" }],
    };

    expect(plan(splitSources(EPISODES), { ledger }).profile).toBeNull();
  });

  it("台帳を読めなかったら反応は足さず、「入っていません」とは言わない", () => {
    const result = plan(splitSources(EPISODES), { ledger: null });

    expect(result.readerStats).toEqual([]);
    const text = describeMergePlan(result).join("\n");
    expect(text).toContain("読めなかったため");
    expect(text).not.toContain("読者の反応：このバックアップには入っていません");
  });

  it("コメントはどのバックアップにも入っていないことを、そのまま言う", () => {
    expect(describeMergePlan(plan(splitSources(EPISODES))).join("\n")).toContain(
      "コメント：このバックアップには入っていません"
    );
  });
});

describe("本文の違い", () => {
  it("**本文が違う話を数えるだけで、計画の中に原稿を書き換えるものは無い**", () => {
    const local = EPISODES.map((spec) =>
      spec.n === 2 ? { ...spec, body: ["　手元で直した検査の場面。"] } : spec
    );

    const result = plan(splitSources(local));

    expect(result.bodyDiffs).toEqual([
      {
        order: 2,
        label: "2話　検査",
        relPath: "本文/0002.txt",
        hunks: [
          { localLine: 1, local: ["　手元で直した検査の場面。"], backup: ["　検査が続く。"] },
        ],
        // 区切り行・【エピソードタイトル】・題・空行・【本文】の5行の下から本文
        bodyLineOffset: 5,
        // 手元のハッシュを渡していない（読み手が渡す。無ければ提案にしない）
        fileHash: null,
      },
    ]);
    expect(result.sameBodies).toBe(2);
    expect(describeMergePlan(result).join("\n")).toContain("原稿は書き換えません");
  });

  it("**違い1か所ずつを、ファイルの行番号つきの提案にできる**（作者の裁定、2026-09-23）", () => {
    const local = EPISODES.map((spec) =>
      spec.n === 1
        ? // 字下げの違い（1行目）と、段落が1つ多い（手元にだけある）の2か所
          { ...spec, body: ["目が覚めた。", "　白い天井だった。", "　手元で足した段落。"] }
        : spec
    );
    const sources = splitSources(local).map((source) => ({ ...source, hash: "h-local" }));

    const result = plan(sources);

    expect(result.bodyDiffs).toHaveLength(1);
    const proposals = hunkProposalsOf(result.bodyDiffs[0]);
    expect(proposals).toEqual([
      {
        relPath: "本文/0001.txt",
        episodeLabel: "1話　目覚め",
        // 区切り行・【第1章】・章題・空行・【エピソードタイトル】・題・空行・【本文】の次
        startLine: 9,
        local: ["目が覚めた。"],
        backup: ["　目が覚めた。"],
        fileHash: "h-local",
      },
      {
        relPath: "本文/0001.txt",
        episodeLabel: "1話　目覚め",
        startLine: 11,
        local: ["　手元で足した段落。"],
        backup: [],
        fileHash: "h-local",
      },
    ]);
    // ファイルのその行に、ほんとうに手元の行がある
    const fileLines = (sources[0].text ?? "").split("\n");
    expect(fileLines[8]).toBe("目が覚めた。");
    expect(fileLines[10]).toBe("　手元で足した段落。");

    expect(describeMergePlan(result, { proposals: true }).join("\n")).toContain(
      "・本文の違い：1話（2か所）。提案パネルに並べます"
    );
  });

  it("手元が合本でも、ファイルの中のその話の位置へ番号を直す", () => {
    const local = EPISODES.map((spec) =>
      spec.n === 3 ? { ...spec, body: ["　外は暗かった。"] } : spec
    );
    const sources = collectedSource(local).map((source) => ({ ...source, hash: "h" }));

    const result = plan(sources);
    const [proposal] = hunkProposalsOf(result.bodyDiffs[0]);

    const fileLines = (sources[0].text ?? "").split("\n");
    expect(fileLines[proposal.startLine - 1]).toBe("　外は暗かった。");
    expect(proposal.backup).toEqual(["　外は明るかった。"]);
  });

  it("本文の在り処を1か所に決められなければ、提案にせず記録にだけ残すと言う", () => {
    const local = EPISODES.map((spec) =>
      spec.n === 2 ? { ...spec, body: ["　手元の文。"] } : spec
    );
    const sources = splitSources(local).map((source) =>
      source.relPath === "本文/0002.txt"
        ? // 同じ本文が2度書いてあるファイル（どちらを直すか決められない）
          { ...source, text: `${source.text}\n【後書き】\n　手元の文。`, hash: "h" }
        : { ...source, hash: "h" }
    );

    const result = plan(sources);

    expect(result.bodyDiffs[0].bodyLineOffset).toBeNull();
    expect(hunkProposalsOf(result.bodyDiffs[0])).toEqual([]);
    const text = describeMergePlan(result, { proposals: true }).join("\n");
    expect(text).not.toContain("提案パネルに並べます");
    expect(text).toContain("違いを「バックアップとの違い」に書き出します");
  });

  it("手元が合本でも、話ごとに比べる", () => {
    const local = EPISODES.map((spec) =>
      spec.n === 3 ? { ...spec, body: ["　外は暗かった。"] } : spec
    );

    const result = plan(collectedSource(local));

    expect(result.bodyDiffs.map((diff) => diff.order)).toEqual([3]);
    expect(result.bodyDiffs[0].relPath).toBe("本文/N5078JI.txt");
  });

  it("手元に無い話は数えるだけで、取り込まない", () => {
    const result = plan(splitSources(EPISODES.slice(0, 2)));

    expect(result.unmatched).toBe(1);
    expect(describeMergePlan(result).join("\n")).toContain("手元に見当たらない話が1話");
  });

  it("**競合の印があるファイルは比べない**", () => {
    const sources = splitSources(EPISODES);
    sources[1] = {
      ...sources[1],
      text: [SEP(2), "【本文】", "<<<<<<< HEAD", "　あ", "=======", "　い", ">>>>>>> theirs", ""].join("\n"),
    };

    const result = plan(sources);

    expect(result.conflicted).toEqual(["本文/0002.txt"]);
    expect(result.bodyDiffs).toEqual([]);
    expect(describeMergePlan(result).join("\n")).toContain("競合");
    // **競合の印のあるファイルには提案を作らない**（違いとして数えないので、並ぶものが無い）
    expect(countProposableHunks(result.bodyDiffs)).toBe(0);
  });

  it("同じ番号の話が手元に2つあれば、どちらとも比べない", () => {
    const result = plan([...splitSources(EPISODES), ...collectedSource(EPISODES)]);

    expect(result.ambiguousLocal).toBe(3);
    expect(result.bodyDiffs).toEqual([]);
  });

  it("CRLF の手元でも、行末の違いだけなら同じと見る", () => {
    const sources = splitSources(EPISODES).map((source) => ({
      ...source,
      text: (source.text ?? "").split("\n").join("\r\n"),
    }));

    expect(plan(sources).bodyDiffs).toEqual([]);
  });
});

describe("行の比べ方", () => {
  it("行末の空白は違いに数えない", () => {
    expect(diffBodies("　あいう　\nかき", "　あいう\nかき  ")).toEqual([]);
  });

  it("**行頭の全角空白（字下げ）は違いに数える**", () => {
    expect(diffBodies("　あいう", "あいう")).toEqual([
      { localLine: 1, local: ["　あいう"], backup: ["あいう"] },
    ]);
  });

  it("足された行・消えた行を、手元の何行目かと一緒に返す", () => {
    const local = ["一", "二", "三", "四"].join("\n");
    const backup = ["一", "二", "挿入", "三"].join("\n");

    expect(diffBodies(local, backup)).toEqual([
      { localLine: 3, local: [], backup: ["挿入"] },
      { localLine: 4, local: ["四"], backup: [] },
    ]);
  });
});

describe("見せる言葉", () => {
  it("足すものが無く違いも無ければ、空の計画と分かる", () => {
    let ledger = emptyPostingLedger();
    const first = plan(splitSources(EPISODES), { ledger });
    for (const record of first.readerStats) ledger = withReaderStats(ledger, record);
    ledger = { ...ledger, siteProfiles: [{ site: "narou", workId: "n5078ji" }] };

    const again = plan(splitSources(EPISODES), {
      ledger,
      chapters: [{ name: "主治医", startEpisodePath: "本文/0001.txt" }],
    });

    expect(isEmptyMergePlan(again)).toBe(true);
  });

  it("結果の一文は、章・いいね・本文の違いを短く並べる", () => {
    expect(
      summarizeMergeResult({
        workTitle: "コールドスリープ",
        chapters: 7,
        likesEpisodes: 219,
        workStats: false,
        bodyDiffs: 3,
        recorded: true,
      })
    ).toBe(
      "「コールドスリープ」へ取り込みました：章7・いいね219話ぶん・本文の違い3話（記録に残しました。原稿は書き換えていません）"
    );
  });

  it("提案パネルに並べたときは、並べた数と「まだ書き換えていない」を言う", () => {
    expect(
      summarizeMergeResult({
        workTitle: "コールドスリープ",
        chapters: 0,
        likesEpisodes: 0,
        workStats: false,
        bodyDiffs: 2,
        recorded: true,
        proposals: 5,
      })
    ).toBe(
      "「コールドスリープ」へ取り込みました：本文の違い2話（5か所を提案パネルに並べました。原稿はまだ書き換えていません）"
    );
  });

  it("違いの記録は、手元を -、バックアップを + で並べる", () => {
    const record = buildBackupDiffRecord({
      workTitle: "コールドスリープ",
      sourceName: "N5078JI.zip",
      diffs: [
        {
          label: "2話　検査",
          relPath: "本文/0002.txt",
          hunks: [{ localLine: 1, local: ["　手元"], backup: ["　サイト"] }],
        },
      ],
    });

    expect(record).toContain("## 2話　検査（本文/0002.txt）");
    expect(record).toContain("- 　手元");
    expect(record).toContain("+ 　サイト");
    expect(record).toContain("原稿は書き換えていません");
  });

  it("バックアップの話の見出しと章の題を、取り込みと同じ部品で読む", () => {
    const episodes = backupEpisodesOf(narouInspection());

    expect(episodes.map((episode) => [episode.order, episode.label, episode.part])).toEqual([
      [1, "1話　目覚め", "主治医"],
      [2, "2話　検査", null],
      [3, "3話　外へ", "学園"],
    ]);
  });
});
