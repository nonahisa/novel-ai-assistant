/**
 * 抽出・再読込の完了の知らせ（画面の自動テスト、設計書6.113。仕分け 2026-10-12 の束 E17。
 * 実機確認リスト 226・477・509 を移したもの。作者の裁定「仕分けて機械の分から減らす」）。
 *
 * 何を見張るか：
 * - 226：人物抽出の答えで、関係の欄に「呼び名は『イント君』」が入ってきたとき、
 *   マイナ様の記録の `addressTerms` に「イント」への『イント君』が入り、相関図の線を押すと
 *   呼び合いに「マイナ様はイントを『イント君』と呼ぶ」が出て、完了報告に
 *   「関係の欄に書かれていた呼び名を、呼称へ 1件 移しました」が出る（設計書6.5・6.38）
 * - 509：完了報告の「根拠の台詞が本文の台詞に見当たらない口調を N件 外しました」は、
 *   口調の根拠に地の文が返った回だけ出る。根拠が「」の中の台詞の回には出ず、口調は資料に入る
 *   （**出ないことだけでは満点にならない**——何も書かない実装でも通るので、資料に口調が入ったことも見る）
 * - 477：設定資料パネルの［AIで再読込］で、役割に作品に無い話（第17話）を挙げた答えが返ると、
 *   その提案は出ず、提案の箱に「作品に無い話を挙げていた提案（役割：第17話）は除きました」の断りが出て、
 *   `.aiwriter/logs/actions.log` の「作品に無い話を挙げていたもの」に応答の全文が残る（設計書6.31.1）
 *
 * **本物の AI は呼ばない。** 偽の Ollama が、抽出（P-04a）・再読込のスキーマに合う答えを返す。
 * 見ているのは「答えが返ったあと、検算 → 保存 → 知らせ・画面・ログ」までの配線で、
 * 本物の AI がそういう答えを書いてくるか（出来）は見えない。検算の規則そのものは単体テスト
 * （`core/characterExtractionValidation.test.ts`・`core/speechStyle.test.ts`・`core/settingsEnrichCheck.test.ts`）が見ている。
 *
 * 抽出の件は**件ごとに別の作品フォルダー**で回す（`withVsCode` が毎回作る）。同じフォルダーで
 * 2回目を回すとチャンクの控えに当たり、AI が呼ばれないため。
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame } from "playwright-core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { emptyCharacter, type Character } from "../../src/models/character";
import { describeFakeRequests, fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama } from "./support/fakeOllama";
import { describeNotices, recordedNotices } from "./support/noticeRecord";
import { runCommand } from "./support/quickInput";
import { charactersFolder, defaultCharactersFolder, settingsPanelFrame, writeCharactersTo } from "./support/settingsFixture";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { clearNotifications, pickQuickPickRow, quickInputWaitContext, quickPickRows, quickPickTitle } from "./support/workbenchDom";

const OPEN_GRAPH_KEY = "ctrl+alt+shift+f3";
const OPEN_GRAPH_PRESS = "Control+Alt+Shift+F3";
const OPEN_SETTINGS_KEY = "ctrl+alt+shift+f1";
const OPEN_SETTINGS_PRESS = "Control+Alt+Shift+F1";

/** 偽の AI の答え。件ごとに入れ替える（呼ばれたものは何でも同じ答え） */
let answer = "{}";
let fake: FakeOllama;
beforeEach(async () => {
  answer = "{}";
  fake = await startFakeOllama(() => answer);
});
afterEach(async () => {
  await fake.close();
});

/* ───────────── 人物抽出（226・509） ───────────── */

const EXTRACT_EPISODE = "001_庭.txt";
// 「イント君」が本文にそのまま出ていること（移すのは本文にある呼び名だけ。`moveAddressesFromRelations`）
const EXTRACT_BODY =
  "　マイナ様は庭でイントを見つけた。\n" +
  "「イント君、こちらへいらっしゃい」\n" +
  "「はい、ただいま参ります」\n" +
  "　イントは小さく頭を下げて駆け寄った。\n";

