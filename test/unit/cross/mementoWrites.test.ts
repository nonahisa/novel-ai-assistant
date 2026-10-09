import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * globalState・workspaceState へ書く所の見張り（0.97.4。設計書5.7.8）。
 *
 * VS Code の globalState は鍵を1つの塊で持ち、先に書いた別の鍵の送り返しが
 * あとから届くと、あとで書いた鍵が消える（実物の 1.90・1.138 で約9割）。
 * 0.97.3 で登録簿だけを守り、0.97.4 で作者の設定・判断・作品にかかわる鍵を
 * すべて `verifiedState`（書いたら読み返す・しばらく見張る）へ通した。
 *
 * ここで見張るのは3つ。
 *
 * 1. **素の `globalState.update(` / `workspaceState.update(` が残っていない**
 * 2. **素の `globalState` / `workspaceState` を、値として部品へ渡していない**
 *    （`AdvicePolicyStore(context.globalState)` のように渡すと、部品の中の
 *    `this.state.update(` が守られないまま書く。1だけでは見つからない抜け道）
 * 3. **鍵ごとに書く口が1か所**（下の表。同じ鍵を2か所で書くと、片方だけ
 *    守りを忘れる）。鍵の文字列も1つのファイルにしか無い
 *
 * 守らずに残してよいのは、消えても困らないものだけ。**理由を表に書く。**
 */

const SRC = resolve(__dirname, "../../../src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** コメントを除く（コメントの中の `context.globalState` を数えない） */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[\s;{}(),])\/\/.*$/gm, "$1");
}

/** 1行の文字列（"…" と '…'）の中身を除く（ログの文言に出る「globalState」を数えない） */
function stripStrings(code: string): string {
  return code.replace(/"(?:[^"\\\n]|\\.)*"/g, '""').replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

const files = walk(SRC).map((full) => {
  const code = stripComments(readFileSync(full, "utf8"));
  return {
    rel: relative(SRC, full).split("\\").join("/"),
    code,
    bare: stripStrings(code),
  };
});

/**
 * 素のまま扱ってよい所（**理由を必ず書く**）。
 * 値は「そのファイルで許す、素の `globalState`/`workspaceState` の数」
 */
const RAW_ALLOWED: Record<string, { count: number; reason: string }> = {
  "core/workRegistry.ts": {
    count: 2,
    reason:
      "登録簿（novelai.works）は 0.97.3 から自前で updateVerified・watchForLateLoss を通している" +
      "（見張りの期間にある変更をした順に当てる独自の形）",
  },
  "extension.ts": {
    count: 1,
    reason:
      "作品一覧の控え（novelai.workList.snapshot）。走査のたびに書き直す控えで、" +
      "消えても次の起動で1回走査を待つだけ。作者の設定でも判断でもない",
  },
  "core/verifiedMemento.ts": {
    count: 1,
    reason: "守りそのもの。失敗の文言（テンプレート文字列）に鍵の置き場の名前として出るだけ",
  },
};

