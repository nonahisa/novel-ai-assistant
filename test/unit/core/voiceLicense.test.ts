import { describe, expect, test } from "vitest";
import {
  buildCreditNotice,
  classifyLicense,
  engineBrandOf,
  licenseFileBody,
  licenseFileStem,
  parseAivmModels,
  parsePolicy,
  UNOFFICIAL_NOTE,
  type VoiceTerms,
} from "../../../src/core/voiceLicense";
import { FAKE_ACML_NC_TEXT, FAKE_ACML_TEXT, fakeAivmModels } from "../support/fakeVoiceEngine";

/**
 * 音声に書き出すときの、声のライセンス・規約（設計書6.42.4）。
 *
 * 作者の答え（2026-11-07 夜）：
 * - ライセンスの判別は**全文の見出し**で行う。知っているもの（ACML 1.0・ACML-NC 1.0・CC BY 系）だけ。
 *   知らない文は「分からない」として止める
 * - VOICEVOX は `policy` が取れればキャラクターの規約として扱い、クレジット「VOICEVOX:〈キャラ名〉」を必ず書く
 * - 注意書きには声ごとの要点と「※非公式です。話者本人・制作者とは関係ありません」
 * - 非商用の声が混じるときは、注意書きの先頭に書く
 */
describe("ライセンスの見分け（見出しで）", () => {
  test("ACML 1.0 は商用可・クレジット任意", () => {
    const known = classifyLicense(FAKE_ACML_TEXT);
    expect(known?.id).toBe("ACML-1.0");
    expect(known?.name).toBe("Aivis Common Model License (ACML) 1.0");
    expect(known?.commercial).toBe(true);
    expect(known?.credit).toBe("optional");
  });

  test("ACML-NC 1.0 は非商用", () => {
    const known = classifyLicense(FAKE_ACML_NC_TEXT);
    expect(known?.id).toBe("ACML-NC-1.0");
    expect(known?.commercial).toBe(false);
  });

  test("CC BY 系はクレジットが要る。NC が付けば非商用", () => {
    const by = classifyLicense("Attribution 4.0 International\n\n=======\n本文");
    expect(by?.id).toBe("CC-BY-4.0");
    expect(by?.credit).toBe("required");
    expect(by?.commercial).toBe(true);
    const nc = classifyLicense("Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International Public License\n本文");
    expect(nc?.id).toBe("CC-BY-NC-SA-4.0");
    expect(nc?.commercial).toBe(false);
  });

  test("知らない文・空は分からない（推し量らない）", () => {
    expect(classifyLicense("# 独自ライセンス\n自由に使ってください")).toBeUndefined();
    expect(classifyLicense("")).toBeUndefined();
    // 本文の途中に ACML の名があっても、見出しでなければ当てない
    expect(classifyLicense("# 利用規約\nAivis Common Model License (ACML) 1.0 に準じます")).toBeUndefined();
  });
});

describe("エンジンの見分け（/engine_manifest の brand_name）", () => {
  test("AivisSpeech と VOICEVOX を分け、ほかは分からない", () => {
    expect(engineBrandOf({ brand_name: "AivisSpeech", name: "AivisSpeech Engine" })?.brand).toBe("aivis");
    expect(engineBrandOf({ brand_name: "VOICEVOX", name: "VOICEVOX Engine" })?.brand).toBe("voicevox");
    expect(engineBrandOf({ brand_name: "COEIROINK" })).toBeUndefined();
    expect(engineBrandOf("x")).toBeUndefined();
  });
});

describe("/aivm_models と /speaker_info を読む", () => {
  test("話者の uuid から、モデル名・制作者・ライセンスの全文を引ける", () => {
    const models = parseAivmModels(fakeAivmModels({ mai: FAKE_ACML_TEXT, kanon: null }));
    const mai = models.find((m) => m.speakerUuids.includes("uuid-mai"));
    expect(mai?.name).toBe("まいモデル");
    expect(mai?.creators).toEqual(["まいモデルの制作者"]);
    expect(mai?.license).toBe(FAKE_ACML_TEXT);
    const kanon = models.find((m) => m.speakerUuids.includes("uuid-kanon"));
    expect(kanon?.license).toBeUndefined();
  });

  test("形の崩れたモデルは落とし、一覧が読めなければ空", () => {
    expect(parseAivmModels({ a: { manifest: "x" }, b: null })).toEqual([]);
    expect(parseAivmModels([])).toEqual([]);
  });

  test("policy は空なら取れなかった扱い", () => {
    expect(parsePolicy({ policy: "利用規約の本文" })).toBe("利用規約の本文");
    expect(parsePolicy({ policy: "   " })).toBeUndefined();
    expect(parsePolicy({})).toBeUndefined();
  });
});

