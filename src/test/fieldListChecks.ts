import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { AIRegistry } from "../ai/registry";
import type { GenerateParams } from "../ai/types";
import { CharacterStore } from "../core/characterStore";
import { ChunkCache } from "../core/chunkCache";
import { splitIntoChunks } from "../core/chunker";
import { PENDING_DIR } from "../core/pendingUpdateFormat";
import { EPISODE_PLOTS_DIR } from "../core/resumeSheet";
import { scaffoldWorkFolder } from "../core/workRegistry";
import { applyPendingCharacterUpdates } from "../features/applyPendingUpdates";
import { checkTypos } from "../features/checkTypos";
import {
  characterExtractCacheKey,
  extractCharacters,
} from "../features/extractCharacters";
import { openPlotMode } from "../features/plotModePanel";
import { ProposalPanel } from "../features/proposalPanel";
import { openSettingsPanel } from "../features/settingsPanel";
import { settingsPropose } from "../mcp/tools/propose";
import { emptyCharacter, type Character } from "../models/character";
import { AIWRITER_DIR, type WorkEntry } from "../models/types";

/**
 * 実機確認リスト（`docs/実機確認リスト.md`）の項目のうち、**機械で確かめられる部分**を
 * 本物の拡張機能ホストで通す（2026-09-26。作者の方針「機械にできる確認はテストへ」
 * 「実機確認はファイル優先。画面を撮るのは組まれた見た目と押して初めて起きることだけ」）。
 *
 * ## ここで見るもの・見ないもの
 *
 * - **見る**：押して初めて起きること——画面から届くのと同じ用件をパネルへ渡し、
 *   その結果として**ファイル・台帳・パネルへ送った中身（文字列）**が正しいか
 * - **見ない**：組まれた見た目（並び・はみ出し・帯が上に見えるか）。これは
 *   実機確認リストに1行ずつ残してある
 *
 * ## 作り物にするもの
 *
 * - **AIの答え**：チャンクの覚え（キャッシュ）へ先に答えを置くか、生成を返すだけの
 *   作り物のAIを渡す。**Ollama・さくらのAIへは一度も送らない**
 * - **作品**：一時フォルダーに作る。作者の原稿・確認用コピーには触れない
 *
 * パネル（設定資料・提案・プロットモード）は**本物**を開く。画面の中（WebView の DOM）は
 * 拡張機能の側から読めないので、`createWebviewPanel` を包んで、パネルが画面へ送った
 * 用件（`postMessage`）と画面の HTML を控える。
 */

type RunCase = (name: string, test: () => Promise<void>) => Promise<void>;

export async function runFieldListChecks(runCase: RunCase): Promise<void> {
  await runCase(
    "実機確認 0.89.14：落とす前に置かれた外部AIの案は、承認の出口で落とした値を並べず、採っても値が戻らない",
    checkPendingProposalSkipsDroppedValue
  );
  await runCase(
    "実機確認 0.89.8：食い違いの値ごとの［「…」は誤り（落とす）］を押すと、落とした値の行へ移り、本体の値なら欄が替わる",
    checkDropConflictValueFromPanel
  );
  await runCase(
    "実機確認 0.89.8：落とした値は、設定資料の抽出を走らせ直しても conflicts に戻らない",
    checkDroppedValueSurvivesReextraction
  );
  await runCase(
    "実機確認 0.89.12：プロットモードは episode_0005.md を並べず、名前の知らせをパネルの上の帯へ送る",
    checkPlotModeMisnamedNotice
  );

  // 誤字脱字の採否（0.89.7）と「AIチューニングの記録」の節は、同じ作品を使う。
  // 記録の節は**拡張機能に登録された作品**の記録を数えるので、作品を本物の
  // コマンドで登録し、判断を残したあとで記録を開く
  const shared: { root?: string; work?: WorkEntry } = {};
  try {
    await runCase(
      "実機確認 0.89.7：誤字脱字を1件適用・1件無視すると ai-verdicts.jsonl に accepted と dismissed がモデル名つきで残る",
      () => checkTypoVerdictsRecorded(shared)
    );
    await runCase(
      "実機確認 0.89.7：「AIチューニングの記録」に「作者が採った指摘の率」の節が出て、10件未満は率を出さない",
      () => checkTuningStatsVerdictSection(shared)
    );
  } finally {
    if (shared.root) await removeTemporary(shared.root);
  }
}

// ─────────────────────────────────────────────────────────────
// 0.89.14：承認の出口の落とした値（`settlePendingRejectedValues`）
// ─────────────────────────────────────────────────────────────

