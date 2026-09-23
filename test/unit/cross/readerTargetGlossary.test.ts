import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  READER_TYPES,
  readerTypeGlossaryEntries,
  resolveReaderType,
  type ReaderTypeId,
} from "../../../src/core/readerTarget";
import {
  READER_PROFILE_SCHEMA_VERSION,
  type ReaderProfile,
} from "../../../src/models/readerProfile";
import { ACTION_TREE } from "../../../src/views/actionList";
import {
  READER_TARGET_DIAGNOSIS_TITLE,
  buildReaderTypeGlossary,
  buildReaderTypeGlossaryPrompt,
  buildReaderTypePrompt,
  buildReaderTypeUnknownPrompt,
  questionMentionsReader,
} from "../../../src/prompts/readerTarget";

/**
 * 相談が読者型の区分を知らなかった件（作者の実機報告、2026-09-21）。
 *
 * 相談で「読者型はわかりませんか？」と聞くと、年齢・性別といった一般論が
 * 返ってきた。相談へ渡していたのは**診断済みの作品の、その1タイプだけ**で、
 * 診断していない作品には何も渡っていなかったためである。
 *
 * ここで見張るのは3つ。
 *
 * 1. 区分の一覧が、**写しでなく `READER_TYPES` から**組まれていること
 * 2. 読者像が無いときに「まだ決めていません」の1行が渡ること
 * 3. 質問に「読者」が入っていれば、**決まっていてもいなくても**一覧を
 *    添えること（作者の裁定、2026-09-21。毎回は送らない）
 *
 * **答えの中身は見張れない。** 「まだ決めていません」という指示語が、
 * そのまま答えへ混ざって返ってくることはある（この作品で繰り返し起きた
 * 失敗の3番目）。ここで確かめられるのは、渡す側だけである。
 */
/**
 * 詳細メニューで、その操作へたどり着くまでに押す名前を並べる。
 *
 * **写さずに `ACTION_TREE` から引く。** メニューを組み替えた日に、
 * 案内の文だけが古くなるのを止めるためである。
 */
function menuPathOf(command: string): string[] {
  for (const group of ACTION_TREE) {
    for (const entry of group.entries) {
      if (entry.kind === "action" && entry.command === command) {
        return [group.label];
      }
      if (entry.kind !== "section") continue;
      if (entry.items.some((item) => item.command === command)) {
        return [group.label, entry.label];
      }
    }
  }
  return [];
}

describe("読者の区分の一覧", () => {
  const ids = Object.keys(READER_TYPES) as ReaderTypeId[];

  test("全タイプぶんの名前と一言が入る", () => {
    const glossary = buildReaderTypeGlossary();

    for (const id of ids) {
      expect(glossary, id).toContain(READER_TYPES[id].label);
      expect(glossary, id).toContain(READER_TYPES[id].summary);
    }
  });

  test("行数はタイプの数と同じ（余計なものを混ぜない）", () => {
    expect(buildReaderTypeGlossary().split("\n")).toHaveLength(ids.length);
  });

  /**
   * **タイプ別の書き方の方針（`READER_TYPE_PROMPTS`）は混ぜない。**
   * 全タイプぶんの「助言の向き」を同時に送ると、AIは「短く引きの強い話」と
   * 「長く余韻のある話」を両方勧めてくる（どちらも書いてあるため）。
   */
  test("助言の向きまでは渡さない", () => {
    expect(buildReaderTypeGlossary()).not.toContain("助言の向き");
  });

  test("写しを書かず、`READER_TYPES` から組む", () => {
    const source = readFileSync(
      resolve(__dirname, "../../../src/prompts/readerTarget.ts"),
      "utf8"
    );
    const body = source.slice(source.indexOf("export function buildReaderTypeGlossary("));

    expect(body.slice(0, 400)).toContain("READER_TYPES[id].summary");
  });
});

