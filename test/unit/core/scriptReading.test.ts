/**
 * 脚本モードの読み分け（core/scriptReading.ts）。
 * 作り物の38行と正解の札は、試作 `読み分けの台本.mjs` から写した。
 * 見逃しと誤検出の**両方**を数える（片方だけだと、何も読まない実装が満点になる）。
 */
import { describe, expect, it } from "vitest";
import {
  nextKindOnTab,
  readScriptLine,
  readScriptText,
  SCRIPT_ALT_KEY_KINDS,
  switchKindOf,
  switchScriptLineKind,
  type ScriptSwitchKind,
} from "../../../src/core/scriptReading";
import { classifyScriptLine, splitSerifu } from "../../../src/core/scriptLines";

const ZS = "　";
type Gold = "hashira" | "togaki" | "serifu" | "cue" | "memo" | "blank" | null;
type Status = "sure" | "fix" | "ask";

const SAMPLE: [string, Gold, Status][] = [
  ["○古書店「ふくろう堂」・店内（夜）", "hashira", "sure"],
  [ZS + "雨音。棚の間を、千尋が濡れた傘を提げて歩いてくる。", "togaki", "sure"],
  ["千尋「すみません、まだ開いてますか」", "serifu", "sure"],
  ["店主（奥から）「開いてるよ。閉める気がしないだけで」", "serifu", "sure"],
  [ZS + "千尋、レジの前で立ち止まる。", "togaki", "sure"],
  ["千尋：この本、探してたんです", "serifu", "fix"],
  ["店主: どれどれ", "serifu", "fix"],
  ["  店主、眼鏡を額へ押し上げる。", "togaki", "fix"],
  ["「それ、売り物じゃないんだ」", null, "ask"],
  ["千尋「え」", "serifu", "sure"],
  ["SE" + ZS + "遠くで雷", "cue", "fix"],
  ["千尋（Ｍ）「やっぱり、ここにあった」", "serifu", "sure"],
  ["// 店主の名前、まだ決めてない", "memo", "sure"],
  ["", "blank", "sure"],
  ["×" + ZS + ZS + "×" + ZS + ZS + "×", "cue", "fix"],
  ["◯同・店の外（夜）", "hashira", "fix"],
  [ZS + "軒下で、遠野が雨宿りしている。", "togaki", "sure"],
  ["遠野の声「千尋さん、傘、二本ある？」", "serifu", "sure"],
  ["千尋が振り向くと、遠野は「やっぱりな」と笑った。", null, "ask"],
  ["遠野「雨、強くなるってさ」", "serifu", "sure"],
  ["商店街・アーケード（夜）", "hashira", "fix"],
  [ZS + "シャッターの閉まった店が続く。", "togaki", "sure"],
  ["二人、並んで歩く。", "togaki", "fix"],
  ["千尋「ねえ」", "serifu", "sure"],
  ["遠野「ん」", "serifu", "sure"],
  ["千尋「さっきの本の持ち主、知ってる？」", "serifu", "sure"],
  ["遠野、答えない。", "togaki", "fix"],
  ["Ｎ「その本の最後の頁には、誰かの名前が書いてあった」", "serifu", "sure"],
  ["注意：この場面はあとで差し替える", null, "ask"],
  ["回想・十年前の店内（昼）", "hashira", "fix"],
  [ZS + "幼い千尋が、店主の膝で絵本を読んでいる。", "togaki", "sure"],
  ["店主「その本はね、まだ途中なんだ」", "serifu", "sure"],
  ["とても長い名前の登場人物さん「こんにちは」", null, "ask"],
  ["Ｍ" + ZS + "雨の音が遠ざかる", "cue", "fix"],
  ["{千尋|ちひろ}「行こう」", "serifu", "sure"],
  ["○同・店の外（夜）", "hashira", "sure"],
  [ZS + "雨が上がっている。", "togaki", "sure"],
  ["それで店主は「またおいで」", null, "ask"],
];

/** 読みを、試作の正解の札と同じ言い方へ直す */
function goldKindOf(r: ReturnType<typeof readScriptLine>): Gold {
  if (r.kind === "unsure") return null;
  if (r.kind === "togaki" && r.cue) return "cue";
  return r.kind;
}

