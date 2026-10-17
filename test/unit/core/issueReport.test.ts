import { describe, expect, test } from "vitest";
import { redactSecrets } from "../../../src/core/logger";
import {
  ISSUE_REPORT_FORMAT_LINE,
  ISSUE_REPORT_ID_PATTERN,
  ISSUE_REPORT_MAX_BYTES,
  IssueRedactor,
  MAX_JAPANESE_RUN,
  SUMMARY_HEADINGS,
  SUMMARY_MAX_CHARS,
  buildIssueReport,
  issueReportFileName,
  longestJapaneseRun,
  makeIssueReportId,
  type IssueReportInput,
  type RedactionOptions,
} from "../../../src/core/issueReport";

/**
 * 障害報告用の記録の書き出し（設計書8.5。作者の裁定 2026-10-17）。
 *
 * 見張るのは「外へ出してはいけないものが出ないこと」と「Discord の入力窓へ
 * そのまま貼れる形であること」の2つ。前者は**取りこぼしたときに取り返しが
 * つかない**（会員の目に原稿が触れる）ので、伏せ方を項目ごとに確かめ、
 * 最後の網（120字の約束）も別に確かめる。
 */

const NOW = new Date(2026, 9, 17, 14, 3, 22);

/** 原稿らしい段落（句読点入りの日本語が長く続く） */
const MANUSCRIPT =
  "夕暮れの坂道を、彼女はゆっくりと上っていった。" +
  "背中の荷物は思ったよりも重く、肩に食い込む紐の感触が、" +
  "あの日の約束を何度も思い出させた。振り返れば海が見える。" +
  "けれども、いまは振り返らないと決めていた。風が髪を揺らし、" +
  "遠くで汽笛が鳴った。それは別れの合図のようでもあり、" +
  "始まりの合図のようでもあった。彼女は一度だけ深く息を吸い、" +
  "残りの石段を数えながら、最後の角を曲がった。";

const FAKE_KEY = `sk-${"A1b2C3d4E5".repeat(4)}`;

function redaction(overrides: Partial<RedactionOptions> = {}): RedactionOptions {
  return {
    workRoot: "C:\\Users\\nonah\\Documents\\小説\\星の坂道",
    storageRoot: "C:\\Users\\nonah\\AppData\\Roaming\\Code\\User\\globalStorage\\nonahisa.novel-ai-assistant",
    homeDir: "C:\\Users\\nonah",
    // 1人ぶんの名前と別名を1組で渡す（同じ人物は同じ印になる）
    characters: [["坂本美咲", "美咲"], ["高橋"], ["姉"]],
    workNames: ["星の坂道"],
    maskNames: true,
    redactSecrets,
    ...overrides,
  };
}

function input(
  logs: IssueReportInput["logs"],
  overrides: Partial<IssueReportInput> = {}
): IssueReportInput {
  return {
    now: NOW,
    reportId: "NAI-20261017-a3k9",
    rangeHours: 24,
    rangeLabel: "直近24時間",
    environment: {
      extensionVersion: "0.108.5",
      vscodeVersion: "1.105.0",
      os: "win32",
      browser: false,
      ais: [
        { label: "既定", provider: "Ollama", model: "gemma4:e4b", local: true },
        { label: "誤字脱字", provider: "Gemini", model: "gemini-2.5-flash", local: false },
      ],
    },
    logs,
    redaction: redaction(),
    ...overrides,
  };
}

const FAILURE_LOG = [
  "[2026-10-17 13:40:12] 抽出を開始: 星の坂道",
  "[2026-10-17 13:40:12] --- AI呼び出しの失敗 ---",
  "  ファイル: C:\\Users\\nonah\\Documents\\小説\\星の坂道\\本文\\第3話.txt（チャンク 3/8）",
  "  使用中のAI: ollama / gemma4:e4b",
  "  種別: bad_response",
  `  応答: {"items":[{"name":"坂本美咲","evidence":"${MANUSCRIPT.slice(0, 40)}"`,
  `  詳細: key=${FAKE_KEY} https://token123@github.com/nonahisa/repo.git`,
  "[2026-10-17 13:50:00] --- AI呼び出しの失敗 ---",
  "  種別: bad_response",
  "  使用中のAI: ollama / gemma4:e4b",
  "  ファイル: 第3話（チャンク 3/8）",
  "[2026-10-17 13:58:01] --- AI呼び出しの失敗 ---",
  "  種別: bad_response",
  "  使用中のAI: ollama / gemma4:e4b",
  "  ファイル: 第3話（チャンク 3/8）",
  `  本文: ${MANUSCRIPT}`,
  "[2026-10-15 09:00:00] これは範囲より古い行",
  "",
].join("\n");