/**
 * 実機確認リストの手順どおりに通す。
 *
 * 1. 人物の食い違い（黒髪／銀髪）がある作品に、**外部AIの案（`novel.propose`）を先に置く**
 *    ——外見を銀髪へ、役割を案内役へ
 * 2. 設定資料パネルで［「銀髪」は誤り（落とす）］を押す（画面が送るのと同じ用件）
 * 3. 「設定資料更新分反映」を提案パネルへ出す（`applyPendingCharacterUpdates`）
 * 4. 並んだ案を「反映」する（提案パネルへ画面と同じ用件を送る）
 */
async function checkPendingProposalSkipsDroppedValue(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "novel-ai-assistant-field-pending-"));
  const webviews = captureWebviews();
  try {
    const work = await prepareConflictedWork(root);

    // ── 1. 落とす前に、外部AIの案を承認待ちへ置く（MCP の道具そのもの）
    // `novel.propose` の人物の道（recordKind を省いたとき）そのもの
    const proposed = settingsPropose({
      folder: work.folderPath,
      name: "灯",
      changes: { appearance: "銀髪", role: "案内役" },
      reason: "第1話の描写に合わせる",
    });
    assert.deepEqual([...proposed.changedFields].sort(), ["appearance", "role"]);
    assert.equal(proposed.skippedRejectedValues.length, 0, "落とす前なので取り下げはまだ無いはず");

    // ── 2. 設定資料パネルで［「銀髪」は誤り（落とす）］
    const settings = await openSettingsPanel(fakeContext(), work, idleRegistry());
    await pressSettingsPanel(settings, {
      type: "dropConflictValue",
      kind: "character",
      id: "char_001",
      field: "appearance",
      value: "銀髪",
    });
    const dropped = await readCharacter(work, "char_001");
    assert.deepEqual((dropped.rejectedValues ?? []).map((entry) => entry.value), ["銀髪"]);
    assert.equal(dropped.conflicts.length, 0);

    // ── 3. 「設定資料更新分反映」を提案パネルへ
    const proposalPanel = new ProposalPanel();
    await applyPendingCharacterUpdates(work, proposalPanel);
    const updates = recordUpdatesOf(proposalPanel);
    assert.equal(updates.length, 1, `承認待ちが1件並ぶはず: ${JSON.stringify(updates)}`);
    const [update] = updates;
    // 出どころの欄（画面の一行の説明）に、除いたことと件数を黙らずに出す
    assert.ok(
      update.source.includes("——作者が誤りとして落とした値なので除きました（1件）"),
      `出どころの欄に除いた断りがありません: ${update.source}`
    );
    const labels = update.changeParts.map((part) => part.label);
    assert.ok(!labels.includes("外見"), `落とした値の欄が差分に並んでいます: ${labels.join("、")}`);
    assert.ok(labels.includes("役割"), `ほかの欄の提案まで消えています: ${labels.join("、")}`);
    const shown = JSON.stringify(update.changes);
    assert.ok(!shown.includes("銀髪"), `差分の行に落とした値が出ています: ${shown}`);

    // ── 4. 反映を押す。**ファイルで読む**：値が本体・食い違い・変化の記録へ戻らない
    await pressProposalPanel(proposalPanel, { type: "apply", id: update.id });
    const approved = await readCharacter(work, "char_001");
    assert.equal(approved.role, "案内役", "ほかの欄の提案が反映されていません");
    assert.equal(approved.appearance, "黒髪");
    assert.ok(
      !approved.conflicts.some((entry) => entry.values.includes("銀髪")),
      `conflicts に落とした値が戻りました: ${JSON.stringify(approved.conflicts)}`
    );
    assert.ok(
      !approved.changes.some((entry) => entry.value.trim() === "銀髪"),
      `changes に落とした値が戻りました: ${JSON.stringify(approved.changes)}`
    );
    assert.deepEqual((approved.rejectedValues ?? []).map((entry) => entry.value), ["銀髪"]);
    assert.deepEqual(await pendingFiles(work), [], "反映したのに承認待ちが残っています");
  } finally {
    webviews.dispose();
    await removeTemporary(root);
  }
}

// ─────────────────────────────────────────────────────────────
// 0.89.8：食い違いの値を［誤り（落とす）］で落とす
// ─────────────────────────────────────────────────────────────

/** 長い値（札には頭だけ出す）。精査 F4 の形——同じ話に別人の記述が混ざった */
const LONG_VALUE = "学院で最も古い図書館の司書を務める、物静かな老魔法使い。";

