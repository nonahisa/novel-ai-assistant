import { describe, expect, it } from "vitest";
import {
  findContradictionCandidates,
  findIdentityDrift,
} from "../../src/core/contradictionMatch";
import type { SceneIdentity } from "../../src/models/identity";
import type { IdentityTransition } from "../../src/models/storyFact";

/**
 * 同一性の照合（設計書6.88.5）。
 *
 * **憑依・多重人格・転生・入れ替わりを矛盾にしない**のがこの段の狙いで、
 * 裏返して**遷移の記録が無いのに組が変わっていれば出す**。
 * 太志（`persona_太志`）が文佳の体（`body_文佳`）へ入る形で並べてある。
 */

function scene(options: {
  source: string;
  chapter: number;
  line?: number;
  body?: string;
  persona: string;
  identity?: string;
}): SceneIdentity {
  const line = options.line ?? 1;
  return {
    chapter: options.chapter,
    lineRange: [line, line],
    storyTime: null,
    triple: {
      bodyId: options.body ?? "body_文佳",
      personaId: options.persona,
      identityId: options.identity ?? options.persona,
    },
    source: options.source,
  };
}

function transition(options: {
  kind: IdentityTransition["kind"];
  chapter: number;
  line?: number;
  body?: string;
  subject: string;
  toPersona?: string;
  identity?: string | null;
}): IdentityTransition {
  return {
    subject: options.subject,
    kind: options.kind,
    at: {
      storyTime: null,
      chapter: options.chapter,
      line: options.line ?? 1,
    },
    ...(options.body === undefined ? {} : { body: options.body }),
    ...(options.toPersona === undefined ? {} : { toPersona: options.toPersona }),
    ...(options.identity === undefined ? {} : { identity: options.identity }),
  };
}

/** 同じ体で、人格が文佳から太志へ変わる2場面 */
const possessed: SceneIdentity[] = [
  scene({ source: "s1", chapter: 3, persona: "persona_文佳" }),
  scene({ source: "s2", chapter: 5, persona: "persona_太志" }),
];

describe("遷移があれば、組の変化は矛盾ではない", () => {
  it("憑依：possession の遷移があれば候補にしない", () => {
    const transitions = [
      transition({
        kind: "possession",
        chapter: 4,
        body: "body_文佳",
        subject: "persona_太志",
      }),
    ];
    expect(findIdentityDrift(possessed, transitions)).toEqual([]);
  });

  it("多重人格：switch の遷移があれば候補にしない", () => {
    const transitions = [
      transition({
        kind: "switch",
        chapter: 4,
        body: "body_文佳",
        subject: "persona_太志",
      }),
    ];
    expect(findIdentityDrift(possessed, transitions)).toEqual([]);
  });

  it("転生：reincarnation の遷移があれば候補にしない", () => {
    const transitions = [
      transition({
        kind: "reincarnation",
        chapter: 4,
        body: "body_文佳",
        subject: "persona_太志",
      }),
    ];
    expect(findIdentityDrift(possessed, transitions)).toEqual([]);
  });

  it("入れ替わり：swap の遷移があれば候補にしない", () => {
    const transitions = [
      transition({
        kind: "swap",
        chapter: 4,
        body: "body_文佳",
        subject: "persona_太志",
      }),
    ];
    expect(findIdentityDrift(possessed, transitions)).toEqual([]);
  });

  it("転生で体ごと変わるときは、体が違うので比べない", () => {
    // 新しい体に1場面しか無ければ隣り合う場面が無く、そもそも組の変化が起きない
    const scenes = [
      scene({ source: "s1", chapter: 3, persona: "persona_太志" }),
      scene({
        source: "s2",
        chapter: 9,
        body: "body_転生後",
        persona: "persona_太志",
      }),
    ];
    expect(findIdentityDrift(scenes, [])).toEqual([]);
  });

  it("体の書かれていない遷移は、体を問わずに効かせる", () => {
    // 分からない項目で照合を厳しくすると、正当な憑依が矛盾として出る
    const transitions = [
      transition({ kind: "possession", chapter: 4, subject: "persona_太志" }),
    ];
    expect(findIdentityDrift(possessed, transitions)).toEqual([]);
  });

  it("toPersona を書いた遷移も、前に出る人格で突き合わせる", () => {
    const transitions = [
      transition({
        kind: "possession",
        chapter: 4,
        body: "body_文佳",
        subject: "persona_太志の霊",
        toPersona: "persona_太志",
      }),
    ];
    expect(findIdentityDrift(possessed, transitions)).toEqual([]);
  });
});