describe("試作の38行（正解の札あり）", () => {
  const text = SAMPLE.map((s) => s[0]).join("\n");
  // 設定資料の人物は渡さない（本文の確かな台詞から作る道だけで足りることも見る）
  const result = readScriptText(text, []);

  it("行数が合う", () => {
    expect(result.lines).toHaveLength(SAMPLE.length);
  });

  it("見逃し0・誤検出0・迷うべき5行がすべて迷い", () => {
    let wrong = 0; // 見逃しも誤検出も、読みが札と違う行として数える
    let askRight = 0;
    const misses: string[] = [];
    SAMPLE.forEach(([line, gold, status], i) => {
      const r = result.lines[i];
      if (status === "ask") {
        if (r.confidence === "unsure") askRight++;
        else misses.push(`${i + 1}行目 迷うべきを決めた: ${line}`);
        return;
      }
      const same = goldKindOf(r) === gold;
      const confOk =
        status === "sure" ? r.confidence === "sure" : r.confidence === "candidate";
      if (!same || !confOk) {
        wrong++;
        misses.push(
          `${i + 1}行目 ${r.kind}/${r.confidence} 期待 ${gold}/${status}: ${line}`
        );
      }
    });
    expect(misses).toEqual([]);
    expect(wrong).toBe(0);
    expect(askRight).toBe(5);
  });

  it("候補の行には書き直した行が付き、確かな行・迷いには付かない", () => {
    SAMPLE.forEach(([, , status], i) => {
      const r = result.lines[i];
      if (status === "fix") expect(r.rewritten, `${i + 1}行目`).toBeTruthy();
      else expect(r.rewritten, `${i + 1}行目`).toBeUndefined();
      if (status === "ask") expect(r.reason, `${i + 1}行目`).toBeTruthy();
    });
  });

  it("書き直した行は、直したあと確かな形として読める（もう一度読んで同じ種類）", () => {
    SAMPLE.forEach(([, gold, status], i) => {
      const rewritten = result.lines[i].rewritten;
      if (status !== "fix" || rewritten === undefined) return;
      const again = readScriptLine(rewritten, {
        roles: new Set(["千尋", "店主", "遠野"]),
      });
      expect(again.confidence, `${i + 1}行目 ${rewritten}`).toBe("sure");
      expect(goldKindOf(again)).toBe(gold);
    });
  });

  it("本文の確かな台詞から役名の候補を作る（Ｎ も入る）", () => {
    expect(result.roles).toEqual(
      expect.arrayContaining(["千尋", "店主", "遠野", "Ｎ"])
    );
    expect(new Set(result.roles).size).toBe(result.roles.length);
  });

  it("役名の欄は、ルビ・括弧の指示・の声を外した名前で返す", () => {
    expect(result.lines[3].role).toBe("店主");
    expect(result.lines[11].role).toBe("千尋");
    expect(result.lines[17].role).toBe("遠野");
    expect(result.lines[34].role).toBe("千尋");
  });

  it("書き直しの候補の台詞（順9）の役名は、候補に足さない", () => {
    const only = readScriptText("千尋：こんにちは", []);
    expect(only.lines[0].kind).toBe("unsure");
    expect(only.roles).toEqual([]);
  });
});