describe("報告ID", () => {
  test("NAI-年月日-英小文字と数字4字 の形で作る", () => {
    const id = makeIssueReportId(NOW);
    expect(id).toMatch(ISSUE_REPORT_ID_PATTERN);
    expect(id.startsWith("NAI-20261017-")).toBe(true);
  });

  test("書き出すたびに作り直す（乱数を替えれば別のIDになる）", () => {
    const a = makeIssueReportId(NOW, () => new Uint8Array([0, 1, 2, 3]));
    const b = makeIssueReportId(NOW, () => new Uint8Array([4, 5, 6, 7]));
    expect(a).toBe("NAI-20261017-abcd");
    expect(b).not.toBe(a);
    expect(b).toMatch(ISSUE_REPORT_ID_PATTERN);
  });

  test("ファイル名は報告IDそのもの（.md）", () => {
    expect(issueReportFileName("NAI-20261017-a3k9")).toBe("NAI-20261017-a3k9.md");
  });
});

describe("伏せ方", () => {
  test("AIの応答は〈応答 n字〉に置き換え、JSONの骨組みだけを残す", () => {
    const r = new IssueRedactor(redaction());
    const value = '{"items":[{"name":"坂本美咲","evidence":"夕暮れの坂道を上った"}';
    const out = r.field("応答", value);
    expect(out).toContain(`〈応答 ${Array.from(value).length}字〉`);
    expect(out).toContain('{"items":[{"name":"…","evidence":"…"}');
    expect(out).not.toContain("夕暮れ");
    expect(out).not.toContain("坂本");
  });

  test.each(["本文", "引用", "送った本文", "原稿", "target", "suggestion", "evidence"])(
    "%s の値は〈本文 n字〉に置き換える",
    (key) => {
      const r = new IssueRedactor(redaction());
      expect(r.field(key, "彼女は坂を上った")).toBe("〈本文 8字〉");
    }
  );

  test("人物名と作品名は通し番号の印にする（長い名前から先に。別名は同じ印）", () => {
    const r = new IssueRedactor(redaction());
    const out = r.text("坂本美咲と高橋が星の坂道に出る。美咲は笑った");
    expect(out).toBe("〈人物A〉と〈人物B〉が〈作品〉に出る。〈人物A〉は笑った");
  });

  test("印は出てきた順に振る（台帳の順ではない）", () => {
    const r = new IssueRedactor(redaction());
    expect(r.text("高橋")).toBe("〈人物A〉");
    expect(r.text("美咲")).toBe("〈人物B〉");
  });

  test("1字の名前は置き換えない（ありふれた字まで潰すと読めなくなる）", () => {
    const r = new IssueRedactor(redaction());
    expect(r.text("姉の操作")).toBe("姉の操作");
  });

  test("作者が外せば人物名・作品名は残す（ほかの伏せ方はそのまま）", () => {
    const r = new IssueRedactor(redaction({ maskNames: false }));
    expect(r.text("坂本美咲")).toBe("坂本美咲");
    expect(r.field("本文", "彼女は坂を上った")).toBe("〈本文 8字〉");
  });

  test("名前の印の中の字を、別の名前として置き換え直さない", () => {
    const r = new IssueRedactor(redaction({ characters: [["人物"], ["坂本"]] }));
    expect(r.text("坂本と人物")).toBe("〈人物A〉と〈人物B〉");
  });

  test("APIの鍵とURLの資格情報は出さない", () => {
    const r = new IssueRedactor(redaction());
    const out = r.text(`key=${FAKE_KEY} Bearer abcdefghijklmnop1234 https://token123@github.com/x`);
    expect(out).not.toContain(FAKE_KEY);
    expect(out).not.toContain("abcdefghijklmnop1234");
    expect(out).not.toContain("token123");
  });

  test("URLは書かない（手元かどうかだけ残す）", () => {
    const r = new IssueRedactor(redaction());
    expect(r.text("接続先 http://127.0.0.1:11434/api/chat")).toBe("接続先 〈手元のURL〉");
    expect(r.text("接続先 https://api.example.com/v1/chat")).toBe("接続先 〈URL〉");
  });

  test("絶対パスは作品の根からの相対か ~ にする（区切りと大文字小文字の違いも）", () => {
    const r = new IssueRedactor(redaction({ maskNames: false }));
    expect(r.text("c:/users/nonah/documents/小説/星の坂道/本文/第1話.txt")).toBe(
      "本文/第1話.txt"
    );
    expect(r.text("C:\\Users\\nonah\\Desktop\\memo.txt")).toBe("~\\Desktop\\memo.txt");
    expect(
      r.text("C:\\Users\\nonah\\AppData\\Roaming\\Code\\User\\globalStorage\\nonahisa.novel-ai-assistant\\.aiwriter\\logs")
    ).toBe("〈保管庫〉\\.aiwriter\\logs");
    expect(r.text("C:\\Users\\someone\\x.txt")).toBe("~\\x.txt");
    expect(r.text("/home/someone/x.txt")).toBe("~/x.txt");
  });

  test("長い鉤括弧の中身は本文の抜粋として伏せる", () => {
    const r = new IssueRedactor(redaction());
    expect(r.text("「彼女は坂道をゆっくりと上っていった」を直す")).toBe(
      "「〈本文 17字〉」を直す"
    );
    // 短いもの（操作の名前など）は残す
    expect(r.text("「抽出」を押した")).toBe("「抽出」を押した");
  });
});

