import { describe, expect, test } from "vitest";
import {
  aivisDescriptionsOf,
  arrangeVoiceRows,
  countVoicePick,
  frequentVoiceKeys,
  groupFromDescription,
  usedVoiceKey,
  voiceGroupOf,
  VOICEVOX_SPEAKER_GROUPS,
  VOICE_GROUPS,
  type GroupableVoiceRow,
  type VoiceGroup,
} from "../../../src/core/voiceGroups";

/**
 * ［声の割り当て］の声を選ぶ窓の区切り（作者の頼み 2026-11-13「選択肢が長すぎるので、分類してわかりやすく」）。
 * 推し量りの見本は、作者の AivisSpeech の4つのモデルの説明（2026-11-13 に読んだ実物の字）。
 */

/** 作者の AivisSpeech の `/aivm_models` から、使う欄だけを写した形 */
const AUTHOR_AIVM_MODELS = {
  "m-kohaku": {
    manifest: {
      name: "コハク",
      description: "子猫のような甘い声。猫音コハク（©Oz Chat/Trippy）（CV: ねゆたろ）\nクレジットして頂ける際は「AivisSpeech: コハク」をご利用ください。",
      speakers: [{ name: "コハク", uuid: "u-kohaku" }],
    },
  },
  "m-mao": {
    manifest: {
      name: "まお",
      description: "いたずらっ子な小悪魔ボイス。卯畑まお（©Oz Chat/Trippy）（CV: ねゆたろ）",
      speakers: [{ name: "まお", uuid: "u-mao" }],
    },
  },
  "m-rotejin": {
    manifest: {
      name: "ろてじん（長老ボイス）",
      description: "老人の声を意識した演技でセリフ収録したボイスモデルです。",
      speakers: [{ name: "ろてじん（長老ボイス）", uuid: "u-rotejin" }],
    },
  },
  "m-aida": {
    manifest: {
      name: "阿井田 茂",
      description: "阿井田 茂（あいだ しげる）　\nCV：古山キリヲ\n\n通称：モアイさん\nバリトンボイスの朗らかおじさん",
      speakers: [{ name: "阿井田 茂", uuid: "u-aida" }],
    },
  },
};

describe("説明から区切りを推し量る（AivisSpeech）", () => {
  const descriptions = aivisDescriptionsOf(AUTHOR_AIVM_MODELS);
  const of = (uuid: string, name: string) => voiceGroupOf("aivisspeech", uuid, name, { descriptions });

  test("作者の4つのモデル：ろてじんは高齢、阿井田は男性。コハク（子猫のような）・まおは当たる語が無いので「その他」", () => {
    expect(of("u-rotejin", "ろてじん（長老ボイス）")).toBe("高齢");
    expect(of("u-aida", "阿井田 茂")).toBe("男性");
    // 「子猫のような」はたとえなので、人でないに入れない（誤当たりを止める）
    expect(of("u-kohaku", "コハク")).toBe("その他");
    expect(of("u-mao", "まお")).toBe("その他");
  });

  test("名前の括弧（長老ボイス）だけでも当たる（説明が取れなかったとき）", () => {
    expect(voiceGroupOf("aivisspeech", "u-x", "ろてじん（長老ボイス）")).toBe("高齢");
  });

  test("語の当て方：高齢を男性より先に、少女は子ども、ロボットは人でない、たとえの句は除く", () => {
    expect(groupFromDescription("優しいおじいさんの声")).toBe("高齢");
    expect(groupFromDescription("元気な少女の声")).toBe("子ども");
    expect(groupFromDescription("落ち着いた女性の声")).toBe("女性");
    expect(groupFromDescription("案内用のロボットです")).toBe("人でない（ロボット・動物など）");
    expect(groupFromDescription("中性的な声")).toBe("中性的");
    expect(groupFromDescription("少年みたいな女性の声")).toBe("女性");
    expect(groupFromDescription("明るい声")).toBeUndefined();
  });
});