describe("順の当て方", () => {
  const none = { roles: new Set<string>() };

  it("空行・半角空白だけの行は空行、全角空白だけの行はト書き", () => {
    expect(readScriptLine("", none).kind).toBe("blank");
    expect(readScriptLine("  ", none).kind).toBe("blank");
    expect(readScriptLine(ZS, none)).toMatchObject({
      kind: "togaki",
      confidence: "sure",
    });
  });

  it("付箋は柱・台詞の形より先（`//店主「…」`）", () => {
    expect(readScriptLine("//店主「あとで」", none).kind).toBe("memo");
    expect(readScriptLine("／／メモ", none).kind).toBe("memo");
  });

  it("柱は ○（U+25CB）も 〇（U+3007）も確か", () => {
    expect(readScriptLine("〇駅前（夜）", none)).toMatchObject({
      kind: "hashira",
      confidence: "sure",
    });
    expect(readScriptLine("○駅前（夜）", none)).toMatchObject({
      kind: "hashira",
      confidence: "sure",
    });
  });

  it("○に似た字は候補で、○へ替えた行を返す（本文は1字も変えない）", () => {
    const r = readScriptLine("◎駅前", none);
    expect(r).toMatchObject({
      kind: "hashira",
      confidence: "candidate",
      rewritten: "○駅前",
    });
  });

  it("ト書きの中の引用（`　太郎「…」`）はト書き", () => {
    expect(readScriptLine(ZS + "太郎「行こう」", none)).toMatchObject({
      kind: "togaki",
      confidence: "sure",
    });
  });

  it("すでに字下げした音・転換は、ト書き（確か）に音・転換の印が付く", () => {
    for (const body of [
      "ＳＥ" + ZS + "雷",
      "Ｍ" + ZS + "雨",
      "×" + ZS + "×" + ZS + "×",
      "BGM 静かな曲",
    ]) {
      expect(readScriptLine(ZS + body, none), body).toMatchObject({
        kind: "togaki",
        confidence: "sure",
        cue: true,
      });
    }
    expect(readScriptLine(ZS + "SEきり", none).cue).toBeUndefined();
  });

  it("役名のルビ記法・括弧の指示・〇つきの柱もこわれない", () => {
    expect(readScriptLine("｜太郎《たろう》「行こう」", none)).toMatchObject({
      kind: "serifu",
      role: "太郎",
    });
    expect(readScriptLine("太郎《たろう》「行こう」", none)).toMatchObject({
      kind: "serifu",
      role: "太郎",
    });
    expect(readScriptLine("太郎（小声）「行こう」", none)).toMatchObject({
      kind: "serifu",
      role: "太郎",
    });
    expect(readScriptLine("〇喫茶「みなと」", none).kind).toBe("hashira");
  });

  it("役名の側に読点・助詞があれば台詞にせず迷い（5'）", () => {
    expect(readScriptLine("彼は「行こう」", none).kind).toBe("unsure");
    expect(readScriptLine("あの日、太郎「行こう」", none).kind).toBe("unsure");
    expect(readScriptLine("太郎「行こう」と言った", none).kind).toBe("unsure");
  });

  it("名前：本文 は、作品の人物なら候補、いなければ迷い（9・9'）", () => {
    const ctx = { roles: new Set(["千尋"]) };
    expect(readScriptLine("千尋：行こう", ctx)).toMatchObject({
      kind: "serifu",
      confidence: "candidate",
      rewritten: "千尋「行こう」",
    });
    expect(readScriptLine("千尋: 行こう", ctx).rewritten).toBe("千尋「行こう」");
    expect(readScriptLine("注意：行こう", ctx).kind).toBe("unsure");
  });

  it("役名の無い「 は迷いで、直前の話し手を候補に出す（10）", () => {
    const r = readScriptText("千尋「え」\n「そうなの」\n", []);
    expect(r.lines[1]).toMatchObject({
      kind: "unsure",
      rule: 10,
      candidateRoles: ["千尋"],
    });
    const first = readScriptText("「そうなの」", []);
    expect(first.lines[0].candidateRoles).toEqual([]);
  });

  it("柱らしい形（場所（時）・シーン1・S1・#1）は候補（11）", () => {
    for (const l of ["駅前（夜）", "シーン1", "S2 駅前", "#3"]) {
      expect(readScriptLine(l, none), l).toMatchObject({
        kind: "hashira",
        confidence: "candidate",
        rewritten: "○" + l,
      });
    }
  });

  it("どれにも当たらない行は迷い（14）。空の入力でも落ちない", () => {
    expect(readScriptLine("ええと", none)).toMatchObject({
      kind: "unsure",
      rule: 14,
    });
    expect(readScriptText("", []).lines).toHaveLength(1);
    expect(readScriptText("a\r\nb", []).lines).toHaveLength(2);
  });
});

describe("scriptLines.ts と食い違わない（順3〜5）", () => {
  const lines = [
    "○柱",
    "〇柱",
    "○喫茶「みなと」",
    ZS + "ト書き",
    ZS + "太郎「引用」",
    "太郎「あ」",
    "太郎（小声）「あ」",
    "{太郎|たろう}「あ」",
    "｜太郎《たろう》「あ」",
    "「役名なし」",
    "普通の行",
    "十二文字までの役名ですよ「あ」",
    "十三文字を越える長い役名ですよ「あ」",
    ZS,
    "",
  ];
  it("柱・ト書きは同じ答え、台詞は『台詞か、5'の迷い』のどちらか", () => {
    for (const line of lines) {
      const mine = readScriptLine(line, { roles: new Set() });
      const theirs = classifyScriptLine(line);
      if (theirs === "hashira") expect(mine.kind, line).toBe("hashira");
      else if (theirs === "togaki") expect(mine.kind, line).toBe("togaki");
      else if (theirs === "serifu") {
        expect(["serifu", "unsure"], line).toContain(mine.kind);
        if (mine.kind === "serifu") expect(splitSerifu(line), line).toBeDefined();
      } else {
        // 今の判定が印を付けない行を、確かな柱・ト書き・台詞にしない
        expect(
          mine.confidence === "sure" &&
            ["hashira", "togaki", "serifu"].includes(mine.kind),
          line
        ).toBe(false);
      }
    }
  });
});

