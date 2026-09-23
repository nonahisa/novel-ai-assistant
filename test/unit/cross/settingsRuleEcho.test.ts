import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import {
  BASE_SYSTEM_PROMPT,
  buildCharacterExtractPrompt,
} from "../../../src/prompts/characterExtract";
import {
  dropInstructionEcho,
  isInstructionEcho,
  mergeAbilitySystemRules,
} from "../../../src/core/settingsExtractionValidation";
import { SettingsExtractionCollector } from "../../../src/core/settingsExtractionCollect";
import type { Chunk } from "../../../src/core/chunker";
import type { CharacterExtractResult } from "../../../src/prompts/characterExtract";

/*
  2026-09-19 の実機確認（さくらのAI / preview/Qwen3.6-35B-A3B）で、
  `設定/ability_system.json` の rules へ**プロンプトの指示文がそのまま6文**
  入って保存された。指示の言葉が答えの中身として返ってくるのは、この作品で
  繰り返し起きていることである（CLAUDE.md）。

  **言い回しの表では捕まえない。** 表に無い言い方で返ってきた時点で素通りする
  （直前に関係の検算で追いかけっこになった）。ここで見るのは
  「送ったプロンプトの指示のところに、ほぼそのまま入っているか」だけである。
*/

/** 実機で保存されてしまった6文（`設定/ability_system.json` より） */
const LEAKED = [
  "能力体系を創作したり、本文にない能力を補ったりしないこと。",
  "能力名は本文の表記をそのまま使うこと。",
  "効果・代償・制約は本文から読み取れる範囲だけを書くこと。",
  "誰が使ったか分かる場合は userNames に人物名を入れること。",
  "剣術・話術のような一般的な技量は、作品世界で特別な力として扱われている場合にのみ抽出すること。",
  "abilitySystem.abilityTerm には、作品世界の中で能力を総称している語を、本文の表記のまま入れてください。",
];

/** 同じ回に混ざっていた、本文から読み取った本物の決まり */
const GENUINE = [
  "聖紋は対象に刻印することで効力を発揮する。",
  "空中に多数の聖紋を浮かべ、短時間で同時発動できる家系が存在する。",
];

const chunk: Chunk = {
  filePath: "001.txt",
  index: 0,
  text: "聖紋を刻む。",
  startLine: 0,
  hash: "fixture",
  chapterStart: 1,
  chapterEnd: 1,
};

describe("能力体系の決まりに混ざった指示文", () => {
  test("実機で保存された6文をすべて落とす", () => {
    for (const rule of LEAKED) {
      expect(isInstructionEcho(rule), rule).toBe(true);
    }
  });

  test("本文から読み取った決まりは残す", () => {
    for (const rule of GENUINE) {
      expect(isInstructionEcho(rule), rule).toBe(false);
    }
  });

  test("AIが末尾を削って返した指示文も落とす", () => {
    // 実機の6文目と同じ削り方（強調の記号を外し、続きの一文を落とした形）
    expect(
      isInstructionEcho(
        "能力名は本文の表記をそのまま使うこと。ルビがあれば reading に入れること"
      )
    ).toBe(true);
    expect(
      isInstructionEcho("本文中で実際に使用された能力だけを抽出すること")
    ).toBe(true);
  });

  test("総称が決まっている回の言い回しも落とす", () => {
    // 総称が確定していると、プロンプトの文面そのものが変わる。
    // 作品の語（ここでは「聖紋」）が挟まるので、素の一致では通り抜ける
    expect(
      isInstructionEcho(
        "この作品では能力を「聖紋」と総称します。abilitySystem.abilityTerm には同じ語を使ってください。",
        "聖紋"
      )
    ).toBe(true);
  });

  test("短い決まりは落とさない", () => {
    // 十数文字しかない文は、たまたま指示文と重なることがある。
    // **落とすほうを控えめにする**（本物の決まりを消すほうが害が大きい）
    expect(isInstructionEcho("本文に無い能力は使えない")).toBe(false);
    expect(isInstructionEcho("聖紋は消えない")).toBe(false);
  });

  test("落とした件数と中身を返す", () => {
    const result = dropInstructionEcho([...LEAKED, ...GENUINE]);
    expect(result.kept).toEqual(GENUINE);
    expect(result.dropped).toEqual(LEAKED);
  });
});

