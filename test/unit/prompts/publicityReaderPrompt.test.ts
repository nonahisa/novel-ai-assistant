import { describe, expect, test } from "vitest";
import {
  READER_TYPES,
  resolveReaderType,
  type ReaderTypeId,
} from "../../../src/core/readerTarget";
import { resolvePublicityReader } from "../../../src/core/publicityReader";
import { buildReaderTypePrompt } from "../../../src/prompts/readerTarget";
import {
  BLURB_VERSION,
  blurbPromptVersion,
  buildBlurbPrompt,
  buildCatchphrasePrompt,
  type BlurbPromptInput,
  type CatchphrasePromptInput,
} from "../../../src/prompts/blurb";
import {
  ANNOUNCE_VERSION,
  announcePromptVersion,
  buildAnnouncePrompt,
  type AnnouncePromptInput,
} from "../../../src/prompts/announce";
import type { ReaderProfile } from "../../../src/models/readerProfile";

/**
 * 紹介文（P-06）・キャッチコピー（P-08）・告知文（P-30）へ、狙いの読者を
 * 添える（作者の問い、2026-09-23）。
 *
 * **見張ること**
 * 1. 渡したときだけ入る（未診断・狙い無しでは1字も足さない）
 * 2. 渡した層だけが入る（11層ぶんを並べると、どの層にも効く言い方が
 *    決まらない。P-41 と同じ）
 * 3. 層の呼び名を文章に書かせない指示がある（指示語が答えに返る——
 *    CLAUDE.md の失敗3。出力側の見張りは `core/publicityReaderLeak.test.ts`）
 * 4. 版と、読者の印が版に混ざること（規則4）
 */

const DECLARED: ReaderProfile = {
  schemaVersion: "1",
  declared: {
    scores: { familiarity: 6, posture: 1, craving: 1 },
    answers: [],
    updatedAt: "2026-09-20T00:00:00.000Z",
  },
};

const AIM = resolvePublicityReader({
  authorBlock: "狙い：考察層、没入層\n理由：伏線を拾ってくれる人に読んでほしい",
})!;
const PROFILE = resolvePublicityReader({ profile: DECLARED })!;

function blurbInput(over: Partial<BlurbPromptInput> = {}): BlurbPromptInput {
  return {
    workTitle: "図書塔の魔女",
    plot: "",
    openingExcerpt: "本文の抜粋。",
    chapterSynopses: [],
    ...over,
  };
}

function catchInput(
  over: Partial<CatchphrasePromptInput> = {}
): CatchphrasePromptInput {
  return {
    workTitle: "図書塔の魔女",
    plot: "",
    blurb: "",
    openingExcerpt: "本文の抜粋。",
    rejected: [],
    ...over,
  };
}

function announceInput(
  over: Partial<AnnouncePromptInput> = {}
): AnnouncePromptInput {
  return {
    workTitle: "図書塔の魔女",
    episodeLabel: "第3話「灯を継ぐ」",
    blurb: "",
    previousSynopsis: "",
    bodyExcerpt: "本文の抜粋。",
    pastAnnouncements: [],
    ...over,
  };
}

const BUILDERS: Array<[string, (reader?: typeof AIM) => string]> = [
  ["紹介文", (reader) => buildBlurbPrompt(blurbInput({ reader }))],
  ["キャッチコピー", (reader) => buildCatchphrasePrompt(catchInput({ reader }))],
  ["告知文", (reader) => buildAnnouncePrompt(announceInput({ reader }))],
];

const ALL_LABELS = (Object.keys(READER_TYPES) as ReaderTypeId[]).map(
  (id) => READER_TYPES[id].label
);

describe.each(BUILDERS)("%s", (_name, build) => {
  test("読者の材料が無ければ、1字も足さない（今までどおり）", () => {
    const prompt = build(undefined);

    expect(prompt).not.toContain("【この作品の読者】");
    for (const label of ALL_LABELS) expect(prompt).not.toContain(label);
    expect(prompt).not.toContain("届く言い方");
  });

  test("狙いがあれば、選んだ層と作者の理由が入る", () => {
    const prompt = build(AIM);

    expect(prompt).toContain("【この作品の読者】");
    expect(prompt).toContain(READER_TYPES.lore_deep.label);
    expect(prompt).toContain(READER_TYPES.deep_pure.label);
    expect(prompt).toContain(READER_TYPES.lore_deep.works);
    expect(prompt).toContain("伏線を拾ってくれる人に読んでほしい");
    expect(prompt).toContain("届く言い方");
  });

  test("選んでいない層の名前は入らない", () => {
    const prompt = build(AIM);

    for (const id of Object.keys(READER_TYPES) as ReaderTypeId[]) {
      if (id === "lore_deep" || id === "deep_pure") continue;
      expect(prompt, id).not.toContain(READER_TYPES[id].label);
    }
  });

  test("層の呼び名を文章に書かせない指示がある", () => {
    expect(build(AIM)).toContain("読者層の呼び名や説明の言葉は、文章に書かないこと");
    expect(build(PROFILE)).toContain("読者層の呼び名や説明の言葉は、文章に書かないこと");
  });

  test("狙いが無く読者像があれば、サブタイトルと同じ塊（buildReaderTypePrompt）を使う", () => {
    const prompt = build(PROFILE);

    expect(prompt).toContain(buildReaderTypePrompt(DECLARED)!);
    expect(prompt).toContain(
      READER_TYPES[resolveReaderType(DECLARED.declared!.scores)].label
    );
  });
});

describe("版", () => {
  test("紹介文・キャッチコピーは 1.2、告知文は 1.1（読者を添えたので上げた）", () => {
    expect(BLURB_VERSION).toBe("1.2");
    expect(ANNOUNCE_VERSION).toBe("1.1");
  });

  test("読者の印が版に混ざる（狙いを変えたら作り直す）", () => {
    expect(blurbPromptVersion("none")).toBe(`${BLURB_VERSION}|reader:none`);
    expect(blurbPromptVersion("aim:lore_deep")).not.toBe(
      blurbPromptVersion("aim:deep_pure")
    );
    expect(announcePromptVersion("none")).toBe(
      `${ANNOUNCE_VERSION}|reader:none`
    );
    expect(announcePromptVersion("lore_flow")).not.toBe(
      announcePromptVersion("none")
    );
  });
});