describe("行の種類の切り替え", () => {
  const kinds: ScriptSwitchKind[] = ["hashira", "togaki", "serifu", "cue"];

  /** 種類の印（○・字下げ・役名・外側の「」・音の語）を落とした中身 */
  function content(line: string): string {
    // 台詞の「」で包んだ中に音の語が入る組み合わせもあるので、落ち着くまで繰り返す
    let s = line;
    for (let i = 0; i < 6; i++) {
      s = s.replace(/^[○　]/, "");
      s = s.replace(/^[^\s「」]{1,12}(?=「)/, "");
      s = s.replace(/^「(.*)」$/s, "$1");
      s = s.replace(/^(ＳＥ|Ｍ)　/, "");
    }
    return s;
  }

  it("Tab の順は ト書き→柱→台詞→音・転換→ト書き", () => {
    expect(nextKindOnTab("togaki")).toBe("hashira");
    expect(nextKindOnTab("hashira")).toBe("serifu");
    expect(nextKindOnTab("serifu")).toBe("cue");
    expect(nextKindOnTab("cue")).toBe("togaki");
  });

  it("Alt+1〜4 は 柱・ト書き・台詞・音・転換（上の列の並び）", () => {
    expect(SCRIPT_ALT_KEY_KINDS.map((k) => `${k.key}:${k.kind}`)).toEqual([
      "1:hashira",
      "2:togaki",
      "3:serifu",
      "4:cue",
    ]);
  });

  it("頭の字だけを書き換える", () => {
    expect(switchScriptLineKind("雨が降る。", "togaki")).toBe(ZS + "雨が降る。");
    expect(switchScriptLineKind("駅前", "hashira")).toBe("○駅前");
    expect(switchScriptLineKind(ZS + "行こう", "serifu", "千尋")).toBe(
      "千尋「行こう」"
    );
    expect(switchScriptLineKind("千尋「行こう」", "togaki")).toBe(
      ZS + "「行こう」"
    );
    expect(switchScriptLineKind("千尋「行こう」", "serifu", "遠野")).toBe(
      "遠野「行こう」"
    );
    expect(switchScriptLineKind(ZS + "雷", "cue")).toBe(ZS + "ＳＥ" + ZS + "雷");
    expect(switchScriptLineKind("  半角で字下げ", "togaki")).toBe(
      ZS + "半角で字下げ"
    );
  });

  it("地の文の頭を役名と読んで削らない", () => {
    expect(switchScriptLineKind("彼は「行こう」と言った", "togaki")).toBe(
      ZS + "彼は「行こう」と言った"
    );
  });

  it("台詞へは役名が要る。使えない役名は undefined", () => {
    expect(switchScriptLineKind("行こう", "serifu")).toBeUndefined();
    expect(switchScriptLineKind("行こう", "serifu", "")).toBeUndefined();
    expect(switchScriptLineKind("行こう", "serifu", "太 郎")).toBeUndefined();
    expect(
      switchScriptLineKind("行こう", "serifu", "あ".repeat(13))
    ).toBeUndefined();
  });

  it("どの種類からどの種類へ、何度往復しても本文の中身が変わらない", () => {
    const bodies = [
      "雨が降る。",
      "行こう",
      "「行こう」",
      "SE雷っぽい語",
      "ＳＥ" + ZS + "雷",
      "｜太郎《たろう》が笑う。",
      "〇のつく字",
      "",
      "×" + ZS + "×" + ZS + "×",
    ];
    for (const body of bodies) {
      for (const from of kinds) {
        const start = switchScriptLineKind(body, from, "千尋")!;
        let cur = start;
        for (const to of [...kinds, ...kinds].reverse()) {
          cur = switchScriptLineKind(cur, to, "遠野")!;
          // 音・転換の頭の語は種類の印なので、比べるときは外して見る
          expect(content(cur), `${JSON.stringify(body)} ${from}→${to}`).toBe(
            content(start)
          );
        }
      }
    }
  });

  it("ト書き→台詞→ト書きの往復で、元の字がすべて残る（「」が増えるだけ）", () => {
    const line = ZS + "雨が降る。";
    const speech = switchScriptLineKind(line, "serifu", "千尋")!;
    const back = switchScriptLineKind(speech, "togaki")!;
    expect(back.replace(/[「」]/g, "")).toBe(line);
  });

  it("切り替え後の行を読むと、行き先の種類として確かに読める", () => {
    for (const to of kinds) {
      const out = switchScriptLineKind("雨が降る。", to, "千尋")!;
      const r = readScriptLine(out, { roles: new Set() });
      expect(r.confidence, `${to}: ${out}`).toBe("sure");
      expect(switchKindOf(r), `${to}: ${out}`).toBe(to);
    }
  });

  it("付箋・迷い・空行には切り替えの種類が無い", () => {
    const none = { roles: new Set<string>() };
    expect(switchKindOf(readScriptLine("// メモ", none))).toBeUndefined();
    expect(switchKindOf(readScriptLine("ええと", none))).toBeUndefined();
    expect(switchKindOf(readScriptLine("", none))).toBeUndefined();
  });
});