describe("見逃しと誤検出を測る", () => {
  /*
    **片方だけでは、何も落とさない実装が満点になる**（CLAUDE.md）。
    そこで両側から測る。

    - 見逃し：プロンプトの指示のところを1文ずつ取り出し、そのまま返した
      場合と、**真ん中を2割削って**返した場合の両方で落とせるか
    - 誤検出：この作品に入っている小説の本文（fixtures）を1文ずつ通して、
      1件も落とさないか

    測った結果（2026-09-19）：24字以上の指示文 146文は、そのままでも
    2割削っても 146文すべて落とせた。本文の文 573文からは1件も落ちて
    いない。**あいだが広いので、境目の値を多少動かしても結果は変わらない。**
  */
  const normalizeText = (text: string): string =>
    text.replace(/[*＊_`#]/gu, "").replace(/\s+/gu, "");

  const sentencesOf = (text: string, min: number): string[] =>
    text
      .split(/[。\n]/u)
      .map((line) => line.replace(/^[\s\-0-9．.、・]+/u, "").trim())
      .filter((line) => normalizeText(line).length >= min);

  const instructionSentences = (): string[] =>
    sentencesOf(
      `${BASE_SYSTEM_PROMPT}\n${buildCharacterExtractPrompt({
        chunkText: "",
        chapterLabel: "",
        knownCharacterNames: [],
      })}`,
      // 決まりとして返ってくるのは、ひと続きの文である。
      // 折り返しの断片まで数えると、測っているものがぼやける
      24
    );

  test("指示文は、そのまま返されても2割削られても落ちる", () => {
    const sentences = instructionSentences();
    expect(sentences.length).toBeGreaterThan(50);

    const missed = sentences.filter((line) => !isInstructionEcho(line));
    expect(missed).toEqual([]);

    const trimmed = sentences.map((line) => {
      const cut = Math.max(1, Math.floor(line.length * 0.2));
      const start = Math.floor((line.length - cut) / 2);
      return line.slice(0, start) + line.slice(start + cut);
    });
    expect(trimmed.filter((line) => !isInstructionEcho(line))).toEqual([]);
  });

  test("小説の本文からは1件も落とさない", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(`${dir}/${entry.name}`)
          : entry.name.endsWith(".txt")
            ? [`${dir}/${entry.name}`]
            : []
      );
    const prose = walk("test/fixtures").flatMap((file) =>
      sentencesOf(readFileSync(file, "utf8"), 16)
    );
    expect(prose.length).toBeGreaterThan(100);
    expect(prose.filter((line) => isInstructionEcho(line))).toEqual([]);
  });
});

describe("保存のときに、古い指示文も落とす", () => {
  /*
    0.69.2 の検算は「これから保存するもの」しか見ていなかったので、**実機で
    既に `設定/ability_system.json` へ入ってしまった6文は、何度抽出し直しても
    残った**（`persistAbilitySystem` が `rules` を積み増すだけだったため）。

    作者の裁定は「保存のときに落とす」。ここで確かめるのは、
    **作者の作品にいま入っている6文が、次の抽出で消えること**である。
  */

  /** 作者の作品の、いまの `設定/ability_system.json`（6文＋本物2文） */
  const SAVED = [...LEAKED, ...GENUINE];

  test("作者の作品に入っている6文は、次の抽出で消える", () => {
    const merged = mergeAbilitySystemRules(SAVED, [], "聖紋");
    for (const rule of LEAKED) {
      expect(merged.rules, rule).not.toContain(rule);
    }
    expect(merged.droppedFromSaved).toEqual(LEAKED);
  });

  test("本文から読み取った決まりは、保存済みのぶんも残る", () => {
    const merged = mergeAbilitySystemRules(SAVED, [], "聖紋");
    expect(merged.rules).toEqual(GENUINE);
  });

  test("今回読み取った決まりを足す。並びは保存済みが先", () => {
    const fresh = "聖紋は水に触れると消える。";
    const merged = mergeAbilitySystemRules(SAVED, [fresh], "聖紋");
    expect(merged.rules).toEqual([...GENUINE, fresh]);
  });

  test("同じ決まりを二重に持たない", () => {
    const merged = mergeAbilitySystemRules(GENUINE, [...GENUINE], "聖紋");
    expect(merged.rules).toEqual(GENUINE);
    expect(merged.droppedFromSaved).toEqual([]);
  });

  test("掃除するものが無ければ、件数は0のまま", () => {
    // **毎回「N件外しました」と出ないこと。** 直ったことが伝わらなくなる
    const merged = mergeAbilitySystemRules(GENUINE, [], "聖紋");
    expect(merged.droppedFromSaved).toEqual([]);
  });

  test("総称が決まっている回の言い回しも、保存済みから落とす", () => {
    const withTerm =
      "この作品では能力を「聖紋」と総称します。abilitySystem.abilityTerm には同じ語を使ってください。";
    const merged = mergeAbilitySystemRules([withTerm, ...GENUINE], [], "聖紋");
    expect(merged.droppedFromSaved).toEqual([withTerm]);
    expect(merged.rules).toEqual(GENUINE);
  });
});

describe("抽出の集約", () => {
  const resultWith = (rules: string[]): CharacterExtractResult =>
    ({
      characters: [],
      abilitySystem: { abilityTerm: "聖紋", description: null, rules },
    }) as unknown as CharacterExtractResult;

  test("指示文は決まりへ入れず、除外として数える", () => {
    const collector = new SettingsExtractionCollector();
    collector.collect(resultWith([...LEAKED, ...GENUINE]), chunk);

    const candidates = collector.candidates();
    expect(candidates.rules).toEqual(GENUINE);
    const echoed = candidates.rejected.filter(
      (item) => item.reason === "instruction_echo"
    );
    expect(echoed).toHaveLength(LEAKED.length);
    expect(echoed[0].name).toBe(LEAKED[0]);
  });
});