const ADDRESS_RELATION = "呼び名は『イント君』";
/**
 * イントの口調。**「一人称」の語・説明の語の並び（「語尾、口癖」）・例の口癖を入れない**——
 * 入れると別の理由（一人称だけ外す・指示の写し）で外れ、509 の見出しと取り違える
 */
const INTO_SPEECH_STYLE = "目上の相手にかしこまった言葉で話す";
/** 根拠が地の文（括弧の外）。本文にはあるが台詞ではない → 「台詞に見当たらない」で外れる */
const NARRATION_EVIDENCE = "イントは小さく頭を下げて駆け寄った";
/** 根拠が「」の中の台詞 → 口調は資料に入る */
const DIALOGUE_EVIDENCE = "はい、ただいま参ります";

const MOVED_LINE = `関係の欄に書かれていた呼び名を、呼称へ 1件 移しました（マイナ様 から「イント」への『イント君』）`;
const SPEECH_DROP_HEAD = "根拠の台詞が本文の台詞に見当たらない口調";
const SPEECH_DROP_LINE = `${SPEECH_DROP_HEAD}を 1件 外しました（イント の「${INTO_SPEECH_STYLE}」）`;

/** 人物抽出（P-04a）のスキーマ（`CHARACTER_EXTRACT_SCHEMA`）に合う答え。required の鍵は null でも全部入れる */
function extractAnswer(speechEvidence: string): string {
  const person = (fields: Record<string, unknown>) => ({
    entityType: "person",
    aliases: [],
    isMob: false,
    reading: null,
    summary: null,
    gender: null,
    affiliation: null,
    role: null,
    personality: null,
    appearance: null,
    speechStyle: null,
    speechEvidence: null,
    firstPerson: null,
    defaultSecondPerson: null,
    addressTerms: [],
    relations: [],
    ...fields,
  });
  return JSON.stringify({
    characters: [
      person({
        name: "マイナ様",
        relations: [{ name: "イント", relation: ADDRESS_RELATION }],
        evidence: "マイナ様は庭でイントを見つけた",
      }),
      person({
        name: "イント",
        speechStyle: INTO_SPEECH_STYLE,
        speechEvidence,
        evidence: "イントは小さく頭を下げて駆け寄った",
      }),
    ],
    abilities: [],
    organizations: [],
    locations: [],
    worldview: [],
    abilitySystem: { abilityTerm: null, description: null, rules: [] },
    confidence: "high",
  });
}

/** 記録の知らせのうち、`since` より後の抽出の完了報告（「新規 N名 … 保存済み N名」の行を持つもの） */
async function extractionSummary(session: E2ESession, since: number): Promise<string | undefined> {
  return (await recordedNotices(session))
    .filter((entry) => Date.parse(entry.at) >= since - 1_000)
    .map((entry) => entry.message)
    .find((message) => message.includes("新規 ") && message.includes("保存済み "));
}

/**
 * 「人物抽出」を走らせ、処理量の確認（上の選ぶ画面の［実行］）と手元のAIの関所を通し、
 * 完了報告の全文を返す。**右下の知らせでなく記録ファイルで読む**——完了報告は複数行で、
 * 右下では畳まれて後ろの行（検算で直した分）が読めないことがある
 */