async function checkDropConflictValueFromPanel(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "novel-ai-assistant-field-drop-"));
  const webviews = captureWebviews();
  try {
    const work = await prepareConflictedWork(root);
    const plum: Character = {
      ...emptyCharacter("char_002", "プラム"),
      summary: "明るい見習い魔法使い。",
      appearedChapters: [1],
      conflicts: [
        {
          field: "summary",
          values: ["明るい見習い魔法使い。", LONG_VALUE],
          chapters: [1],
          note: null,
          observations: [
            { value: "明るい見習い魔法使い。", chapters: [1] },
            { value: LONG_VALUE, chapters: [1], evidence: "銀の髪の少女が振り返った。" },
          ],
        },
      ],
    };
    await new CharacterStore(work).saveOrUpdate(plum);

    const settings = await openSettingsPanel(fakeContext(), work, idleRegistry());
    const page = webviews.find("novelai.settings");
    // 画面の組み立て（HTML）が、札の文字と「指を載せると全文」の title を描き、
    // 押すと拡張機能が組んだ値をそのまま送り返す形になっているか
    const html = page.panel.webview.html;
    for (const wiring of [
      "valueButton.textContent = valueAction.label",
      "valueButton.title = valueAction.title",
      "value: valueAction.value",
    ]) {
      assert.ok(html.includes(wiring), `設定資料パネルの画面に「${wiring}」がありません`);
    }

    // ── 値ごとに札が並ぶ（人物を選んだときに画面へ送る中身）
    await pressSettingsPanel(settings, { type: "select", kind: "character", id: "char_001" });
    const akari = lastDetail(page.messages, "char_001");
    const akariLine = referenceLine(akari, "変化かもしれない（appearance）");
    assert.deepEqual(
      akariLine.valueActions?.map((action) => [action.label, action.value, action.kind]),
      [
        ["「黒髪」は誤り（落とす）", "黒髪", "dropConflictValue"],
        ["「銀髪」は誤り（落とす）", "銀髪", "dropConflictValue"],
      ]
    );

    await pressSettingsPanel(settings, { type: "select", kind: "character", id: "char_002" });
    const plumLine = referenceLine(lastDetail(page.messages, "char_002"), "変化かもしれない（summary）");
    const longAction = plumLine.valueActions?.find((action) => action.value === LONG_VALUE);
    assert.ok(longAction, "長い値の札がありません");
    assert.equal(longAction.label, "「学院で最も古い図書館の司…」は誤り（落とす）", "長い値は頭だけのはず");
    assert.ok(longAction.title.includes(LONG_VALUE), "指を載せたときの全文（title）がありません");

    // ── 後から来た値（銀髪）を押す：行が消え、落とした値の行へ移る。欄は変わらない
    await pressSettingsPanel(settings, {
      type: "dropConflictValue",
      kind: "character",
      id: "char_001",
      field: "appearance",
      value: "銀髪",
    });
    const saved = lastSaved(page.messages);
    assert.ok(saved.notice.includes("誤りとして落としました"), saved.notice);
    const afterAkari = saved.detail;
    assert.ok(
      !afterAkari.reference.some((line) => line.label === "変化かもしれない（appearance）"),
      "落としたのに食い違いの行が残っています"
    );
    const rejectedLine = referenceLine(afterAkari, "誤りとして落とした値（appearance）");
    assert.ok(rejectedLine.value.includes("銀髪"), rejectedLine.value);
    // **ファイルで読める**：落とした値は rejectedValues に残り、conflicts から消える
    const akariFile = await readCharacter(work, "char_001");
    assert.equal(akariFile.appearance, "黒髪");
    assert.deepEqual(akariFile.conflicts, []);
    assert.deepEqual(
      (akariFile.rejectedValues ?? []).map((entry) => [entry.field, entry.value, entry.chapters]),
      [["appearance", "銀髪", [1]]]
    );

    // ── 本体の値（明るい見習い魔法使い。）を押す：欄が残った値に替わる
    await pressSettingsPanel(settings, {
      type: "dropConflictValue",
      kind: "character",
      id: "char_002",
      field: "summary",
      value: "明るい見習い魔法使い。",
    });
    const replaced = lastSaved(page.messages);
    assert.ok(replaced.notice.includes("欄は「"), `欄を替えたと伝えていません: ${replaced.notice}`);
    const plumFile = await readCharacter(work, "char_002");
    assert.equal(plumFile.summary, LONG_VALUE, "本体の値を落としたのに欄が替わっていません");
    assert.deepEqual(plumFile.conflicts, []);
    assert.deepEqual((plumFile.rejectedValues ?? []).map((entry) => entry.value), ["明るい見習い魔法使い。"]);
  } finally {
    webviews.dispose();
    await removeTemporary(root);
  }
}