const ACML = classifyLicense(FAKE_ACML_TEXT)!;
const ACML_NC = classifyLicense(FAKE_ACML_NC_TEXT)!;

const aivisMai: VoiceTerms = {
  kind: "aivis",
  speakerUuid: "uuid-mai",
  speakerName: "まい",
  styles: ["ノーマル", "上機嫌"],
  modelName: "まいモデル",
  creators: ["まいモデルの制作者"],
  license: ACML,
  licenseText: FAKE_ACML_TEXT,
  policy: "まいの規約",
};

describe("注意書き（クレジットと利用条件.txt）", () => {
  const base = {
    workTitle: "鉛の海",
    episodeName: "01",
    engineName: "AivisSpeech",
    at: new Date("2026-11-08T10:00:00+09:00"),
  };

  test("声ごとに、話者・スタイル・モデル名・制作者・ライセンス名と全文の場所を並べ、非公式の一文を添える", () => {
    const text = buildCreditNotice({
      ...base,
      voices: [{ terms: aivisMai, licenseFile: "ライセンス/まいモデル.txt" }],
    });
    expect(text).toContain(UNOFFICIAL_NOTE);
    expect(UNOFFICIAL_NOTE).toBe("※非公式です。話者本人・制作者とは関係ありません。");
    expect(text).toContain("まい");
    expect(text).toContain("ノーマル・上機嫌");
    expect(text).toContain("まいモデル");
    expect(text).toContain("まいモデルの制作者");
    expect(text).toContain("Aivis Common Model License (ACML) 1.0");
    expect(text).toContain("ライセンス/まいモデル.txt");
    // 要点（作者の答えの ACML 1.0 の要点）
    expect(text).toContain("営利・非営利とも使えます");
    expect(text).toContain("クレジットは任意");
    // 非商用の断りは、非商用の声が無ければ出さない
    expect(text).not.toContain("非商用のみ");
  });

  test("非商用の声が混じれば、先頭に書く", () => {
    const nc: VoiceTerms = { ...aivisMai, speakerName: "花音", modelName: "花音モデル", license: ACML_NC };
    const text = buildCreditNotice({
      ...base,
      voices: [
        { terms: aivisMai, licenseFile: "ライセンス/まいモデル.txt" },
        { terms: nc, licenseFile: "ライセンス/花音モデル.txt" },
      ],
    });
    const firstLines = text.split("\n").slice(0, 3).join("\n");
    expect(firstLines).toContain("非商用のみ");
    expect(firstLines).toContain("花音");
  });

  test("VOICEVOX は「VOICEVOX:キャラ名」のクレジットを必ず書く", () => {
    const vv: VoiceTerms = {
      kind: "voicevox",
      speakerUuid: "uuid-zunda",
      speakerName: "ずんだもん",
      styles: ["ノーマル"],
      policy: "ずんだもんの規約の本文",
    };
    const text = buildCreditNotice({
      ...base,
      engineName: "VOICEVOX",
      voices: [{ terms: vv, licenseFile: "ライセンス/ずんだもん.txt" }],
    });
    expect(text).toContain("VOICEVOX:ずんだもん");
    expect(text).toContain("https://voicevox.hiroshiba.jp/term/");
    expect(text).toContain(UNOFFICIAL_NOTE);
  });
});

describe("全文のファイル", () => {
  test("AivisSpeech はモデル名、VOICEVOX は話者名で名前を付ける。使えない字は置き換える", () => {
    expect(licenseFileStem(aivisMai)).toBe("まいモデル");
    expect(licenseFileStem({ ...aivisMai, modelName: "A/B:C" })).toBe("A／B：C");
    expect(
      licenseFileStem({ kind: "voicevox", speakerUuid: "u", speakerName: "ずんだもん", styles: [], policy: "p" })
    ).toBe("ずんだもん");
  });

  test("全文はライセンスをそのまま、話者の規約があれば後ろに添える", () => {
    const body = licenseFileBody(aivisMai);
    expect(body).toContain(FAKE_ACML_TEXT.trim());
    expect(body).toContain("まいの規約");
    expect(body.indexOf(FAKE_ACML_TEXT.trim())).toBeLessThan(body.indexOf("まいの規約"));
  });
});