async function runCharacterExtraction(session: E2ESession): Promise<string> {
  const { page } = session;
  await clearNotifications(page);
  const started = Date.now();
  const before = fake.requests.length;
  await runCommand(page, "人物抽出");
  const seenTitles: string[] = [];
  let summary: string | undefined;
  await waitUntil(
    async () => {
      await passLocalAiGate(page);
      const title = (await quickPickTitle(page)) ?? "";
      if (title !== "" && seenTitles[seenTitles.length - 1] !== title) seenTitles.push(title);
      if (title !== "") {
        // 処理量の確認（`confirmRun`）。文の頭は題に、残りは行に入る
        const rows = await quickPickRows(page);
        const words = [title, ...rows.map((row) => row.label)].join(" ");
        if (rows.some((row) => row.label === "実行") && words.includes("チャンク中")) {
          await pickQuickPickRow(page, "実行");
        }
      }
      summary = await extractionSummary(session, started);
      return summary !== undefined;
    },
    "人物抽出の確認を通って、完了報告が知らせの記録に出る",
    120_000
  ).catch(async (error: unknown) => {
    throw new Error(
      `${String(error)}（通った選ぶ画面：${JSON.stringify(seenTitles)}／${describeFakeRequests(fake.requests, before)}／` +
        `${await describeNotices(session, started - 1_000)}）${await quickInputWaitContext(page)}`
    );
  });
  expect(fake.requests.length - before, `偽のAIが抽出で呼ばれていません（${describeFakeRequests(fake.requests, before)}）`).toBeGreaterThan(0);
  expect(
    fake.requests.slice(before).some((request) => request.structured && request.user.includes("イント君")),
    `本文を載せた構造化の頼みが届いていません（${describeFakeRequests(fake.requests, before)}）`
  ).toBe(true);
  return summary ?? "";
}

/** 人物の置き場にある記録（名前で引く）。保存は「退避 → 新規作成」なので、読めるまで待つ */
async function savedCharacter(session: E2ESession, name: string): Promise<Character> {
  const folder = await charactersFolder(session);
  let found: Character | undefined;
  let seen: string[] = [];
  await waitUntil(
    async () => {
      seen = (await readdir(folder).catch(() => [] as string[])).filter((file) => file.endsWith(".json"));
      for (const file of seen) {
        const raw = await readFile(path.join(folder, file), "utf8").catch(() => "");
        if (!raw) continue;
        const parsed = JSON.parse(raw) as Character;
        if (parsed.name === name) {
          found = parsed;
          return true;
        }
      }
      return false;
    },
    `人物「${name}」の記録が保存される`,
    15_000
  ).catch((error: unknown) => {
    throw new Error(`${String(error)}（人物の置き場のファイル：${JSON.stringify(seen)}）`);
  });
  return found as Character;
}

/** 相関図の面（SVG の人物の点 `.g-node` を持つ） */
async function graphFrame(session: E2ESession): Promise<Frame | undefined> {
  for (const frame of session.page.frames()) {
    const has = await frame.evaluate(() => document.querySelector(".g-node") !== null).catch(() => false);
    if (has) return frame;
  }
  return undefined;
}

const extractLaunch = () =>
  fakeOllamaLaunch(fake, { keybindings: [{ key: OPEN_GRAPH_KEY, command: "novelai.openRelationGraph" }] });

test("人物抽出で関係の欄に「呼び名は『イント君』」が返ると、マイナ様の呼称へ移って相関図の呼び合いに出て、完了報告に移した件数が出る。口調の根拠が地の文の回は「台詞に見当たらない口調」を外した件数も出る", async () => {
  answer = extractAnswer(NARRATION_EVIDENCE);
  await withVsCode(
    "抽出の完了報告（呼び名の移し・口調の外し）",
    [{ name: EXTRACT_EPISODE, text: EXTRACT_BODY }],
    async (session) => {
      const summary = await runCharacterExtraction(session);

      // ── 完了報告：移した呼び名（226）と、地の文を根拠にした口調を外した分（509 の出る回）
      expect(summary, "完了報告に、関係の欄から呼称へ移した行がありません").toContain(MOVED_LINE);
      expect(summary, "完了報告に、台詞に見当たらない口調を外した行がありません").toContain(SPEECH_DROP_LINE);

      // ── ファイル：マイナ様の呼称に「イント」への『イント君』。関係の欄からは消える
      const maina = await savedCharacter(session, "マイナ様");
      const toInto = maina.addressTerms.find((term) => term.targetName === "イント");
      expect(
        toInto?.forms.map((form) => form.term),
        `マイナ様の呼称に「イント」への『イント君』がありません（addressTerms：${JSON.stringify(maina.addressTerms)}）`
      ).toContain("イント君");
      expect(
        maina.relations.map((relation) => relation.relation),
        "「呼び名は『イント君』」が関係の欄に残っています"
      ).not.toContain(ADDRESS_RELATION);
      // 口調は外れたので資料に入らない（人物ごとは残る）
      const into = await savedCharacter(session, "イント");
      expect(into.speechStyle ?? null, "地の文を根拠にした口調が資料に入っています").toBeNull();

      // ── 画面：相関図の線を押すと、呼び合いに「マイナ様はイントを『イント君』と呼ぶ」
      await session.page.keyboard.press(OPEN_GRAPH_PRESS);
      let graph: Frame | undefined;
      await waitUntil(
        async () => (graph = await graphFrame(session)) !== undefined && (await graph.locator(".g-edge-hit").count()) > 0,
        "人物相関図に人物の点と線が並ぶ",
        30_000
      );
      const frame = graph as Frame;
      await frame.locator(".g-edge-hit").first().click({ force: true });
      let side = "";
      await waitUntil(
        async () => {
          side = await frame.evaluate(() => (document.querySelector("#side") as HTMLElement | null)?.innerText ?? "");
          return side.includes("呼び合い");
        },
        "線を押すと、右に呼び合いが出る",
        15_000
      ).catch((error: unknown) => {
        throw new Error(`${String(error)}（右の欄：${JSON.stringify(side.replace(/\s+/g, " ").slice(0, 400))}）`);
      });
      expect(side, "呼び合いに、マイナ様からイントへの呼び方が出ていません").toContain("マイナ様はイントを『イント君』と呼ぶ");
    },
    extractLaunch()
  );
});