/**
 * 落としたあとに抽出を走らせ直す。
 *
 * **AIの答えはチャンクの覚えへ先に置く**（既存の「キャッシュ済みAI応答を検証して
 * 人物抽出を保存する」と同じ形）。鍵は製品と同じ `characterExtractCacheKey` で、
 * 落としたあとの顔ぶれから作る——生成が呼ばれたら落とす。
 */
async function checkDroppedValueSurvivesReextraction(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "novel-ai-assistant-field-reextract-"));
  const webviews = captureWebviews();
  const informationDescriptor = Object.getOwnPropertyDescriptor(vscode.window, "showInformationMessage");
  const warningDescriptor = Object.getOwnPropertyDescriptor(vscode.window, "showWarningMessage");
  assert.ok(informationDescriptor?.configurable && warningDescriptor?.configurable);
  try {
    const work = await prepareConflictedWork(root);
    const settings = await openSettingsPanel(fakeContext(), work, idleRegistry());
    await pressSettingsPanel(settings, {
      type: "dropConflictValue",
      kind: "character",
      id: "char_001",
      field: "appearance",
      value: "銀髪",
    });

    // 本文は同じ第1話。AIはまた「銀髪」と読んだ（落とした値そのもの）
    const loaded = await new CharacterStore(work).loadAll();
    assert.equal(loaded.errors.length, 0);
    const model = "fixture-extract-model";
    const episodePath = path.join(work.folderPath, "本文", "001.txt");
    const body = await fs.readFile(episodePath, "utf8");
    const chunks = splitIntoChunks(episodePath, body, 1, 1, { maxChars: 1000 });
    const cache = new ChunkCache(work);
    await cache.load();
    await cache.set(chunks[0].hash, characterExtractCacheKey("ollama", model, loaded.characters), {
      characters: [
        {
          name: "灯",
          entityType: "person",
          appearance: "銀髪",
          // 覚えた答えが本当に読まれたかの目印（空の欄を埋める＝承認待ちへ回る）。
          // これが無いと、答えが素通りしても「戻らなかった」で通ってしまう
          personality: "物おじしない",
          evidence: "銀の髪の少女が振り返った。",
        },
      ],
    });
    await cache.save();

    const registry = {
      resolve: () => ({
        provider: {
          id: "ollama",
          displayName: "作り物のAI",
          isPaid: false,
          generate: async () => {
            throw new Error("覚えてある答えがあるのに、AIを呼んではいけません");
          },
        },
        model,
      }),
      resolveModelInfo: async () => ({ contextWindow: 8192 }),
    } as unknown as AIRegistry;

    const notices: string[] = [];
    const record = (message: unknown): Promise<undefined> => {
      notices.push(String(message));
      return Promise.resolve(undefined);
    };
    Object.defineProperty(vscode.window, "showInformationMessage", { configurable: true, value: record });
    Object.defineProperty(vscode.window, "showWarningMessage", { configurable: true, value: record });
    try {
      await extractCharacters(work, registry);
    } finally {
      Object.defineProperty(vscode.window, "showInformationMessage", informationDescriptor);
      Object.defineProperty(vscode.window, "showWarningMessage", warningDescriptor);
    }

    // **ファイルで読める**：台帳の conflicts に戻らない
    const after = await readCharacter(work, "char_001");
    assert.equal(after.appearance, "黒髪");
    assert.ok(
      !after.conflicts.some((entry) => entry.values.includes("銀髪")),
      `抽出のあと conflicts に落とした値が戻りました: ${JSON.stringify(after.conflicts)}\n知らせ: ${notices.join(" / ")}`
    );
    assert.deepEqual((after.rejectedValues ?? []).map((entry) => entry.value), ["銀髪"]);
    // 答えは読まれ、ほかの欄の更新は承認待ちへ回った。その案の中にも立て直さない
    const staged = await pendingFiles(work);
    assert.equal(
      staged.length,
      1,
      `覚えた答えが抽出に使われていません（承認待ちが ${staged.length} 件）\n知らせ: ${notices.join(" / ")}`
    );
    assert.ok((await fs.readFile(staged[0], "utf8")).includes("物おじしない"));
    for (const file of staged) {
      const text = await fs.readFile(file, "utf8");
      const pending = JSON.parse(text) as { character?: Character } & Partial<Character>;
      const character = (pending.character ?? pending) as Character;
      assert.ok(
        !(character.conflicts ?? []).some((entry) => entry.values.includes("銀髪")),
        `承認待ちの案に落とした値の食い違いがあります: ${text}`
      );
      assert.notEqual(character.appearance, "銀髪", `承認待ちの案が欄を落とした値へ戻そうとしています: ${text}`);
    }
  } finally {
    webviews.dispose();
    await removeTemporary(root);
  }
}