describe("120字の約束（どの行にも日本語が120字を超えて続かない）", () => {
  test("数え方：数字や記号が少し挟まっても、続いているものとして数える", () => {
    expect(longestJapaneseRun("あいう")).toBe(3);
    expect(longestJapaneseRun("彼は3つの石を拾った")).toBe(10);
    expect(longestJapaneseRun("abc あいう defgh かき")).toBe(3);
  });

  test("鍵で拾えなかった原稿も、最後の網で置き換える", () => {
    const r = new IssueRedactor(redaction({ maskNames: false }));
    const out = r.text(`読めない行: ${MANUSCRIPT}`);
    expect(longestJapaneseRun(out)).toBeLessThanOrEqual(MAX_JAPANESE_RUN);
    expect(out).not.toContain("夕暮れの坂道");
  });

  test("書き出した記録のどの行も約束を守る", () => {
    const longPlain = Array.from({ length: 50 }, (_, i) =>
      `[2026-10-17 1${i % 4}:0${i % 10}:00] 書けなかった: ${MANUSCRIPT}${MANUSCRIPT}`
    ).join("\n");
    const jsonl = JSON.stringify({
      timestamp: "2026-10-17 13:00:00",
      category: "typo",
      action: "applied",
      file: "本文/第1話.txt",
      line: 3,
      target: MANUSCRIPT,
      suggestion: MANUSCRIPT,
    });
    const report = buildIssueReport(
      input([
        { label: "動作の記録（作品）", fileName: "actions.log", text: `${FAILURE_LOG}\n${longPlain}` },
        { label: "指摘の採否（作品）", fileName: "ai_actions.log", text: jsonl },
      ])
    );
    for (const line of report.document.split("\n")) {
      expect(longestJapaneseRun(line), line).toBeLessThanOrEqual(MAX_JAPANESE_RUN);
    }
    expect(report.document).not.toContain(MANUSCRIPT.slice(0, 20));
  });
});