describe("読者像が決まっていない作品", () => {
  test("これまでどおり、その作品のタイプは渡らない", () => {
    // 診断していなければ `undefined`（相談は止めない）
    expect(buildReaderTypePrompt(undefined)).toBeUndefined();
  });

  test("決めていないことを、はっきり書く", () => {
    expect(buildReaderTypeUnknownPrompt()).toContain("まだ決めていません");
  });

  test("決め方（操作の名前）を添える", () => {
    expect(buildReaderTypeUnknownPrompt()).toContain(
      READER_TARGET_DIAGNOSIS_TITLE
    );
  });

  /**
   * **押す場所まで書く**（作者の実機報告、2026-09-21。0.74.12）。
   *
   * 名前だけを渡していたら、作者が相談で「実行して」と頼み、AIが
   * 実行したふりをして答えた。**押すのは作者**なので、押す場所が要る。
   *
   * 道筋は `ACTION_TREE` から引いて突き合わせる——書き写すと、
   * メニューを組み替えた日に案内だけが古くなる。
   */
  test("押す場所（詳細メニューの道筋）が、実際の並びと一致する", () => {
    const prompt = buildReaderTypeUnknownPrompt();
    const path = menuPathOf("novelai.runReaderTargetDiagnosis");

    expect(path.length).toBeGreaterThan(0);
    for (const label of path) {
      expect(prompt, label).toContain(label);
    }
  });

  test("もう1つの押し口（画面で案内してもらう）も添える", () => {
    // 相談の答えの下に出るボタンである（`views/workChatPanelHtml.ts`）。
    // 手順書きが当たらないと出ないので、`core/procedures.ts` に
    // 「ターゲット読者を決める」を足してある
    const panel = readFileSync(
      resolve("src/views/workChatPanelHtml.ts"),
      "utf8"
    );

    expect(buildReaderTypeUnknownPrompt()).toContain("画面で案内してもらう");
    expect(panel).toContain("画面で案内してもらう");
  });

  /**
   * **案内する操作の名前は、実際の操作名と同じでなければならない。**
   * 違う名前で案内すると、作者はその操作を探せない。
   */
  test("操作の名前が `package.json` と一致する", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
      contributes: { commands: { command: string; title: string }[] };
    };
    const found = pkg.contributes.commands.find(
      (entry) => entry.command === "novelai.runReaderTargetDiagnosis"
    );

    expect(found?.title).toBe(READER_TARGET_DIAGNOSIS_TITLE);
  });

  /**
   * **毎回送るのは1行だけ**（作者の裁定、2026-09-21）。区分の一覧は
   * 読者の話をしている回にだけ添える——読者の話でない回にまで乗せると、
   * 助言の向きが11の区分のあいだで揺れる（節約の話でもある）。
   */
  test("**区分の一覧は入れない**（毎回送るので1行だけ）", () => {
    const prompt = buildReaderTypeUnknownPrompt();

    expect(prompt.split("\n")).toHaveLength(1);
    for (const id of Object.keys(READER_TYPES) as ReaderTypeId[]) {
      expect(prompt, id).not.toContain(READER_TYPES[id].label);
    }
  });
});

describe("読者について聞かれた回に、一覧を添える", () => {
  test("「読者」が入っていれば添える", () => {
    expect(questionMentionsReader("読者型はわかりませんか？")).toBe(true);
    expect(questionMentionsReader("この作品の想定読者は？")).toBe(true);
    expect(questionMentionsReader("読者層を変えたい")).toBe(true);
  });

  test("関係のない相談では添えない", () => {
    expect(questionMentionsReader("3話の展開に迷っています")).toBe(false);
    expect(questionMentionsReader("誤字を直したい")).toBe(false);
  });

  /** 自分のタイプは上のブロックにある。ここは比べるための一覧だけ */
  test("添える一段にも全タイプの名前が入る", () => {
    const prompt = buildReaderTypeGlossaryPrompt();

    for (const id of Object.keys(READER_TYPES) as ReaderTypeId[]) {
      expect(prompt, id).toContain(READER_TYPES[id].label);
    }
  });

  /** どれか1つを勝手に「この作品の読者」だと決めさせない */
  test("AIに決めさせない", () => {
    expect(buildReaderTypeGlossaryPrompt()).toContain("決めないでください");
  });

  /**
   * **決めている作品にも、決めていない作品にも同じ一段を添える**ので、
   * 文面はどちらでも読めなければならない（「上に書いたとおり」と
   * 言い切ると、未診断の回で嘘になる）。
   */
  test("決まっていない作品に添えても、嘘にならない", () => {
    const prompt = buildReaderTypeGlossaryPrompt();

    expect(prompt).toContain("【この作品の読者】に書いてあります");
    // 上のブロックが「まだ決めていません」でも、そのまま読める
    expect(prompt).not.toContain("上に書いたとおり");
  });
});

/**
 * 相談の画面が、この3つをちゃんと繋いでいるか。
 *
 * **中身（プロンプト）と繋ぎ（画面）は別々に壊れる。** 文言が正しくても
 * 呼ばれていなければ、実機では何も変わらない。
 */
describe("相談の画面に繋がっている", () => {
  const panel = readFileSync(
    resolve(__dirname, "../../../src/features/workChatPanel.ts"),
    "utf8"
  );

  test("読者像が無いときは、決めていないことを渡す", () => {
    expect(panel).toContain("buildReaderTypeUnknownPrompt()");
  });

  test("読者の話のときだけ、一覧を添える", () => {
    expect(panel).toContain("questionMentionsReader(question)");
    expect(panel).toContain("buildReaderTypeGlossaryPrompt()");
  });

  /**
   * **一覧を添える絞り方は、決まっていてもいなくても同じ**（作者の裁定、
   * 2026-09-21）。診断済みの枝の中に入れると、未診断の作品では一覧が
   * 一度も届かなくなる
   */
  test("一覧の判定は、診断の有無の枝の外にある", () => {
    const block = panel.slice(panel.indexOf("const readerBlock ="));
    const decision = block.indexOf("questionMentionsReader(question)");
    const otherwise = block.indexOf("buildReaderTypeUnknownPrompt()");

    expect(otherwise).toBeGreaterThan(-1);
    expect(decision).toBeGreaterThan(otherwise);
  });

  /** 何を足したかは必ず記録する（効いているかを作者が確かめる唯一の手掛かり） */
  test("足したことを記録に残す", () => {
    expect(panel).toContain("相談: 読者タイプは未診断");
    expect(panel).toContain("相談: 読者タイプの区分一覧を添えた");
  });
});