// ─────────────────────────────────────────────────────────────
// 0.89.12：プロットモードの名前の知らせ（`misnamedEpisodePlots`）
// ─────────────────────────────────────────────────────────────

async function checkPlotModeMisnamedNotice(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "novel-ai-assistant-field-plot-"));
  const webviews = captureWebviews();
  try {
    const workFolder = path.join(root, "プロットの作品");
    await scaffoldWorkFolder(workFolder, "プロットの作品");
    const work = makeWork(workFolder, "work_field_plot");
    await fs.writeFile(path.join(workFolder, "本文", "001.txt"), "　灯が歩いた。\n", "utf8");
    const plots = path.join(workFolder, "設定", EPISODE_PLOTS_DIR);
    await fs.mkdir(plots, { recursive: true });
    await fs.writeFile(path.join(plots, "第1話.md"), "第1話の予定\n", "utf8");
    // 手で置いた、形の違う名前（確認用コピーの `たゆたう鉛_確認用` と同じ）
    await fs.writeFile(path.join(plots, "episode_0005.md"), "第5話の案\n", "utf8");

    await openPlotMode(fakeContext(), work);
    const page = webviews.find("novelai.plotMode");
    const data = await waitForMessage(page.messages, (message) => {
      const candidate = message as { type?: string; data?: { notice?: string } };
      return candidate.type === "plotMode" ? candidate.data : undefined;
    });
    assert.ok(
      data.notice?.includes(
        "名前が「第N話.md」の形でないため並べていないファイルがあります：episode_0005.md（「第5話.md」にすると並びます）"
      ),
      `パネルへ送った知らせに名前の断りがありません: ${data.notice}`
    );
    // 帯はパネルの上の #notice。送った知らせを入れる口があるか（見た目は画面で見る）
    const html = page.panel.webview.html;
    assert.ok(html.includes('<div id="notice"></div>'), "プロットモードの画面に知らせの帯がありません");
    assert.ok(html.includes("el.notice.textContent = data.notice"), "知らせの帯へ知らせを入れていません");
    // 並べない・名前は変えない（作者のファイル）
    const listed = JSON.stringify((data as { episodes?: unknown }).episodes ?? []);
    assert.ok(!listed.includes("第5話"), `形の違う名前の話が一覧に並んでいます: ${listed}`);
    assert.deepEqual((await fs.readdir(plots)).sort(), ["episode_0005.md", "第1話.md"]);
  } finally {
    webviews.dispose();
    await removeTemporary(root);
  }
}

// ─────────────────────────────────────────────────────────────
// 0.89.7：作者が採った指摘の率
// ─────────────────────────────────────────────────────────────

const TYPO_MODEL = "fixture-typo-model";

/** 記録の中の節の見出し（`buildVerdictStatsMarkdown` が書く Markdown の見出し行） */
const VERDICT_SECTION_HEADING = /^## 作者が採った指摘の率$/mu;

/**
 * 誤字脱字の検知を**製品の関数そのもの**で走らせ（AIの答えだけ作り物）、提案パネルで
 * 1件適用・1件無視する。記録はファイルで読む。
 *
 * **作品は本物のコマンド（`novelai.addWork`）で登録する。** 次の「AIチューニングの
 * 記録」は、拡張機能に登録された作品の記録を数えるため。
 */