describe("遷移が無ければ、組の変化は候補になる", () => {
  it("同じ体で人格が変わっているのに遷移が無い", () => {
    const candidates = findIdentityDrift(possessed, []);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].type).toBe("状態");
    expect(candidates[0].subject).toBe("body_文佳");
    expect(candidates[0].predicate).toBe("人格");
    expect(candidates[0].left).toBe("s1");
    expect(candidates[0].right).toBe("s2");
    expect(candidates[0].reason).toContain(
      "遷移の記録が無いのに、同じ体で人格が〈persona_文佳〉から〈persona_太志〉へ変わっている"
    );
  });

  it("遷移が別の体のものなら効かない", () => {
    const transitions = [
      transition({
        kind: "possession",
        chapter: 4,
        body: "body_別人",
        subject: "persona_太志",
      }),
    ];
    expect(findIdentityDrift(possessed, transitions)).toHaveLength(1);
  });

  it("遷移が2場面のあいだに無ければ効かない", () => {
    // 変わったあとで記録された遷移は、その変化を説明しない
    const transitions = [
      transition({
        kind: "possession",
        chapter: 9,
        body: "body_文佳",
        subject: "persona_太志",
      }),
    ];
    expect(findIdentityDrift(possessed, transitions)).toHaveLength(1);
  });

  it("遷移の行き先が別の人格なら効かない", () => {
    const transitions = [
      transition({
        kind: "possession",
        chapter: 4,
        body: "body_文佳",
        subject: "persona_第三者",
      }),
    ];
    expect(findIdentityDrift(possessed, transitions)).toHaveLength(1);
  });

  it("身分だけが変わる（偽名）ときも、遷移が無ければ候補にする", () => {
    const scenes = [
      scene({
        source: "s1",
        chapter: 3,
        persona: "persona_太志",
        identity: "identity_太志",
      }),
      scene({
        source: "s2",
        chapter: 5,
        persona: "persona_太志",
        identity: "identity_黒衣の男",
      }),
    ];
    const candidates = findIdentityDrift(scenes, []);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].predicate).toBe("身分");
    expect(candidates[0].reason).toContain(
      "同じ体で身分が〈identity_太志〉から〈identity_黒衣の男〉へ変わっている"
    );
  });

  it("身分の変化は、identity を書いた遷移があれば候補にしない", () => {
    const scenes = [
      scene({
        source: "s1",
        chapter: 3,
        persona: "persona_太志",
        identity: "identity_太志",
      }),
      scene({
        source: "s2",
        chapter: 5,
        persona: "persona_太志",
        identity: "identity_黒衣の男",
      }),
    ];
    const transitions = [
      transition({
        kind: "swap",
        chapter: 4,
        body: "body_文佳",
        subject: "persona_太志",
        identity: "identity_黒衣の男",
      }),
    ];
    expect(findIdentityDrift(scenes, transitions)).toEqual([]);
  });

  it("人格と身分が同時に変わっても、出すのは人格の1件だけ", () => {
    // 身分の違いは人格が変わった結果である。両方出すと同じ1か所を二度直させる
    const scenes = [
      scene({
        source: "s1",
        chapter: 3,
        persona: "persona_文佳",
        identity: "identity_文佳",
      }),
      scene({
        source: "s2",
        chapter: 5,
        persona: "persona_太志",
        identity: "identity_太志",
      }),
    ];
    const candidates = findIdentityDrift(scenes, []);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].predicate).toBe("人格");
  });

  it("組が変わらなければ何も出さない", () => {
    const scenes = [
      scene({ source: "s1", chapter: 3, persona: "persona_文佳" }),
      scene({ source: "s2", chapter: 5, persona: "persona_文佳" }),
      scene({ source: "s3", chapter: 7, persona: "persona_文佳" }),
    ];
    expect(findIdentityDrift(scenes, [])).toEqual([]);
  });

  it("場面は本文の順ではなく時期順に並べてから比べる", () => {
    // 入力の並びが前後していても、同じ1件が出る（並べ方は第1段と同じ）
    const scenes = [
      scene({ source: "s2", chapter: 5, persona: "persona_太志" }),
      scene({ source: "s1", chapter: 3, persona: "persona_文佳" }),
    ];
    const candidates = findIdentityDrift(scenes, []);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].left).toBe("s1");
    expect(candidates[0].right).toBe("s2");
  });
});

describe("すべての照合器を通す口からも出る", () => {
  it("scenes を渡すと同一性の候補が混ざる", () => {
    const candidates = findContradictionCandidates({
      facts: [],
      scenes: possessed,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].predicate).toBe("人格");
    expect(candidates[0].fingerprint).toHaveLength(40);
  });

  it("scenes を渡さなければ何も増えない", () => {
    expect(findContradictionCandidates({ facts: [] })).toEqual([]);
  });
});