test("人物抽出で口調の根拠が「」の中の台詞の回は、完了報告に「台詞に見当たらない口調」の行が出ず、口調が資料に入る", async () => {
  answer = extractAnswer(DIALOGUE_EVIDENCE);
  await withVsCode(
    "抽出の完了報告（口調を外さない回）",
    [{ name: EXTRACT_EPISODE, text: EXTRACT_BODY }],
    async (session) => {
      const summary = await runCharacterExtraction(session);
      expect(summary, "外していないのに、台詞に見当たらない口調の行が出ています").not.toContain(SPEECH_DROP_HEAD);
      // 「出ない」だけでは何も書かない実装でも通るので、口調が資料に入ったことも見る
      const into = await savedCharacter(session, "イント");
      expect(into.speechStyle, "台詞を根拠にした口調が資料に入っていません").toBe(INTO_SPEECH_STYLE);
      // 同じ答えの呼び名の移しは、この回も同じく報告される（完了報告そのものが組まれている確かめ）
      expect(summary).toContain(MOVED_LINE);
    },
    extractLaunch()
  );
});

/* ───────────── AIで再読込（477） ───────────── */

const GRANDMA = "おばあさん";
const ENRICH_EPISODES = [
  { name: "001_縁側.txt", text: `　${GRANDMA}は縁側で茶をすすっていた。\n「よう来たね」\n　${GRANDMA}は笑った。\n` },
  { name: "002_畑.txt", text: `　翌朝、${GRANDMA}は畑へ出た。\n` },
];
const ENRICH_NOTES = "文佳の祖母ではないです";
/** 作品は2話しかない。役割だけが作品に無い「第17話」を挙げる */
const UNKNOWN_ROLE = "第17話で文佳の祖母として描かれる";
/** 正当な提案も1つ入れる（全部はじかれると提案の箱が出ず、断りの置き場が変わる） */
const VALID_PERSONALITY = "穏やかで面倒見がよい";
const CITATION_NOTICE = "（作品に無い話を挙げていた提案（役割：第17話）は除きました）";
const CITATION_LOG_HEAD = "再読込の提案のうち、作品に無い話を挙げていたもの";

/** 再読込のスキーマ（`buildEnrichSchema` の人物の項目＋misattributed）に合う答え */
function enrichAnswer(): string {
  return JSON.stringify({
    gender: null,
    summary: null,
    affiliation: null,
    role: UNKNOWN_ROLE,
    personality: VALID_PERSONALITY,
    speechStyle: null,
    appearance: null,
    misattributed: [],
  });
}

