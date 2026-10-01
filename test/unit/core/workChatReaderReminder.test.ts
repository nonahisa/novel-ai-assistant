import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { workChatReaderBlocks } from "../../../src/core/workChatMaterials";
import {
  READER_PROFILE_SCHEMA_VERSION,
  type ReaderProfile,
  type ReaderScores,
} from "../../../src/models/readerProfile";
import {
  READER_TYPE_REMINDER_HEADING,
  buildReaderTypeReminder,
} from "../../../src/prompts/readerTarget";
import { buildWorkChatPrompt, type WorkChatInput } from "../../../src/prompts/workChat";

/**
 * 読者の要点を、問いの直前にも置く（残課題 M7、2026-10-01 の測定）。
 *
 * gemma4:e4b では、作品の全体像（ユーザープロンプト側、約3,800字）を添えると、
 * システムプロンプトの末尾の【この作品の読者】が答えから落ちた。読者を
 * 名指しした問いで、宣言が使われたのは8回中4回。
 *
 * ここで見張るのは、**渡す側**だけである。
 *
 * 1. 読者の話の回（質問に「読者」）で、読者が決まっていれば、要点が
 *    【作者からの相談】の**すぐ上**に入る
 * 2. 読者の話でない回には入らない——答えを動かさない（作者の裁定、2026-09-21
 *    「区分の一覧は読者の話をしている回にだけ」と同じ絞り方）
 * 3. 決めていない作品には入らない（「まだ決めていません」は写さない）
 * 4. 製品の相談パネルと MCP の相談の両方が、要点を問いへ渡している
 */

const KOUSATSU: ReaderScores = { familiarity: 2, posture: 2, craving: 0 };

function declared(scores: ReaderScores = KOUSATSU): ReaderProfile {
  return {
    schemaVersion: READER_PROFILE_SCHEMA_VERSION,
    declared: { scores, answers: [], updatedAt: "2026-09-22T00:00:00.000Z" },
  };
}

function promptWith(reminder: string | undefined, question: string): string {
  const input: WorkChatInput = {
    workTitle: "試しの作品",
    contextKind: "outside",
    contextLabel: "作品のファイル以外",
    excerpt: "",
    excerptTruncated: false,
    fromSelection: false,
    reference: ["【作品の全体像】\n" + "長い全体像。".repeat(600)],
    history: [{ role: "author", text: "前の質問" }],
    question,
    featureGuide: "目次",
    ...(reminder ? { readerReminder: reminder } : {}),
  };
  return buildWorkChatPrompt(input);
}

describe("読者の要点を問いの直前に置く", () => {
  test("読者の話で、決まっていれば要点を返す", () => {
    const reader = workChatReaderBlocks(declared(), "この作品の読者に向けて、第1話で何を強めるとよいですか");
    expect(reader.reminder).toBeDefined();
    expect(reader.reminder).toContain(READER_TYPE_REMINDER_HEADING);
    expect(reader.reminder).toContain("考察層");
    expect(reader.reminder).toContain("助言の向き：");
  });

  test("要点は【作者からの相談】のすぐ上に入る（全体像や履歴より後ろ）", () => {
    const question = "この作品の読者に向けて、第1話で何を強めるとよいですか";
    const reader = workChatReaderBlocks(declared(), question);
    const prompt = promptWith(reader.reminder, question);

    const at = prompt.indexOf(READER_TYPE_REMINDER_HEADING);
    const ask = prompt.indexOf("【作者からの相談】");
    expect(at).toBeGreaterThan(prompt.indexOf("【作品の全体像】"));
    expect(at).toBeGreaterThan(prompt.indexOf("【これまでのやり取り】"));
    expect(at).toBeLessThan(ask);
    // あいだに別の段を挟まない
    expect(prompt.slice(at, ask)).not.toMatch(/\n【(?!作者からの相談)/);
  });

  test.each([
    "第3話の誤字を見てください",
    "主人公の口調の特徴を教えてください",
    // 読む人の話でも「読者」の字が無ければ入れない（区分の一覧と同じ絞り方）
    "第1話の冒頭で、読む人が途中で離れないようにするには、何を直すとよいですか",
  ])("読者の話でない回には入らない：%s", (question) => {
    const reader = workChatReaderBlocks(declared(), question);
    expect(reader.reminder).toBeUndefined();
    // 要点の欄を渡さないときのプロンプトは、これまでと1文字も変わらない
    expect(promptWith(reader.reminder, question)).toBe(promptWith(undefined, question));
    expect(promptWith(reader.reminder, question)).not.toContain(READER_TYPE_REMINDER_HEADING);
  });

  test("決めていない作品には入れない", () => {
    expect(workChatReaderBlocks(undefined, "読者は誰ですか").reminder).toBeUndefined();
    expect(buildReaderTypeReminder(undefined)).toBeUndefined();
  });

  test("本文から推定した読者なら、推定だと断る", () => {
    const profile: ReaderProfile = {
      schemaVersion: READER_PROFILE_SCHEMA_VERSION,
      actual: {
        scores: KOUSATSU,
        evidence: [],
        basis: "第1〜3話",
        model: "試し",
        updatedAt: "2026-09-22T00:00:00.000Z",
      },
    };
    const reminder = buildReaderTypeReminder(profile);
    expect(reminder).toContain("推定");
    expect(reminder).not.toContain("作者がこの読者に向けて");
  });

  test("要点は短い（全文を2か所に置かない）", () => {
    const reminder = buildReaderTypeReminder(declared()) ?? "";
    expect(reminder.split("\n").length).toBeLessThanOrEqual(3);
    expect(reminder).not.toContain("離れるところ");
  });

  /** 製品のパネルと MCP の両方が、問いへ要点を渡していること（片方だけ直らないように） */
  test("パネルと MCP の両方が要点を問いへ渡す", () => {
    const root = resolve(__dirname, "../../..");
    const panel = readFileSync(resolve(root, "src/features/workChatPanel.ts"), "utf8");
    const mcp = readFileSync(resolve(root, "src/mcp/tools/chat.ts"), "utf8");
    for (const source of [panel, mcp]) {
      expect(source).toContain("reader.reminder");
      expect(source).toMatch(/readerReminder \? \{ readerReminder \} : \{\}/);
    }
  });
});