describe("話者の区切り", () => {
  test("VOICEVOX は uuid の表で引く。表に無い uuid は「その他」", () => {
    expect(voiceGroupOf("voicevox", "468b8e94-9da4-4f7a-8715-a22a48844f9e", "ちび式じい")).toBe("高齢");
    expect(voiceGroupOf("voicevox", "4f51116a-d9ee-4516-925d-21f183e2afad", "青山龍星")).toBe("男性");
    expect(voiceGroupOf("voicevox", "not-in-table", "知らない話者")).toBe("その他");
  });

  test("表は作者の VOICEVOX の44話者を持ち、値はどれも区切りの名前", () => {
    expect(Object.keys(VOICEVOX_SPEAKER_GROUPS)).toHaveLength(44);
    for (const group of Object.values(VOICEVOX_SPEAKER_GROUPS)) expect(VOICE_GROUPS).toContain(group);
  });

  test("作者の speakerGroups が表と推し量りより先", () => {
    const overrides: Record<string, VoiceGroup> = {
      "468b8e94-9da4-4f7a-8715-a22a48844f9e": "男性",
      "u-kohaku": "女性",
    };
    expect(voiceGroupOf("voicevox", "468b8e94-9da4-4f7a-8715-a22a48844f9e", "ちび式じい", { overrides })).toBe("男性");
    expect(voiceGroupOf("aivisspeech", "u-kohaku", "コハク", { overrides })).toBe("女性");
  });

  test("AivisSpeech の声は VOICEVOX の表で引かない（uuid が同じでも）", () => {
    expect(voiceGroupOf("aivisspeech", "468b8e94-9da4-4f7a-8715-a22a48844f9e", "だれか")).toBe("その他");
  });
});

describe("よく使う声を数える", () => {
  test("エンジンと話者ごとに1ずつ足す。壊れた控えは捨てて数え直す", () => {
    expect(countVoicePick(undefined, "voicevox", "u1")).toEqual({ "voicevox|u1": 1 });
    expect(countVoicePick({ "voicevox|u1": 2 }, "voicevox", "u1")).toEqual({ "voicevox|u1": 3 });
    expect(countVoicePick({ "voicevox|u1": 2 }, "aivisspeech", "u1")).toEqual({ "voicevox|u1": 2, "aivisspeech|u1": 1 });
    expect(countVoicePick({ bad: "x", neg: -1, frac: 1.5 }, "voicevox", "u1")).toEqual({ "voicevox|u1": 1 });
    expect(countVoicePick([1, 2], "voicevox", "u1")).toEqual({ "voicevox|u1": 1 });
  });

  test("上位5つ。同じ回数は鍵の順で決める（開くたびに入れ替わらない）", () => {
    const counts = { a: 1, b: 5, c: 3, d: 3, e: 2, f: 9, g: 1 };
    expect(frequentVoiceKeys(counts)).toEqual(["f", "b", "c", "d", "e"]);
    expect(frequentVoiceKeys(undefined)).toEqual([]);
  });
});

describe("区切りで並べる", () => {
  const row = (engine: "voicevox" | "aivisspeech", uuid: string, label: string): GroupableVoiceRow => ({
    engine,
    speakerUuid: uuid,
    speakerName: label.split("／")[0],
    label,
  });
  const rows = [
    row("voicevox", "v-girl", "めたん"),
    row("voicevox", "v-man", "龍星"),
    row("voicevox", "v-man", "龍星／しっとり"),
    row("aivisspeech", "a-old", "ろてじん"),
    row("aivisspeech", "a-x", "まお"),
  ];
  const groups: Record<string, VoiceGroup> = { "v-girl": "女性", "v-man": "男性", "a-old": "高齢" };
  const groupOf = (r: GroupableVoiceRow): VoiceGroup => groups[r.speakerUuid] ?? "その他";

  test("この作品で使っている声が先頭、次によく使う声、そのあと声の印象の区切りの順。空の区切りは出さない", () => {
    const sections = arrangeVoiceRows(rows, {
      used: new Set([usedVoiceKey("voicevox", "v-man", "龍星／しっとり")]),
      frequent: ["aivisspeech|a-old", "voicevox|v-girl"],
      groupOf,
    });
    expect(sections.map((s) => [s.heading, s.rows.map((r) => r.label)])).toEqual([
      ["この作品で使っている声", ["龍星／しっとり"]],
      ["よく使う声", ["ろてじん", "めたん"]],
      ["女性", ["めたん"]],
      ["男性", ["龍星", "龍星／しっとり"]],
      ["高齢", ["ろてじん"]],
      ["その他", ["まお"]],
    ]);
  });

  test("使っている声もよく使う声も無ければ、声の印象の区切りだけ", () => {
    const sections = arrangeVoiceRows(rows, { used: new Set(), frequent: [], groupOf });
    expect(sections.map((s) => s.heading)).toEqual(["女性", "男性", "高齢", "その他"]);
  });

  test("使っている声は、エンジンが違えば別の声", () => {
    const sections = arrangeVoiceRows(rows, {
      used: new Set([usedVoiceKey("aivisspeech", "v-girl", "めたん")]),
      frequent: [],
      groupOf,
    });
    expect(sections[0].heading).toBe("女性");
  });
});