test("設定資料パネルの［AIで再読込］で役割に作品に無い「第17話」が返ると、その提案は出ず、提案の箱に断りが出て、actions.log に応答の全文が残る", async () => {
  answer = enrichAnswer();
  await withVsCode(
    "再読込の作品に無い話",
    ENRICH_EPISODES,
    async (session) => {
      const { page } = session;
      await page.keyboard.press(OPEN_SETTINGS_PRESS);
      let panel: Frame | undefined;
      await waitUntil(async () => (panel = await settingsPanelFrame(session)) !== undefined, "設定資料パネルが開く", 30_000);
      const frame = panel as Frame;
      await waitUntil(async () => (await frame.locator("#list .item").count()) >= 1, "人物が並ぶ", 15_000);
      await frame.locator("#list .item", { hasText: GRANDMA }).first().click();

      const enrichButton = frame.locator("#detail button", { hasText: "AIで再読込" });
      await waitUntil(async () => (await enrichButton.count()) === 1, "［AIで再読込］が出る", 15_000);
      await frame.locator("#detail textarea[placeholder*='他の登場人物']").fill(ENRICH_NOTES);
      const before = fake.requests.length;
      await enrichButton.click();

      // ── 画面：提案の箱に断り。第17話を挙げた役割の値は並ばず、正当な性格の提案は並ぶ
      let box = "";
      await waitUntil(
        async () => {
          await passLocalAiGate(page);
          const proposal = frame.locator("#detail .note.proposal");
          box = (await proposal.count()) > 0 ? await proposal.first().innerText() : "";
          return box !== "";
        },
        "再読込の提案の箱が出る",
        60_000
      ).catch(async (error: unknown) => {
        const detail = await frame.evaluate(() => (document.querySelector("#detail") as HTMLElement | null)?.innerText ?? "");
        throw new Error(
          `${String(error)}（${describeFakeRequests(fake.requests, before)}／詳細の欄：${JSON.stringify(detail.replace(/\s+/g, " ").slice(-400))}／` +
            `${await describeNotices(session)}）`
        );
      });
      expect(box, `提案の箱に作品に無い話の断りがありません：${box}`).toContain(CITATION_NOTICE);
      expect(box, "作品に無い話を挙げた役割の値が提案に並んでいます").not.toContain("文佳の祖母として描かれる");
      expect(box, "正当な性格の提案が並んでいません").toContain(VALID_PERSONALITY);
      // 作者の留意点が頼みに載っている（押した道が再読込であることの確かめ）
      expect(
        fake.requests.slice(before).some((request) => request.user.includes(ENRICH_NOTES)),
        `留意点を載せた頼みが届いていません（${describeFakeRequests(fake.requests, before)}）`
      ).toBe(true);

      // ── ログ：見出しと、応答の全文
      const logFile = path.join(session.workFolder, ".aiwriter", "logs", "actions.log");
      let log = "";
      await waitUntil(
        async () => {
          log = await readFile(logFile, "utf8").catch(() => "");
          return log.includes(CITATION_LOG_HEAD);
        },
        "actions.log に「作品に無い話を挙げていたもの」が書かれる",
        15_000
      ).catch((error: unknown) => {
        throw new Error(`${String(error)}（actions.log の末尾：${JSON.stringify(log.slice(-600))}）`);
      });
      const entry = log.slice(log.lastIndexOf(CITATION_LOG_HEAD));
      expect(entry, "ログに項目と話数がありません").toContain("役割：第17話");
      expect(entry, "ログに応答の全文が残っていません").toContain(UNKNOWN_ROLE);
      expect(entry, "ログに応答の全文が残っていません").toContain(VALID_PERSONALITY);
    },
    fakeOllamaLaunch(fake, {
      keybindings: [{ key: OPEN_SETTINGS_KEY, command: "novelai.openSettingsPanel" }],
      prepareWork: async ({ workFolder }) => {
        await writeCharactersTo(defaultCharactersFolder(workFolder), [
          { ...emptyCharacter("char_001", GRANDMA), appearedChapters: [1, 2] },
        ]);
      },
    })
  );
});