describe("2段の形", () => {
  const report = buildIssueReport(
    input([{ label: "動作の記録（作品）", fileName: "actions.log", text: FAILURE_LOG }])
  );

  test("要約は Discord の欄と同じ見出しを、同じ順で持つ", () => {
    const order = [
      SUMMARY_HEADINGS.environment,
      SUMMARY_HEADINGS.steps,
      SUMMARY_HEADINGS.expected,
      SUMMARY_HEADINGS.actual,
      SUMMARY_HEADINGS.record,
    ];
    const positions = order.map((heading) =>
      report.summary.split("\n").indexOf(heading)
    );
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test("環境の欄は製品が埋める（報告ID・記録の形・版・OS・ブラウザ版・AI）", () => {
    const env = report.summary.split(SUMMARY_HEADINGS.steps)[0];
    expect(env).toContain("報告ID: NAI-20261017-a3k9");
    expect(env).toContain(ISSUE_REPORT_FORMAT_LINE);
    expect(env).toContain("拡張機能: 0.108.5");
    expect(env).toContain("VS Code: 1.105.0");
    expect(env).toContain("OS: win32");
    expect(env).toContain("ブラウザ版: いいえ");
    expect(env).toContain("Ollama / gemma4:e4b（手元）");
    expect(env).toContain("Gemini / gemini-2.5-flash（クラウド）");
    expect(env).not.toMatch(/https?:\/\//);
  });

  test("記録の欄に、機能・種別・処理の段・回数をまとめる", () => {
    const record = report.summary.split(SUMMARY_HEADINGS.record)[1];
    expect(record).toContain("AI呼び出しの失敗");
    expect(record).toContain("bad_response");
    expect(record).toContain("3回");
    expect(record).toContain("チャンク 3/8");
  });

  test("要約は3,000字以内、どの欄も4,000字以内", () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      [
        `[2026-10-17 12:${String(i % 60).padStart(2, "0")}:00] --- 失敗の種類${i} ---`,
        `  種別: kind_${i}`,
        `  ファイル: 第${i}話（チャンク 1/2）`,
      ].join("\n")
    ).join("\n");
    const big = buildIssueReport(
      input([{ label: "動作の記録（作品）", fileName: "actions.log", text: many }])
    );
    expect(big.summary.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(big.summary).toContain("ほか");
  });

  test("ファイル全体は1MB以内（長いログは古い行から省く）", () => {
    const line = `[2026-10-17 13:00:00] ${"abcdefghij".repeat(90)}`;
    const huge = Array.from({ length: 3000 }, () => line).join("\n");
    const big = buildIssueReport(
      input([{ label: "動作の記録（作品）", fileName: "actions.log", text: huge }])
    );
    expect(new TextEncoder().encode(big.document).byteLength).toBeLessThanOrEqual(
      ISSUE_REPORT_MAX_BYTES
    );
    expect(big.document).toContain("古い");
  });

  test("要約はファイルの前半に、そのまま入っている", () => {
    expect(report.document).toContain(report.summary);
    expect(report.document.indexOf(report.summary)).toBeLessThan(
      report.document.indexOf("# 詳細")
    );
  });

  test("範囲より古い行は入れない", () => {
    expect(report.document).not.toContain("これは範囲より古い行");
  });

  test("鍵・URLの資格情報・絶対パス・人物名・作品名が、どこにも出ない", () => {
    expect(report.document).not.toContain(FAKE_KEY);
    expect(report.document).not.toContain("token123");
    expect(report.document).not.toContain("C:\\Users\\nonah");
    expect(report.document).not.toContain("坂本美咲");
    expect(report.document).not.toContain("星の坂道");
  });
});

/*
  Discord のボットが「原稿の疑い」で差し戻す規則の写し。
  出どころ：novel-ai-community-bot の src/core/manuscript.ts（2026-10-17）。
  **写しはこのテストの中だけに置く**——製品はこれより厳しい自前の決まり
  （`guardShape`）で避けており、ボットの数字が変わっても製品は出し直さなくてよい。
  数字が変わったら、ここを向こうに合わせて直し、製品が当たらないかを見る。
*/
const BOT_LONG_LINE_CHARS = 200; // 改行なしで200字を超える行（空白を除く）
const BOT_JAPANESE_RATIO = 0.6; // かな・漢字の割合の下限
const BOT_PROSE_BLOCK_LINES = 7; // 句点で終わる日本語の行が7行以上続き
const BOT_PROSE_BLOCK_CHARS = 150; // 合計150字以上の塊
const BOT_JAPANESE_CHAR = /[぀-ヿ㐀-鿿豈-﫿々ー]/u;
const BOT_SENTENCE_END = /[。！？!?」』…]$/u;
const BOT_DIALOGUE_LINE = /^[「『][^\n]*[」』]$/u;
const BOT_RUBY = /[|｜][^《\n]{1,20}《[^》\n]{1,20}》|[㐀-鿿]《[぀-ゟ゠-ヿ]{1,20}》/u;

function botStrip(line: string): string {
  return line.replace(/[\s　]/g, "");
}

function botRatio(text: string): number {
  const chars = [...text];
  if (chars.length === 0) return 0;
  return chars.filter((ch) => BOT_JAPANESE_CHAR.test(ch)).length / chars.length;
}

/** ボットの判定の写し。当たれば理由、当たらなければ null */
function botSuspicion(text: string): string | null {
  if (BOT_RUBY.test(text)) return "ruby";
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const s = botStrip(line);
    if ([...s].length > BOT_LONG_LINE_CHARS && botRatio(s) >= BOT_JAPANESE_RATIO && /[。、]/u.test(s)) {
      return `long-paragraph: ${line}`;
    }
  }
  let dialogue = 0;
  for (const line of lines) {
    if (BOT_DIALOGUE_LINE.test(botStrip(line))) dialogue++;
    if (dialogue >= 2) return "dialogue";
  }
  let runLines = 0;
  let runChars = 0;
  for (const line of lines) {
    const s = botStrip(line);
    if (s.length === 0) continue;
    if (s.length > 0 && botRatio(s) >= BOT_JAPANESE_RATIO && BOT_SENTENCE_END.test(s)) {
      runLines++;
      runChars += [...s].length;
      if (runLines >= BOT_PROSE_BLOCK_LINES && runChars >= BOT_PROSE_BLOCK_CHARS) {
        return `prose-block: ${line}`;
      }
    } else {
      runLines = 0;
      runChars = 0;
    }
  }
  return null;
}

describe("Discord のボットの「原稿の疑い」に当たらない", () => {
  test("写しの規則は、原稿らしい文を実際に拾う（写しが壊れていないことの確かめ）", () => {
    expect(botSuspicion("|漢字《かんじ》")).toBe("ruby");
    expect(botSuspicion("「おはよう」\n「こんにちは」")).toBe("dialogue");
    expect(botSuspicion(Array.from({ length: 8 }, () => "彼女は坂道を上っていった。風が強い日だった。").join("\n"))).toMatch(/^prose-block/);
  });

  /** 原稿の形をわざと多く含んだログ（製品の案内の行も句点で終わる） */
  const NASTY_LOG = [
    ...Array.from({ length: 12 }, (_, i) =>
      `[2026-10-17 13:${String(10 + i).padStart(2, "0")}:00] 第${i}話の抽出が終わりました。人物と場所を台帳へ入れました。続けて次の話を読みます。`
    ),
    "[2026-10-17 13:30:00] --- AI呼び出しの失敗 ---",
    "  種別: bad_response",
    "  詳細: 読めませんでした",
    "「おはよう」",
    "「今日は晴れだね」",
    "『それは秘密です』",
    "|坂本《さかもと》は|美咲《みさき》を呼んだ。",
    "漢字《かんじ》の記法",
    `  理由: ${"あいうえおかきくけこ".repeat(12)} abcd ${"さしすせそたちつてと、".repeat(11)}。`,
    ...Array.from({ length: 10 }, () => "  これは原稿の続きの行で、句点で終わる文です。長めに書いてあります。"),
  ].join("\n");

  const report = buildIssueReport(
    input([{ label: "動作の記録（作品）", fileName: "actions.log", text: NASTY_LOG }])
  );

  test("ファイル全体が、どの規則にも当たらない", () => {
    expect(botSuspicion(report.document)).toBeNull();
  });

  test("要約だけを貼っても当たらない", () => {
    expect(botSuspicion(report.summary)).toBeNull();
  });

  test("振り仮名の記法が残らない", () => {
    expect(report.document).not.toMatch(/《/);
  });

  test("ふつうの記録（失敗の行・案内の行）でも当たらない", () => {
    const plain = buildIssueReport(
      input([{ label: "動作の記録（作品）", fileName: "actions.log", text: FAILURE_LOG }])
    );
    expect(botSuspicion(plain.document)).toBeNull();
    expect(botSuspicion(plain.summary)).toBeNull();
  });
});

describe("相談のログ（chat.md）は入れない", () => {
  test("渡されても、記録に1行も現れない", () => {
    const report = buildIssueReport(
      input([
        { label: "動作の記録（作品）", fileName: "actions.log", text: FAILURE_LOG },
        {
          label: "相談",
          fileName: "chat.md",
          text: "## 2026-10-17 13:00:00 相談\nxyz-chat-secret-marker",
        },
      ])
    );
    expect(report.document).not.toContain("xyz-chat-secret-marker");
    expect(report.document).not.toContain("chat.md");
  });
});

describe("指摘の採否（JSONL）", () => {
  test("指摘の対象と案は伏せ、種類と操作は残す", () => {
    const jsonl = JSON.stringify({
      timestamp: "2026-10-17 13:00:00",
      category: "typo",
      action: "applied",
      file: "本文/第1話.txt",
      line: 3,
      target: "良い",
      suggestion: "よい",
    });
    const report = buildIssueReport(
      input([{ label: "指摘の採否（作品）", fileName: "ai_actions.log", text: jsonl }])
    );
    expect(report.document).toContain('"category":"typo"');
    expect(report.document).toContain('"action":"applied"');
    expect(report.document).toContain('"target":"〈本文 2字〉"');
    expect(report.document).not.toContain('"良い"');
  });
});