describe("globalState・workspaceState への素の書き込みが無い", () => {
  test("素の update を呼ぶ所が無い", () => {
    const offenders = files
      .filter(({ bare }) => /\b(globalState|workspaceState)\s*\.\s*update\s*\(/.test(bare))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  test("素の保管庫を値として渡す所は、許した所だけ", () => {
    const found: Record<string, number> = {};
    for (const { rel, bare: code } of files) {
      const pattern = /(verifiedState\(\s*(?:[\w$]+\.)*)?\b(globalState|workspaceState)\b(?![\w$])/g;
      for (const match of code.matchAll(pattern)) {
        if (match[1]) continue; // verifiedState( で包んでいる
        const after = code.slice((match.index ?? 0) + match[0].length);
        // 読むだけ（get・keys）は守らなくてよい
        if (/^\s*\.\s*(get|keys)\s*[<(]/.test(after)) continue;
        // 名前としての出現（オブジェクトの鍵・型の欄）は値ではない
        if (/^\s*\??\s*:/.test(after)) continue;
        found[rel] = (found[rel] ?? 0) + 1;
      }
    }
    const allowed = Object.fromEntries(
      Object.entries(RAW_ALLOWED).map(([rel, entry]) => [rel, entry.count])
    );
    expect(found).toEqual(allowed);
  });
});

/**
 * 鍵の表（設計書5.7.8 の表と同じもの）。
 *
 * - `literalIn`：鍵の文字列を持つファイル（**ここ以外に同じ文字列を置かない**）
 * - `writtenIn`・`write`：書く口のファイルと、その呼び出しの形。**ちょうど1回**
 * - `guarded`：false のものは理由を `reason` に書く
 */
interface KeyRow {
  key: string;
  literalIn: string;
  writtenIn: string;
  write: RegExp;
  guarded: boolean;
  reason?: string;
  /** 同じ文字列を鍵でない用途に使うファイル（理由つき） */
  otherUses?: Record<string, string>;
}

const KEYS: KeyRow[] = [
  {
    key: "novelai.works",
    literalIn: "core/workRegistry.ts",
    writtenIn: "core/workRegistry.ts",
    write: /updateVerified<WorkEntry\[\]>\(this\.context\.globalState, STORAGE_KEY/g,
    guarded: true,
    otherUses: { "extension.ts": "作品一覧の画面の名前（createTreeView の id）。保管庫の鍵ではない" },
  },
  { key: "novelai.ai.provider", literalIn: "ai/registry.ts", writtenIn: "ai/registry.ts", write: /\.update\(KEY_PROVIDER\b/g, guarded: true },
  { key: "novelai.ai.model", literalIn: "ai/registry.ts", writtenIn: "ai/registry.ts", write: /\.update\(KEY_MODEL\b/g, guarded: true },
  { key: "novelai.ai.featureAssignments", literalIn: "ai/registry.ts", writtenIn: "ai/registry.ts", write: /\.patch<FeatureAssignments>\(\s*KEY_FEATURE_ASSIGNMENTS\b/g, guarded: true },
  { key: "novelai.gemini.support.v3.", literalIn: "ai/geminiProvider.ts", writtenIn: "ai/geminiProvider.ts", write: /\.update\(supportKey\(model\)/g, guarded: true },
  { key: "novelai.claude.support.v6.", literalIn: "ai/claudeProvider.ts", writtenIn: "ai/claudeProvider.ts", write: /\.update\(supportKey\(model\)/g, guarded: true },
  { key: "novelai.deviceId", literalIn: "core/device.ts", writtenIn: "core/device.ts", write: /\.patch<string \| undefined>\(\s*DEVICE_ID_KEY\b/g, guarded: true },
  { key: "novelai.unsentAtClose", literalIn: "core/unsentMark.ts", writtenIn: "core/unsentMark.ts", write: /\.update\(UNSENT_MARK_KEY\b/g, guarded: true },
  { key: "novelai.advicePolicy.", literalIn: "core/advicePolicyStore.ts", writtenIn: "core/advicePolicyStore.ts", write: /verifiedState\(this\.state\)\.update\(key, profile\)/g, guarded: true },
  { key: "novelai.advicePolicyDefault", literalIn: "core/advicePolicyStore.ts", writtenIn: "core/advicePolicyStore.ts", write: /verifiedState\(this\.state\)\.update\(key, profile\)/g, guarded: true },
  { key: "novelai.authorReaderType", literalIn: "core/authorReaderTypeStore.ts", writtenIn: "core/authorReaderTypeStore.ts", write: /\.update\(AUTHOR_READER_TYPE_KEY\b/g, guarded: true },
  { key: "novelai.writerProfile", literalIn: "core/writerProfileStore.ts", writtenIn: "core/writerProfileStore.ts", write: /\.update\(WRITER_PROFILE_KEY\b/g, guarded: true },
  { key: "novelai.writerWelcome", literalIn: "core/writerProfileStore.ts", writtenIn: "core/writerProfileStore.ts", write: /\.update\(WRITER_WELCOME_KEY\b/g, guarded: true },
  { key: "novelai.advicePolicyMirrorAt", literalIn: "features/adviceProfileMirror.ts", writtenIn: "features/adviceProfileMirror.ts", write: /\.patch<MirrorStamps>\(\s*KEY_MIRROR_AT\b/g, guarded: true },
  { key: "novelai.writerProfileMirrorAt", literalIn: "features/adviceProfileMirror.ts", writtenIn: "features/adviceProfileMirror.ts", write: /\.update\(KEY_WRITER_MIRROR_AT\b/g, guarded: true },
  { key: "novelai.firstRun.aiSetupShown", literalIn: "features/firstRun.ts", writtenIn: "features/firstRun.ts", write: /\.update\(SHOWN_KEY\b/g, guarded: true },
  { key: "novelai.series.linkOffered", literalIn: "features/offerSeriesLink.ts", writtenIn: "features/offerSeriesLink.ts", write: /\.update\(SERIES_OFFERED_KEY\b/g, guarded: true },
  { key: "novelai.library.mergeOffered", literalIn: "features/offerLibraryMerge.ts", writtenIn: "features/offerLibraryMerge.ts", write: /\.update\(MERGE_OFFERED_KEY\b/g, guarded: true },
  { key: "novelai.library.unregisteredNotified", literalIn: "features/collectUnregisteredWorks.ts", writtenIn: "features/collectUnregisteredWorks.ts", write: /\.update\(NOTIFIED_KEY\b/g, guarded: true },
  { key: "novelai.externalAccess.lastKnockAt", literalIn: "features/externalAccessWatcher.ts", writtenIn: "features/externalAccessWatcher.ts", write: /\.patch<Record<string, string>>\(\s*SEEN_KEY\b/g, guarded: true },
  { key: "novelai.spotlight.lastHandledAt", literalIn: "features/spotlightRequestWatcher.ts", writtenIn: "features/spotlightRequestWatcher.ts", write: /\.patch<Record<string, string>>\(\s*HANDLED_KEY\b/g, guarded: true },
  { key: "novelai.schedule.lastIcsPath", literalIn: "features/scheduleCalendarExport.ts", writtenIn: "features/scheduleCalendarExport.ts", write: /\.update\(LAST_ICS_KEY\b/g, guarded: true },
  { key: "novelai.schedule.lastNoticeDay", literalIn: "features/scheduleNotify.ts", writtenIn: "features/scheduleNotify.ts", write: /\.update\(LAST_NOTICE_KEY\b/g, guarded: true },
  { key: "novelai.mcpBundlePath", literalIn: "features/writeAiInstructions.ts", writtenIn: "features/writeAiInstructions.ts", write: /\.update\(KEY_BUNDLE_PATH\b/g, guarded: true },
  { key: "novelai.tuningNudge.shown", literalIn: "features/tuningNudge.ts", writtenIn: "features/tuningNudge.ts", write: /\.patch<string\[\]>\(SHOWN_KEY\b/g, guarded: true },
  { key: "novelai.tuningNudge.muted", literalIn: "features/tuningNudge.ts", writtenIn: "features/tuningNudge.ts", write: /\.update\(MUTED_KEY\b/g, guarded: true },
  { key: "novelai.readAloud.voice", literalIn: "extension.ts", writtenIn: "extension.ts", write: /\.update\(READ_ALOUD_VOICE_KEY\b/g, guarded: true },
  { key: "novelai.manuscript.markdownDeclined", literalIn: "extension.ts", writtenIn: "extension.ts", write: /\.patch<string\[\]>\(\s*MARKDOWN_DECLINED_KEY\b/g, guarded: true },
  { key: "novelai.actions.expandedGroups", literalIn: "extension.ts", writtenIn: "extension.ts", write: /rememberInBackground\(ACTION_GROUPS_KEY\b/g, guarded: true },
  { key: "novelai.steps.expandedGroups", literalIn: "extension.ts", writtenIn: "extension.ts", write: /rememberInBackground\(STEP_GROUPS_KEY\b/g, guarded: true },
  { key: "novelai.stepMenu.selectedWorkId", literalIn: "extension.ts", writtenIn: "extension.ts", write: /rememberInBackground\(STEP_WORK_KEY\b/g, guarded: true },
  { key: "novelai.workChat.selectedWorkId", literalIn: "extension.ts", writtenIn: "extension.ts", write: /rememberInBackground\(CHAT_WORK_KEY\b/g, guarded: true },
  { key: "novelai.celebrations.global", literalIn: "features/celebrations.ts", writtenIn: "features/celebrations.ts", write: /\.update\(\s*GLOBAL_KEY\b/g, guarded: true },
  { key: "novelai.celebrations.shown", literalIn: "features/celebrations.ts", writtenIn: "features/celebrations.ts", write: /\.update\(\s*SHOWN_KEY\b/g, guarded: true },
  { key: "novelai.celebrations.streaks", literalIn: "features/celebrations.ts", writtenIn: "features/celebrations.ts", write: /\.update\(STREAK_KEY\b/g, guarded: true },
  { key: "novelai.lastBackupPickFolder", literalIn: "features/backupPickFolder.ts", writtenIn: "features/backupPickFolder.ts", write: /\.update\(\s*BACKUP_PICK_FOLDER_KEY\b/g, guarded: true },
  { key: "novelai.contests.inbox", literalIn: "features/contestImport.ts", writtenIn: "features/contestImport.ts", write: /\.update\(CONTEST_INBOX_KEY\b/g, guarded: true },
  { key: "novelai.readerStats.seenClipboard", literalIn: "features/readerStatsHelperLink.ts", writtenIn: "features/readerStatsHelperLink.ts", write: /\.update\(\s*SEEN_FINGERPRINTS_KEY\b/g, guarded: true },
  { key: "novelai.proofreadingSuite.selection", literalIn: "core/proofreadingSuite.ts", writtenIn: "features/proofreadingSuite.ts", write: /\.update\(\s*PROOFREADING_SUITE_SELECTION_KEY\b/g, guarded: true },
  { key: "novelai.imeDictionary.excluded.", literalIn: "core/imeDictionary.ts", writtenIn: "features/exportImeDictionary.ts", write: /\.update\(imeExcludedKey\(work\.id\)/g, guarded: true },
  { key: "novelai.pendingRename.", literalIn: "features/nameRename.ts", writtenIn: "features/nameRename.ts", write: /\.update\(pendingRenameKey\(workId\)/g, guarded: true },
  {
    key: "novelai.workList.snapshot",
    literalIn: "core/workListSnapshot.ts",
    writtenIn: "views/workTree.ts",
    write: /\.update\(\s*WORK_LIST_SNAPSHOT_KEY\b/g,
    guarded: false,
    reason: "作品一覧の控え。走査のたびに書き直し、消えても1回走査を待つだけ",
  },
];

describe("鍵ごとに書く口は1か所", () => {
  const byRel = new Map(files.map((file) => [file.rel, file.code]));

  test.each(KEYS)("$key", (row) => {
    // 鍵の文字列は1つのファイルにだけある（別の所で同じ鍵を組み立てない）
    // 接頭辞の鍵（`.` で終わる）は後ろに作品IDなどが続く。それ以外は鍵まるごと
    const escaped = row.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const literal = new RegExp(
      row.key.endsWith(".") ? `["\`]${escaped}` : `["\`]${escaped}["\`]`
    );
    const holders = files
      .filter(({ code }) => literal.test(code))
      .map(({ rel }) => rel)
      .filter((rel) => !(row.otherUses && rel in row.otherUses));
    expect(holders).toEqual([row.literalIn]);

    const code = byRel.get(row.writtenIn) ?? "";
    // 助言方針は、既定と作品ごとの2つの鍵が同じ1つの口を通る
    expect([...code.matchAll(row.write)]).toHaveLength(1);
    if (!row.guarded) expect(row.reason).toBeTruthy();
  });

  test("鍵を組む関数（作品ID・モデル名を後ろに足すもの）で書く所も、書く口の1か所だけ", () => {
    // 鍵の文字列を持たないファイルでも、関数で鍵を組めば書ける。そこを塞ぐ
    const builders: Record<string, string[]> = {
      advicePolicyKey: [],
      imeExcludedKey: ["features/exportImeDictionary.ts"],
      pendingRenameKey: ["features/nameRename.ts"],
      supportKey: ["ai/geminiProvider.ts", "ai/claudeProvider.ts"],
    };
    for (const [builder, owners] of Object.entries(builders)) {
      const pattern = new RegExp(`\\.(update|patch)(<[^>]*>)?\\(\\s*${builder}\\(`);
      const writers = files.filter(({ code }) => pattern.test(code)).map(({ rel }) => rel);
      expect(writers.sort()).toEqual([...owners].sort());
    }
  });

  test("守らない鍵は、許した所でだけ素のまま書かれている", () => {
    const unguarded = KEYS.filter((row) => !row.guarded).map((row) => row.writtenIn);
    // 控えは workTree.ts が、extension.ts から素のまま受け取った保管庫で書く
    expect(unguarded).toEqual(["views/workTree.ts"]);
  });
});