async function checkTypoVerdictsRecorded(shared: { root?: string; work?: WorkEntry }): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "novel-ai-assistant-field-verdict-"));
  shared.root = root;
  const workFolder = path.join(root, "採否の作品");
  await scaffoldWorkFolder(workFolder, "採否の作品");
  const episodePath = path.join(workFolder, "本文", "001.txt");
  await fs.writeFile(episodePath, "　彼は学校え行った。\n　空はとても青かた。\n", "utf8");

  /*
    **本文を置いてから登録する**（作者と同じ順）。以前は、本文フォルダーに話の
    ファイルがあると本文フォルダー自身が作品に見え、「作品にも書庫にも
    見えます」の選択が出て止まった（この試験を書いていて見つけ、
    `workCollection.ts` で作品の置き場を子の作品から外して直した。2026-09-26）。
    **ここがその直しの見張りも兼ねる。** 選択の画面は押せず、出れば登録が
    返ってこないので、選択の画面を差し替えて「出たか」を数える（出たら
    取り消して返し、名指しで落とす）
  */
  const quickPickDescriptor = Object.getOwnPropertyDescriptor(vscode.window, "showQuickPick");
  assert.ok(quickPickDescriptor?.configurable, "showQuickPick をテスト用に差し替えられません");
  const asked: string[] = [];
  Object.defineProperty(vscode.window, "showQuickPick", {
    configurable: true,
    value: async (_items: unknown, options?: { title?: string }) => {
      asked.push(options?.title ?? "（題なし）");
      return undefined;
    },
  });
  let registered: WorkEntry | undefined;
  try {
    registered = (await vscode.commands.executeCommand("novelai.addWork", {
      folderPath: workFolder,
      title: "採否の作品",
    })) as WorkEntry | undefined;
  } finally {
    Object.defineProperty(vscode.window, "showQuickPick", quickPickDescriptor);
  }
  assert.deepEqual(asked, [], `ふつうの作品の登録で選択を問われました: ${asked.join(" / ")}`);
  assert.ok(registered?.id, "作品を登録できませんでした");
  shared.work = registered;

  const sent: GenerateParams[] = [];
  const provider = {
    id: "gemini",
    displayName: "作り物のAI",
    isPaid: false,
    isConfigured: async () => true,
    testConnection: async () => ({ ok: true, message: "作り物" }),
    listModels: async () => [modelInfo()],
    getModel: async () => modelInfo(),
    generate: async (params: GenerateParams) => {
      sent.push(params);
      return {
        text: JSON.stringify({
          issues: [
            {
              line: 1,
              original: "　彼は学校え行った。",
              target: "学校え",
              suggestion: "学校へ",
              reason: "助詞の誤り",
              confidence: "high",
            },
            {
              line: 2,
              original: "　空はとても青かた。",
              target: "青かた",
              suggestion: "青かった",
              reason: "脱字",
              confidence: "high",
            },
          ],
        }),
      };
    },
  };
  const registry = {
    resolve: () => ({ provider, model: TYPO_MODEL }),
    resolveModelInfo: async () => modelInfo(),
    listProviders: () => [provider],
  } as unknown as AIRegistry;

  // まとめ実行と同じく確認を先に済ませた扱いにする（確認画面は押せない）
  const result = await checkTypos(registered, registry, { suiteConfirmed: true });
  assert.ok(result && !result.cancelled, "誤字脱字の検知が終わりませんでした");
  assert.equal(sent.length, 1, "作り物のAIへ1回だけ送るはず");

  const panel = new ProposalPanel(registry);
  panel.showResults(registered, result.issues);
  const items = issueItemsOf(panel);
  const accept = items.find((item) => item.target === "学校え");
  const dismiss = items.find((item) => item.target === "青かた");
  assert.ok(accept && dismiss, `指摘が並んでいません: ${JSON.stringify(items)}`);

  await pressProposalPanel(panel, { type: "apply", id: accept.id });
  await pressProposalPanel(panel, { type: "dismiss", id: dismiss.id });

  // 本文：適用した1件だけが直り、無視した行はそのまま
  assert.equal(await fs.readFile(episodePath, "utf8"), "　彼は学校へ行った。\n　空はとても青かた。\n");

  // **ファイルで読める**：採否の記録にモデルの名前つきで2行
  const verdictPath = path.join(workFolder, AIWRITER_DIR, "history", "ai-verdicts.jsonl");
  const verdicts = (await waitForLines(verdictPath, 2)).map(
    (line) => JSON.parse(line) as { status: string; model: string; providerId: string; feature: string }
  );
  assert.deepEqual(
    verdicts.map((line) => [line.status, line.providerId, line.model, line.feature]).sort(),
    [
      ["accepted", "gemini", TYPO_MODEL, "typo"],
      ["dismissed", "gemini", TYPO_MODEL, "typo"],
    ]
  );

  // 同じ回の指摘の置き場（findings.jsonl）の行に、出したモデル（producer）
  const findingsPath = path.join(workFolder, AIWRITER_DIR, "findings.jsonl");
  const findings = await waitForLines(findingsPath, 1);
  const withProducer = findings.filter((line) => line.includes('"producer"') && line.includes(TYPO_MODEL));
  assert.ok(
    withProducer.length >= 2,
    `findings.jsonl の指摘の行に producer がありません:\n${findings.join("\n")}`
  );
}