/**
 * 一覧が**作者の目にも入る**か（作者の実機報告、2026-09-22
 * 「相談で読者タイプの一覧が添えられていません」）。
 *
 * 2026-09-21 の手当てで一覧はAIへ渡るようになっていたが、渡していたのは
 * プロンプトの中だけで、**作者は記録を開かないと分からなかった。**
 * 答えの下に、同じ区分を畳んだ枠で置く。
 *
 * **中身はAIに頼まない。** 区分はこの拡張機能が持っている決まりなので、
 * 製品が `READER_TYPES` から並べる（AIに書かせると、聞くたびに名前も
 * 件数も揺れる）。
 */
describe("読者タイプの区分を、作者にも見せる", () => {
  const panel = readFileSync(
    resolve(__dirname, "../../../src/features/workChatPanel.ts"),
    "utf8"
  );
  const face = readFileSync(
    resolve(__dirname, "../../../src/views/workChatPanelHtml.ts"),
    "utf8"
  );

  /** 点数から区分を決めるので、宣言の点数を持った台帳を作る */
  function profileWith(scores: {
    familiarity: number;
    posture: number;
    craving: number;
  }): ReaderProfile {
    return {
      schemaVersion: READER_PROFILE_SCHEMA_VERSION,
      declared: {
        scores,
        answers: [],
        updatedAt: "2026-09-22T00:00:00.000Z",
      },
    };
  }

  test("一覧は READER_TYPES から並ぶ（写しを持たない）", () => {
    const entries = readerTypeGlossaryEntries(undefined);
    const ids = Object.keys(READER_TYPES) as ReaderTypeId[];

    expect(entries).toHaveLength(ids.length);
    for (const id of ids) {
      const found = entries.find(
        (entry) => entry.label === READER_TYPES[id].label
      );
      expect(found, READER_TYPES[id].label + " が無い").toBeDefined();
      expect(found?.summary).toBe(READER_TYPES[id].summary);
    }
  });

  test("未診断なら、どれにも印を付けない", () => {
    const entries = readerTypeGlossaryEntries(undefined);
    expect(entries.filter((entry) => entry.mine)).toHaveLength(0);
  });

  test("診断済みなら、その作品の区分にだけ印が付く", () => {
    const scores = { familiarity: 6, posture: 1, craving: 1 };
    const entries = readerTypeGlossaryEntries(profileWith(scores));
    const mine = entries.filter((entry) => entry.mine);

    expect(mine).toHaveLength(1);
    // 印の付く先は、判定（resolveReaderType）と必ず同じ区分である
    expect(mine[0].label).toBe(READER_TYPES[resolveReaderType(scores)].label);
  });

  /**
   * **出す回は、AIへ添える回とまったく同じ**（作者の裁定、2026-09-21 の
   * 絞り方をそのまま使う）。読者の話でない回にまで11行が並ぶと、
   * 答えそのものが押し下げられる。
   */
  test("出すのは、一覧を添えた回だけ（同じ絞り方）", () => {
    const block = panel.slice(panel.indexOf("private async readerGlossaryFor("));
    const body = block.slice(0, 900);

    expect(body).toContain("!work || !questionMentionsReader(question)");
    expect(body).toContain("readerTypeGlossaryEntries(");
    // 答えと一緒に送る（別便にすると、どの回の一覧か分からなくなる）
    expect(panel).toContain("const readerGlossary = await this.readerGlossaryFor(");
    expect(panel).toContain("...(readerGlossary ? { readerGlossary } : {})");
  });

  test("添えない回には、枠が付かない", () => {
    // 送られてこなければ何も描かない（枠だけが空で残らない）
    const add = face.slice(face.indexOf("function appendReaderGlossary("));
    expect(add.slice(0, 200)).toContain(
      "if (!entries || entries.length === 0) return;"
    );
  });

  test("答えの下に、畳んだ枠で出る", () => {
    // 答えの下に付くものは `appendAnswerExtras` にまとまっている
    // （後から開いた画面の履歴からも同じ関数を通す。2026-09-23）
    expect(face).toContain("appendReaderGlossary(turn, extras.readerGlossary)");

    const add = face.slice(face.indexOf("function appendReaderGlossary("));
    const body = add.slice(0, 1200);
    // 畳んである（details）。開くまでは1行
    expect(body).toContain("createElement('details')");
    expect(body).toContain("'読者タイプの区分（' + entries.length + '）'");
    // 診断済みの区分が、ひと目で分かる
    expect(body).toContain("' ← この作品'");
  });
});