async function checkTuningStatsVerdictSection(shared: { work?: WorkEntry }): Promise<void> {
  assert.ok(shared.work, "前の項目（誤字脱字の採否）が作品を用意できていません");
  const before = new Set(vscode.workspace.textDocuments);
  await vscode.commands.executeCommand("novelai.showTuningStats");

  let text = "";
  for (let attempt = 0; attempt < 50 && !text; attempt++) {
    const opened = vscode.workspace.textDocuments.find(
      (document) => !before.has(document) && VERDICT_SECTION_HEADING.test(document.getText())
    );
    if (opened) text = opened.getText();
    else await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(text, "「AIチューニングの記録」に「作者が採った指摘の率」の節が出ません");

  // 表（測った値）のあとに節が来る
  const section = text.search(VERDICT_SECTION_HEADING);
  assert.ok(section > 0, "節が記録の先頭に来ています（表のあとに足すはず）");
  // 誤字脱字の行：採った1・退けた1、10件未満なので率は出さない
  const row = text
    .slice(section)
    .split("\n")
    .find((line) => line.includes(TYPO_MODEL));
  assert.ok(row, `節にモデル ${TYPO_MODEL} の行がありません:\n${text.slice(section)}`);
  assert.match(row, /\| 誤字脱字 \| 1 \| 1 \| —（10件未満） \|$/u);
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
}

// ─────────────────────────────────────────────────────────────
// 下ごしらえ
// ─────────────────────────────────────────────────────────────

/**
 * 同じ第1話の中で外見が食い違う人物（黒髪／銀髪）がいる作品。
 * 本体は作者の値（黒髪）。autoGenerated のまま（抽出が付け足してよい人物）
 */
async function prepareConflictedWork(root: string): Promise<WorkEntry> {
  const workFolder = path.join(root, "食い違いの作品");
  await scaffoldWorkFolder(workFolder, "食い違いの作品");
  const work = makeWork(workFolder, "work_field_conflict");
  await fs.writeFile(
    path.join(workFolder, "本文", "001.txt"),
    "黒い髪を揺らして灯が歩いた。銀の髪の少女が振り返った。",
    "utf8"
  );
  const akari: Character = {
    ...emptyCharacter("char_001", "灯"),
    appearance: "黒髪",
    role: "見習い",
    appearedChapters: [1],
    conflicts: [
      {
        field: "appearance",
        values: ["黒髪", "銀髪"],
        chapters: [1],
        note: null,
        observations: [
          { value: "黒髪", chapters: [1], evidence: "黒い髪を揺らして" },
          { value: "銀髪", chapters: [1], evidence: "銀の髪の少女" },
        ],
      },
    ],
  };
  await new CharacterStore(work).saveOrUpdate(akari);
  return work;
}

function makeWork(folderPath: string, id: string): WorkEntry {
  return {
    id,
    title: path.basename(folderPath),
    folderPath,
    registeredAt: "2026-09-26T00:00:00.000Z",
  };
}

function modelInfo() {
  return {
    id: TYPO_MODEL,
    displayName: TYPO_MODEL,
    contextWindow: 32768,
    parameterSize: "31B",
    capabilities: [],
    tier: "high" as const,
  };
}

/** パネルが保存するのに使う器。保存の約束（subscriptions）だけを持つ */
function fakeContext(): vscode.ExtensionContext {
  return { subscriptions: [] } as unknown as vscode.ExtensionContext;
}

/** AIを使わない場面のパネルへ渡す登録簿（呼ばれたら落ちるよう、何も返さない） */
function idleRegistry(): AIRegistry {
  return {
    resolve: () => undefined,
    listProviders: () => [],
  } as unknown as AIRegistry;
}

async function readCharacter(work: WorkEntry, id: string): Promise<Character> {
  const loaded = await new CharacterStore(work).loadAll();
  assert.equal(loaded.errors.length, 0, JSON.stringify(loaded.errors));
  const found = loaded.characters.find((character) => character.id === id);
  assert.ok(found, `${id} が台帳にありません`);
  return found;
}

async function pendingFiles(work: WorkEntry): Promise<string[]> {
  const directory = path.join(work.folderPath, AIWRITER_DIR, PENDING_DIR);
  try {
    return (await fs.readdir(directory))
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(directory, name));
  } catch {
    return [];
  }
}

async function removeTemporary(root: string): Promise<void> {
  // 書き終えた直後のログ（.aiwriter/logs）が残っていることがある（run.ts と同じ待ち方）
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

// ── パネルへ、画面と同じ用件を渡す

interface PrivatePanel {
  handleMessage(message: unknown): Promise<void>;
}

async function pressSettingsPanel(panel: unknown, message: Record<string, unknown>): Promise<void> {
  await (panel as PrivatePanel).handleMessage(message);
}

async function pressProposalPanel(panel: ProposalPanel, message: Record<string, unknown>): Promise<void> {
  await (panel as unknown as PrivatePanel).handleMessage(message);
}

interface RecordUpdateRow {
  id: string;
  source: string;
  changes: unknown;
  changeParts: Array<{ label: string }>;
}

function recordUpdatesOf(panel: ProposalPanel): RecordUpdateRow[] {
  return (panel as unknown as { recordUpdates: RecordUpdateRow[] }).recordUpdates;
}

function issueItemsOf(panel: ProposalPanel): Array<{ id: string; target: string }> {
  return (panel as unknown as { items: Array<{ id: string; target: string }> }).items;
}

// ── パネルが画面へ送った中身を控える

interface CapturedPanel {
  viewType: string;
  panel: vscode.WebviewPanel;
  messages: unknown[];
}

/**
 * `createWebviewPanel` を包み、作られたパネルと、画面へ送った用件を控える。
 *
 * **画面そのもの（DOM）は拡張機能の側から読めない。** 送った中身と HTML は
 * 読めるので、「何を出すか」はここで、「どう見えるか」は実機で確かめる。
 */
function captureWebviews(): {
  find(viewType: string): CapturedPanel;
  dispose(): void;
} {
  const descriptor = Object.getOwnPropertyDescriptor(vscode.window, "createWebviewPanel");
  assert.ok(descriptor?.configurable, "createWebviewPanel をテスト用に包めません");
  const original = vscode.window.createWebviewPanel;
  const captured: CapturedPanel[] = [];
  Object.defineProperty(vscode.window, "createWebviewPanel", {
    configurable: true,
    value: (...args: Parameters<typeof vscode.window.createWebviewPanel>) => {
      const panel = original.apply(vscode.window, args);
      const entry: CapturedPanel = { viewType: args[0], panel, messages: [] };
      const post = panel.webview.postMessage.bind(panel.webview);
      Object.defineProperty(panel.webview, "postMessage", {
        configurable: true,
        value: (message: unknown) => {
          entry.messages.push(message);
          return post(message);
        },
      });
      captured.push(entry);
      return panel;
    },
  });
  return {
    find(viewType) {
      const found = captured.find((entry) => entry.viewType === viewType);
      assert.ok(found, `${viewType} のパネルが開いていません（開いたもの：${captured.map((entry) => entry.viewType).join("、")}）`);
      return found;
    },
    dispose() {
      Object.defineProperty(vscode.window, "createWebviewPanel", descriptor);
      for (const entry of captured) entry.panel.dispose();
    },
  };
}

async function waitForMessage<T>(messages: unknown[], pick: (message: unknown) => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt++) {
    for (let index = messages.length - 1; index >= 0; index--) {
      const found = pick(messages[index]);
      if (found !== undefined) return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`期待した用件が画面へ送られていません: ${JSON.stringify(messages).slice(0, 2000)}`);
}

interface DetailReference {
  label: string;
  value: string;
  valueActions?: Array<{ label: string; title: string; field: string; value: string; kind: string }>;
}

interface DetailMessage {
  id: string;
  reference: DetailReference[];
}

function lastDetail(messages: unknown[], id: string): DetailMessage {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { type?: string; detail?: DetailMessage };
    if ((message.type === "detail" || message.type === "saved") && message.detail?.id === id) {
      return message.detail;
    }
  }
  throw new Error(`${id} の詳細が画面へ送られていません: ${JSON.stringify(messages.map((m) => (m as { type?: string }).type))}`);
}

function lastSaved(messages: unknown[]): { detail: DetailMessage; notice: string } {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { type?: string; detail?: DetailMessage; notice?: string };
    if (message.type === "saved" && message.detail) {
      return { detail: message.detail, notice: message.notice ?? "" };
    }
  }
  throw new Error("保存のあとの詳細（saved）が画面へ送られていません");
}

function referenceLine(detail: DetailMessage, label: string): DetailReference {
  const line = detail.reference.find((entry) => entry.label === label);
  assert.ok(line, `「${label}」の行がありません（${detail.reference.map((entry) => entry.label).join("、")}）`);
  return line;
}

async function waitForLines(filePath: string, count: number): Promise<string[]> {
  let lines: string[] = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      lines = (await fs.readFile(filePath, "utf8")).split("\n").filter((line) => line.trim().length > 0);
      if (lines.length >= count) return lines;
    } catch {
      // まだ書かれていない（指摘の置き場は待たずに書く）
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${filePath} に ${count} 行がそろいません（いま ${lines.length} 行）`);
}
