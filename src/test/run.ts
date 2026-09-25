import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { AIRegistry } from "../ai/registry";
import { CharacterStore, CharacterStoreError } from "../core/characterStore";
import { ChunkCache } from "../core/chunkCache";
import { splitIntoChunks } from "../core/chunker";
import { mergeExtractedCharacters } from "../core/characterMerge";
import { unifyCharacters } from "../core/characterUnify";
import { PendingUpdateStore } from "../core/pendingUpdates";
import { scanWork } from "../core/scanner";
import { scaffoldWorkFolder } from "../core/workRegistry";
import { extractCharacters } from "../features/extractCharacters";
import { createFirstEpisodeFile } from "../features/startWork";
import {
  MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE,
  manuscriptViewTypeFor,
} from "../core/manuscriptViewTypes";
import {
  checkoutSide,
  isGitAvailable,
  runGit,
  unmergedPaths,
} from "../core/git";
import { GitSyncMonitor, describeSyncBadge } from "../features/gitSync";
import { findConflictedFiles } from "../features/resolveConflicts";
import {
  resolveConflicts as buildResolvedText,
  sideFileName,
} from "../core/conflictFile";
import { encodeForNewFile, readTextFile } from "../core/textFile";
import { atomicWriteFile } from "../core/atomicWrite";
import { characterFileName, emptyCharacter } from "../models/character";
import { createAbilityStore } from "../core/abilityStore";
import { emptyAbility } from "../models/ability";
import type { WorkEntry } from "../models/types";
import { CHARACTER_EXTRACT_VERSION } from "../prompts/characterExtract";
import { assertFetchPatch, describeFetchPatch, probeFetchPatch } from "./fetchPatch";
import { runFieldListChecks } from "./fieldListChecks";
import { runRequest, runResult } from "../mcp/tools/runRequest";
import { handleRunRequest } from "../features/runRequestHandler";
import { createRunRequestDeps } from "../features/runRequestRunners";
import { RUN_REQUEST_DIRECTORY, runStateFileName } from "../core/runRequest";
import { RECOMMENDED_CHAT_MODEL } from "../core/requirements";

const COMMANDS = [
  "novelai.addWork",
  "novelai.createWork",
  "novelai.removeWork",
  "novelai.refresh",
  "novelai.addEpisode",
  "novelai.openWorkFolder",
  "novelai.showWritingStats",
  "novelai.setupAI",
  "novelai.testAI",
  "novelai.extractSettings",
  "novelai.openSettingsPanel",
  "novelai.generateSettingsDocs",
  "novelai.selectOllamaExecutable",
  "novelai.showLog",
  "novelai.unifyCharacters",
  "novelai.applyPendingUpdates",
  "novelai.showSettingsForTerm",
  "novelai.exportImeDictionary",
  "novelai.manageCustomFields",
  "novelai.gitSync",
  "novelai.gitPull",
  "novelai.gitPush",
  "novelai.resolveConflicts",
];

export async function run(): Promise<void> {
  const failures: string[] = [];
  await runCase("拡張機能を起動し、全コマンドを登録する", failures, async () => {
    // **IDを書き下さない。** publisher を変えると付いてこられない
    // （`local` → `nonahisa` の変更で実際に落ちた。2026-08-18）
    const pkg = JSON.parse(
      await fs.readFile(
        path.join(__dirname, "..", "..", "..", "package.json"),
        "utf-8"
      )
    ) as { publisher: string; name: string };
    const id = `${pkg.publisher}.${pkg.name}`;
    const extension = vscode.extensions.getExtension(id);
    assert.ok(extension, `拡張機能 ${id} が見つかりません`);
    await extension.activate();
    const registered = await vscode.commands.getCommands(true);
    for (const command of COMMANDS) {
      assert.ok(registered.includes(command), `${command} が登録されていません`);
    }
  });

  await runCase("出した知らせと登録簿の写しを保管庫へ書く（MCP の notices.recent・works.list）", failures, async () => {
    // **本物の拡張機能ホストで `vscode.window` を包めるか**は、単体テストの
    // 作り物では確かめられない（凍結されていれば包めない）。ここで実際に知らせを出し、
    // 保管庫に記録が現れることを見る
    const userData = process.env.NOVELAI_TEST_USER_DATA;
    assert.ok(userData, "NOVELAI_TEST_USER_DATA が渡されていません（scripts/runIntegrationTests.mjs）");
    const pkg = JSON.parse(
      await fs.readFile(path.join(__dirname, "..", "..", "..", "package.json"), "utf-8")
    ) as { publisher: string; name: string };
    const storage = path.join(
      userData,
      "User",
      "globalStorage",
      `${pkg.publisher}.${pkg.name}`.toLowerCase()
    );
    const marker = `統合テストの知らせ ${Date.now()}`;
    // 右下の通知は閉じるまで約束が解けないので待たない
    void vscode.window.showInformationMessage(marker, "了解");

    const noticeDirectory = path.join(storage, ".aiwriter", "notices");
    let found = "";
    // 書き出しは1秒まとめるので、少し待ちながら探す
    for (let attempt = 0; attempt < 30 && !found; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      let names: string[] = [];
      try {
        names = await fs.readdir(noticeDirectory);
      } catch {
        continue;
      }
      for (const name of names.filter((item) => item.endsWith(".json"))) {
        const text = await fs.readFile(path.join(noticeDirectory, name), "utf-8");
        if (text.includes(marker)) found = text;
      }
    }
    assert.ok(found, `知らせの記録に「${marker}」が現れません（${noticeDirectory}）`);
    const log = JSON.parse(found) as {
      pid: number;
      notices: { message: string; severity: string; items: string[] }[];
    };
    const entry = log.notices.find((notice) => notice.message === marker);
    assert.ok(entry);
    assert.equal(entry.severity, "info");
    assert.deepEqual(entry.items, ["了解"]);

    const snapshot = JSON.parse(
      await fs.readFile(path.join(storage, ".aiwriter", "works.json"), "utf-8")
    ) as { schema: number; works: unknown[] };
    assert.equal(snapshot.schema, 1);
    assert.ok(Array.isArray(snapshot.works));
  });

  await runCase(
    "外部AIからの実行の依頼：MCP の札 → 作者の確認 → 保管庫の結果 → run.result（設計書6.87.22）",
    failures,
    async () => {
      await checkRunRequestRoundTrip();
    }
  );

  await runCase("作品を作成・走査し、既存フォルダを上書きしない", failures, async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "novel-ai-assistant-work-")
    );
    try {
      const workFolder = path.join(temporaryRoot, "テスト作品");
      await scaffoldWorkFolder(workFolder, "テスト作品");
      const configPath = path.join(workFolder, ".aiwriter", "config.json");
      const originalConfig = await fs.readFile(configPath, "utf8");

      await assert.rejects(
        scaffoldWorkFolder(workFolder, "上書きされてはいけない名前"),
        /すでに存在/
      );
      assert.equal(await fs.readFile(configPath, "utf8"), originalConfig);

      await fs.writeFile(
        path.join(workFolder, "本文", "001.txt"),
        "【タイトル】\n始まり\n\n【文字数】\n5文字\n\n【本文（1行）】\n本文です。",
        "utf8"
      );
      const work = makeWork(workFolder);
      const scanned = await scanWork(work);
      assert.equal(scanned.stats.fileCount, 1);
      assert.equal(scanned.episodes[0].metaTitle, "始まり");
      assert.equal(scanned.episodes[0].counts.net, 5);

      const character = emptyCharacter("char_001", "灯");
      character.authorNotes = "作者のメモ";
      const store = new CharacterStore(work);
      await store.save(character);
      const loaded = await store.loadAll();
      assert.equal(loaded.errors.length, 0);
      assert.equal(loaded.characters[0].authorNotes, "作者のメモ");
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  await runCase("作者項目を保持して既存人物を上書きせず提案を残す", failures, async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "novel-ai-assistant-character-merge-")
    );
    try {
      const workFolder = path.join(temporaryRoot, "テスト作品");
      await scaffoldWorkFolder(workFolder, "テスト作品");
      const work = makeWork(workFolder);
      const store = new CharacterStore(work);
      const authorCharacter = emptyCharacter("char_001", "灯");
      authorCharacter.authorNotes = "作者のメモ";
      authorCharacter.exportNote = "公開時の注記";
      await store.save(authorCharacter);

      const loaded = await store.loadAll();
      assert.equal(loaded.errors.length, 0);
      const extracted = [
        {
          data: {
            name: "灯",
            entityType: "person" as const,
            role: "主人公",
            evidence: "灯が歩いた。",
          },
          chapters: [1],
        },
      ];
      const merged = mergeExtractedCharacters(loaded.characters, extracted);
      const characterPath = path.join(
        workFolder,
        "設定",
        "characters",
        characterFileName(loaded.characters[0])
      );
      const canonicalBefore = await fs.readFile(characterPath);
      let proposalPath: string | undefined;
      await assert.rejects(
        store.saveAll(
          merged.characters.filter((item) => merged.changedIds.includes(item.id))
        ),
        (error: unknown) => {
          assert.ok(error instanceof CharacterStoreError);
          assert.equal(error.kind, "path_conflict");
          assert.equal(error.persistenceState, "not_saved");
          proposalPath = error.recoveryPaths.find(
            (filePath) => path.basename(path.dirname(filePath)) === ".novelai-recovery"
          );
          assert.ok(proposalPath, "手動適用用の提案パスがありません");
          return true;
        }
      );

      assert.deepEqual(await fs.readFile(characterPath), canonicalBefore);
      const proposed = JSON.parse(await fs.readFile(proposalPath!, "utf8")) as {
        role: string | null;
        authorNotes: string;
        exportNote: string;
      };
      assert.equal(proposed.role, "主人公");
      assert.equal(proposed.authorNotes, "作者のメモ");
      assert.equal(proposed.exportNote, "公開時の注記");
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  await runCase("同一人物を1件にまとめ、取り下げた側を回復先へ残す", failures, async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "novel-ai-assistant-unify-")
    );
    try {
      const workFolder = path.join(temporaryRoot, "テスト作品");
      await scaffoldWorkFolder(workFolder, "テスト作品");
      const work = makeWork(workFolder);
      const store = new CharacterStore(work);

      const keep = emptyCharacter("char_002", "リンセップ・アウクト");
      keep.authorNotes = "残す側のメモ";
      const absorb = emptyCharacter("char_001", "リン");
      absorb.authorNotes = "取り下げ側のメモ";
      await store.save(keep);
      await store.save(absorb);

      const loaded = await store.loadAll();
      const loadedKeep = loaded.characters.find((c) => c.id === "char_002");
      const loadedAbsorb = loaded.characters.find((c) => c.id === "char_001");
      assert.ok(loadedKeep && loadedAbsorb);
      const { unified, retiredId } = unifyCharacters(loadedKeep, loadedAbsorb);

      // 既存ファイルの上書きはこのプロジェクトでは行わない（replaceGuardedは必ず失敗する）。
      // 退避してから新規作成する順序でしか成立しないことを、実ファイルで固定する。
      await store.retire(loadedKeep.id);
      await store.save(unified);
      const recoveryPath = await store.retire(retiredId);

      const after = await store.loadAll();
      assert.equal(after.errors.length, 0);
      assert.equal(after.characters.length, 1);
      assert.equal(after.characters[0].name, "リンセップ・アウクト");
      assert.ok(after.characters[0].aliases.includes("リン"));
      // 作者が書いた文章は片方も失わない
      assert.ok(after.characters[0].authorNotes.includes("残す側のメモ"));
      assert.ok(after.characters[0].authorNotes.includes("取り下げ側のメモ"));
      assert.equal(after.characters[0].autoGenerated, false);

      // 取り下げた側は削除せず回復先に残す。別人をまとめても元へ戻せるように
      const retired = JSON.parse(await fs.readFile(recoveryPath, "utf8")) as {
        name: string;
      };
      assert.equal(retired.name, "リン");
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  await runCase("承認した更新を既存人物へ反映する", failures, async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "novel-ai-assistant-pending-")
    );
    try {
      const workFolder = path.join(temporaryRoot, "テスト作品");
      await scaffoldWorkFolder(workFolder, "テスト作品");
      const work = makeWork(workFolder);
      const store = new CharacterStore(work);

      const original = emptyCharacter("char_001", "灯");
      original.authorNotes = "作者のメモ";
      await store.save(original);

      // 抽出が作る更新案を保留に置く
      const loaded = await store.loadAll();
      const proposal = {
        ...loaded.characters[0],
        role: "主人公",
        appearedChapters: [1, 2],
      };
      const pending = new PendingUpdateStore(work);
      await pending.stage([proposal]);
      assert.equal(await pending.count(), 1);

      // 承認前は元のまま。勝手に書き換わっていないこと
      const beforeApply = await store.loadAll();
      assert.equal(beforeApply.characters[0].role, null);

      // 承認して反映する
      const target = (await pending.loadAll()).updates[0];
      await store.update(target.character);
      await pending.discard(target.filePath);

      const after = await store.loadAll();
      assert.equal(after.errors.length, 0);
      assert.equal(after.characters.length, 1);
      assert.equal(after.characters[0].role, "主人公");
      assert.deepEqual(after.characters[0].appearedChapters, [1, 2]);
      // 作者が書いた内容は残す
      assert.equal(after.characters[0].authorNotes, "作者のメモ");
      assert.equal(await pending.count(), 0);
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  await runCase("新規は作成、既存は退避して作り直す", failures, async () => {
    // 既存ファイルは上書きできない（replaceGuardedは必ず失敗する）。
    // 呼び分けを間違えると保存が必ず失敗するので、実ファイルで固定する
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "novel-ai-assistant-saveorupdate-")
    );
    try {
      const workFolder = path.join(temporaryRoot, "テスト作品");
      await scaffoldWorkFolder(workFolder, "テスト作品");
      const work = makeWork(workFolder);
      const store = new CharacterStore(work);

      // 新規はそのまま作成できる
      await store.saveOrUpdate(emptyCharacter("char_001", "灯"));
      let loaded = await store.loadAll();
      assert.equal(loaded.characters.length, 1);

      // 既存は同じ呼び出しで書き換えられる
      await store.saveOrUpdate({ ...loaded.characters[0], role: "主人公" });
      loaded = await store.loadAll();
      assert.equal(loaded.errors.length, 0);
      assert.equal(loaded.characters.length, 1);
      assert.equal(loaded.characters[0].role, "主人公");

      // 続けて書き換えても壊れない
      await store.saveOrUpdate({ ...loaded.characters[0], personality: "無鉄砲" });
      loaded = await store.loadAll();
      assert.equal(loaded.characters.length, 1);
      assert.equal(loaded.characters[0].personality, "無鉄砲");
      assert.equal(loaded.characters[0].role, "主人公");
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  await runCase("競合マーカーを含むファイルを文字数から除く", failures, async () => {
    // 設計書5.5.3。マーカーと両方の版が混ざったまま数えると、
    // 実際より多い字数を本当の進捗として見せてしまう
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "novel-ai-assistant-conflict-scan-")
    );
    try {
      const workFolder = path.join(temporaryRoot, "テスト作品");
      await scaffoldWorkFolder(workFolder, "テスト作品");
      const work = makeWork(workFolder);
      const manuscript = path.join(workFolder, "本文");

      await fs.writeFile(
        path.join(manuscript, "001.txt"),
        "灯は歩き出した。\n",
        "utf8"
      );
      await fs.writeFile(
        path.join(manuscript, "002.txt"),
        [
          "<<<<<<< HEAD",
          "灯は歩き出した。",
          "=======",
          "灯はゆっくりと歩き出した。",
          ">>>>>>> origin/main",
        ].join("\n"),
        "utf8"
      );

      const scan = await scanWork(work);
      const clean = scan.episodes.find((e) => e.fileName === "001.txt");
      const conflicted = scan.episodes.find((e) => e.fileName === "002.txt");
      assert.ok(clean && conflicted);

      assert.equal(clean.hasConflictMarkers, false);
      assert.equal(conflicted.hasConflictMarkers, true);
      // 競合を含むファイルは数えない
      assert.equal(conflicted.counts.net, 0);
      assert.equal(scan.stats.conflictedCount, 1);
      assert.equal(scan.stats.totals.net, clean.counts.net);

      // .gitignore にキャッシュの除外が入っていること（設計書5.5.7）
      const ignore = await fs.readFile(
        path.join(workFolder, ".gitignore"),
        "utf8"
      );
      assert.ok(ignore.includes(".aiwriter/cache/"));
      assert.ok(ignore.includes(".novelai-recovery/"));
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  await runCase("読み込み後の外部編集を検出して保存を拒否する", failures, async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "novel-ai-assistant-character-conflict-")
    );
    try {
      const workFolder = path.join(temporaryRoot, "テスト作品");
      await scaffoldWorkFolder(workFolder, "テスト作品");
      const work = makeWork(workFolder);
      const store = new CharacterStore(work);
      const character = emptyCharacter("char_001", "灯");
      await store.save(character);

      const loaded = await store.loadAll();
      assert.equal(loaded.errors.length, 0);
      const characterPath = path.join(
        workFolder,
        "設定",
        "characters",
        characterFileName(loaded.characters[0])
      );
      const externallyEditedJson = `${JSON.stringify(
        { ...loaded.characters[0], authorNotes: "外部ツールで追記" },
        null,
        2
      )}\n`;
      await fs.writeFile(characterPath, externallyEditedJson, "utf8");

      await assert.rejects(store.save(loaded.characters[0]), (error: unknown) => {
        assert.ok(error instanceof CharacterStoreError);
        assert.equal(error.kind, "modified_externally");
        return true;
      });
      assert.equal(await fs.readFile(characterPath, "utf8"), externallyEditedJson);
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  await runCase("キャッシュ済みAI応答を検証して人物抽出を保存する", failures, async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "novel-ai-assistant-character-cache-")
    );
    try {
      const workFolder = path.join(temporaryRoot, "テスト作品");
      await scaffoldWorkFolder(workFolder, "テスト作品");
      const work = makeWork(workFolder);
      const body = "灯が歩いた。";
      const episodePath = path.join(work.folderPath, "本文", "001.txt");
      await fs.writeFile(episodePath, body, "utf8");
      const chunks = splitIntoChunks(episodePath, body, 1, 1, {
        maxChars: 1000,
      });
      const model = "fixture-model";
      const cacheKeyBase = {
        feature: "character_extract",
        promptVersion: CHARACTER_EXTRACT_VERSION,
        providerId: "ollama",
        model,
      };
      const cache = new ChunkCache(work);
      await cache.load();
      await cache.set(chunks[0].hash, cacheKeyBase, {
        characters: [
          { name: "灯", entityType: "person", evidence: body },
          {
            name: "幻",
            entityType: "person",
            evidence: "幻が笑った。",
          },
        ],
      });
      await cache.save();

      const configuredRegistry = {
        resolve: () => ({
          provider: {
            id: "ollama",
            generate: async () => {
              throw new Error("キャッシュ済みチャンクでAIを呼んではいけません");
            },
          },
          model,
        }),
        resolveModelInfo: async () => ({ contextWindow: 8192 }),
      } as unknown as AIRegistry;
      const informationMessageDescriptor = Object.getOwnPropertyDescriptor(
        vscode.window,
        "showInformationMessage"
      );
      assert.ok(
        informationMessageDescriptor?.configurable,
        "showInformationMessage をテスト用に差し替えられません"
      );
      Object.defineProperty(vscode.window, "showInformationMessage", {
        configurable: true,
        value: async () => undefined,
      });
      try {
        await extractCharacters(work, configuredRegistry);
      } finally {
        Object.defineProperty(
          vscode.window,
          "showInformationMessage",
          informationMessageDescriptor
        );
      }

      const saved = await new CharacterStore(work).loadAll();
      assert.equal(saved.errors.length, 0);
      assert.deepEqual(
        saved.characters.map((item) => item.name),
        ["灯"]
      );
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  await runCase(
    "GitHubとの遅れを見つけ、自動では取り込まない",
    failures,
    async () => {
      const temporaryRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "novel-ai-assistant-git-")
      );
      try {
        if (!(await isGitAvailable())) {
          console.log("SKIP gitコマンドが無いため省略");
          return;
        }

        // 別環境から更新される状況を、本物のリポジトリで作る
        const remote = path.join(temporaryRoot, "remote.git");
        await git(["init", "--bare", "-b", "main", remote], temporaryRoot);
        await git(["clone", remote, "work"], temporaryRoot);
        await git(["clone", remote, "other"], temporaryRoot);
        const workPath = path.join(temporaryRoot, "work");
        const otherPath = path.join(temporaryRoot, "other");

        await fs.writeFile(path.join(workPath, "001.txt"), "一話\n", "utf8");
        await git(["add", "."], workPath);
        await git([...GIT_IDENTITY, "commit", "-m", "初回"], workPath);
        await git(["push", "-u", "origin", "main"], workPath);

        await git(["pull"], otherPath);
        await fs.writeFile(path.join(otherPath, "002.txt"), "二話\n", "utf8");
        await git(["add", "."], otherPath);
        await git([...GIT_IDENTITY, "commit", "-m", "別環境"], otherPath);
        await git(["push"], otherPath);

        const work = { ...makeWork(workPath), id: "work_git" };
        const monitor = new GitSyncMonitor({
          list: () => [work],
          onDidChange: () => ({ dispose: () => undefined }),
        } as unknown as ConstructorParameters<typeof GitSyncMonitor>[0]);

        try {
          const status = await monitor.refresh(work, {
            fetch: true,
            notify: false,
          });

          assert.equal(status.kind, "tracked", "同期状態を判定できません");
          assert.equal(
            status.kind === "tracked" ? status.behind : -1,
            1,
            "別環境の変更を未取得として数えられません"
          );
          // 印は矢印から言葉へ変えた（0.20.3）。
          // **作品ごとの数**を出すので、1作品＝1置き場のここでは受け取り1件
          assert.equal(describeSyncBadge(status), "受け取り1");

          // 自動では取り込まない。作業ツリーが変わっていないことで確かめる
          const files = await fs.readdir(workPath);
          assert.ok(
            !files.includes("002.txt"),
            "fetchだけのはずが、作業ツリーへ取り込まれています"
          );
        } finally {
          monitor.dispose();
        }
      } finally {
        await fs.rm(temporaryRoot, { recursive: true, force: true });
      }
    }
  );

  await runCase(
    "競合したファイルを見つけ、別環境の版を別ファイルへ残せる",
    failures,
    async () => {
      const temporaryRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "novel-ai-assistant-conflict-")
      );
      try {
        if (!(await isGitAvailable())) {
          console.log("SKIP gitコマンドが無いため省略");
          return;
        }

        const remote = path.join(temporaryRoot, "remote.git");
        await git(["init", "--bare", "-b", "main", remote], temporaryRoot);
        await git(["clone", remote, "a"], temporaryRoot);
        await git(["clone", remote, "b"], temporaryRoot);
        const a = path.join(temporaryRoot, "a");
        const b = path.join(temporaryRoot, "b");

        await fs.writeFile(path.join(a, "008.txt"), "　もとの文。\n", "utf8");
        await git(["add", "."], a);
        await git([...GIT_IDENTITY, "commit", "-m", "初回"], a);
        await git(["push", "-u", "origin", "main"], a);

        // 同じ話を2つの環境で別々に書いた状態を作る
        await git(["pull"], b);
        await fs.writeFile(
          path.join(b, "008.txt"),
          "　灯はゆっくりと歩き出した。\n",
          "utf8"
        );
        await git(["add", "."], b);
        await git([...GIT_IDENTITY, "commit", "-m", "別環境"], b);
        await git(["push"], b);

        await fs.writeFile(
          path.join(a, "008.txt"),
          "　灯は歩き出した。\n",
          "utf8"
        );
        await git(["add", "."], a);
        await git([...GIT_IDENTITY, "commit", "-m", "この環境"], a);
        await git(["fetch"], a);
        const merge = await runGit(
          [...GIT_IDENTITY, "merge", "origin/main"],
          a,
          30_000
        );
        assert.notEqual(merge.code, 0, "競合が起きていません");

        const work = { ...makeWork(a), id: "work_conflict" };

        // 走査が競合を見つけ、文字数から外していること（5.5.3）
        const scanned = await scanWork(work);
        assert.equal(scanned.stats.conflictedCount, 1);

        const conflicted = await findConflictedFiles(work);
        assert.equal(conflicted.length, 1, "競合ファイルを検出できません");
        assert.equal(conflicted[0].relativePath, "008.txt");
        assert.ok(conflicted[0].unmerged, "マージ未解決として扱えていません");
        assert.equal(conflicted[0].parsed.hunks.length, 1);

        // 「両方を残す」に相当する流れ：別環境の版を新しいファイルへ書き、
        // 本文はこの環境の版で確定する
        const original = await readTextFile(path.join(a, "008.txt"));
        const theirs = buildResolvedText(original.text, "theirs");
        const sideName = sideFileName("008.txt", "origin/main");
        const encoded = encodeForNewFile(theirs, original);
        assert.ok(encoded, "別環境の版を書き出せません");
        await atomicWriteFile(path.join(a, sideName), encoded, {
          mode: "create",
        });

        const applied = await checkoutSide(a, "008.txt", "ours");
        assert.ok(applied.ok, "この環境の版で確定できません");

        assert.equal(
          (await fs.readFile(path.join(a, "008.txt"), "utf8")).replace(
            /\r\n/g,
            "\n"
          ),
          "　灯は歩き出した。\n"
        );
        assert.equal(
          (await fs.readFile(path.join(a, sideName), "utf8")).replace(
            /\r\n/g,
            "\n"
          ),
          "　灯はゆっくりと歩き出した。\n"
        );
        assert.equal((await unmergedPaths(a)).length, 0);
      } finally {
        await fs.rm(temporaryRoot, { recursive: true, force: true });
      }
    }
  );

  await runCase(
    "大文字小文字だけを変えた改名で、その資料を消さない",
    failures,
    async () => {
      // **本物のファイルシステムで確かめる。**
      // Windowsは大文字小文字を区別しないため、書き込み先と「古いファイル」が
      // 同じ1つのファイルになる。stubでは再現しきれないので実環境で見る
      const temporaryRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "novel-ai-assistant-case-rename-")
      );
      try {
        const folderPath = path.join(temporaryRoot, "テスト作品");
        await scaffoldWorkFolder(folderPath, "テスト作品");
        const work = makeWork(folderPath);

        const store = createAbilityStore(work);
        const ability = { ...emptyAbility("abil_001", "Fire"), autoGenerated: true };
        await store.saveAll([ability]);

        const before = await createAbilityStore(work).loadAll();
        assert.equal(before.records.length, 1, "保存できていない");

        // 大文字小文字だけを変えて保存し直す
        const renamed = { ...before.records[0], name: "fire" };
        const reopened = createAbilityStore(work);
        await reopened.loadAll();
        await reopened.saveAll([renamed]);

        const after = await createAbilityStore(work).loadAll();
        assert.deepEqual(after.errors, [], "読み込みエラーが出ている");
        assert.equal(
          after.records.length,
          1,
          `改名で資料が消えた（${after.records.length}件）`
        );
        assert.equal(after.records[0].name, "fire");
      } finally {
        await fs.rm(temporaryRoot, { recursive: true, force: true });
      }
    }
  );

  await runCase(
    "プロットを作ると、作者が .md に割り当てた画面で開く（実機確認リスト F-1）",
    failures,
    async () => {
      // **本物の VS Code の割り当て（`workbench.editorAssociations`）に従うか**を見る。
      // 単体テストは「`vscode.open` を呼んでいる」までしか言えない。
      // 割り当て先には、この拡張機能が必ず持っている原稿エディタを使う
      // （組み込みのMarkdown画面は、試験用のVS Codeに在るとは限らない）。
      // そのあと「テキストエディター」へ戻して、今度は素の画面で開くことも見る
      // ——片方だけだと「いつも原稿エディタで開く」実装でも通ってしまう
      const temporaryRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "novel-ai-assistant-plot-open-")
      );
      const workbench = vscode.workspace.getConfiguration("workbench");
      const saved = workbench.inspect("editorAssociations")?.globalValue;
      try {
        const workFolder = path.join(temporaryRoot, "テスト作品");
        await scaffoldWorkFolder(workFolder, "テスト作品");
        const work = makeWork(workFolder);
        const isPlot = (uri: vscode.Uri): boolean =>
          path.basename(uri.fsPath) === "plot.md";

        await workbench.update(
          "editorAssociations",
          { "*.md": MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE },
          vscode.ConfigurationTarget.Global
        );
        await vscode.commands.executeCommand("novelai.createPlot", {
          type: "work",
          work,
        });
        const custom = await waitForActiveTab(
          (input) => input instanceof vscode.TabInputCustom && isPlot(input.uri)
        );
        assert.ok(custom instanceof vscode.TabInputCustom);
        assert.equal(custom.viewType, MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE);
        // 作ったのは設定フォルダーの plot.md
        await fs.access(path.join(workFolder, "設定", "plot.md"));

        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        await workbench.update(
          "editorAssociations",
          { "*.md": "default" },
          vscode.ConfigurationTarget.Global
        );
        await vscode.commands.executeCommand("novelai.createPlot", {
          type: "work",
          work,
        });
        const text = await waitForActiveTab(
          (input) => input instanceof vscode.TabInputText && isPlot(input.uri)
        );
        assert.ok(text instanceof vscode.TabInputText);
      } finally {
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        await workbench.update(
          "editorAssociations",
          saved,
          vscode.ConfigurationTarget.Global
        );
        await fs.rm(temporaryRoot, { recursive: true, force: true });
      }
    }
  );

  await runCase(
    "新規作品の第1話は、作品一覧と同じ原稿エディタで開く（実機確認リスト F-1）",
    failures,
    async () => {
      // 本文の既定は「原稿エディタ（横書き）」（作者の指定、2026-08-29。作品一覧の
      // クリックと同じ `manuscriptViewTypeFor`）。第1話だけ素の画面で開くと、
      // 書き始めの1話だけ見た目も道具も違うことになる
      const temporaryRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "novel-ai-assistant-first-episode-")
      );
      try {
        const workFolder = path.join(temporaryRoot, "テスト作品");
        await scaffoldWorkFolder(workFolder, "テスト作品");
        const work = makeWork(workFolder);

        const created = await createFirstEpisodeFile(work);
        assert.ok(created, "第1話のファイルが作られていません");

        const opened = await waitForActiveTab(
          (input) =>
            input instanceof vscode.TabInputCustom &&
            input.uri.fsPath.toLowerCase() === created.toLowerCase()
        );
        assert.ok(opened instanceof vscode.TabInputCustom);
        assert.equal(opened.viewType, manuscriptViewTypeFor(undefined));
        assert.equal(opened.viewType, MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE);
      } finally {
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        await fs.rm(temporaryRoot, { recursive: true, force: true });
      }
    }
  );

  await runCase(
    "手元のAIの待ち時間は、VS Code の通信の差し替えを越えて届く",
    failures,
    async () => {
      const report = await probeFetchPatch();
      // 通っても結果を残す。版ごとの振る舞い（差し替えの有無）の記録になる
      console.log(describeFetchPatch(report));
      assertFetchPatch(report);
    }
  );

  // 実機確認リストの項目のうち、機械で確かめられる部分（2026-09-26）。
  // 作品を本物のコマンドで登録する項目があるので、ほかの項目のあとに回す
  await runFieldListChecks((name, test) => runCase(name, failures, test));

  if (failures.length > 0) {
    throw new Error(`Integration tests failed:\n${failures.join("\n")}`);
  }
}

/** テスト用リポジトリの作者情報。実行環境の設定に依存させない */
const GIT_IDENTITY = [
  "-c",
  "user.name=test",
  "-c",
  "user.email=test@example.com",
];

async function git(args: string[], cwd: string): Promise<void> {
  const result = await runGit(args, cwd, 30_000);
  if (result.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} が失敗しました: ${result.stderr || result.stdout}`
    );
  }
}

/**
 * いま前に出ているタブの中身が、条件に合うまで待つ。
 *
 * 画面を開くコマンドは、開き終わる前に戻ってくることがある。
 * 5秒待っても合わなければ、そのときの中身を添えて落とす（何が開いたかを残す）。
 */
async function waitForActiveTab(
  matches: (input: unknown) => boolean
): Promise<unknown> {
  let last: unknown;
  for (let attempt = 0; attempt < 50; attempt++) {
    last = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (last !== undefined && matches(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const described =
    last instanceof vscode.TabInputCustom
      ? `独自の画面 ${last.viewType}（${last.uri.fsPath}）`
      : last instanceof vscode.TabInputText
        ? `テキスト（${last.uri.fsPath}）`
        : String(last);
  throw new Error(`期待したタブが前に出ません。いま前にあるのは：${described}`);
}

async function runCase(
  name: string,
  failures: string[],
  test: () => Promise<void>
): Promise<void> {
  try {
    await test();
    console.log(`PASS ${name}`);
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    failures.push(`FAIL ${name}\n${detail}`);
  }
}

/**
 * 外部AIから頼まれた実行を、本物の拡張機能ホストで通す（設計書6.87.22）。
 *
 * **OS の `vscode://` の配達だけは作り物にする。** 開くと、この機械に入っている
 * 作者の VS Code（試験用ではないほう）が呼び起こされるため。配達の代わりに、
 * MCP の道具が開こうとした URI のクエリをそのまま受け口へ渡す。
 *
 * ほかは本物：MCP の道具が保管庫へ札を置く・受け口が `vscode.workspace.fs` で
 * 読み書きする（「新しく作るだけ」の錠が本物のファイル装置で効くか）・確認は
 * `vscode.window.showWarningMessage` のモーダルを差し替えて中身を見る。
 *
 * **手元の Ollama に薦めるモデル（`RECOMMENDED_CHAT_MODEL`）があるときだけ**、作者が「走らせる」を押した
 * 道も通す（製品の誤字脱字検知を本物のAIで回し、結果を `run.result` で読む）。
 * 無ければ省く（CI には Ollama が無い）。
 */
async function checkRunRequestRoundTrip(): Promise<void> {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "novel-ai-assistant-run-"));
  const storage = path.join(temporaryRoot, "globalStorage", "nonahisa.novel-ai-assistant");
  const warningDescriptor = Object.getOwnPropertyDescriptor(vscode.window, "showWarningMessage");
  assert.ok(warningDescriptor?.configurable, "showWarningMessage をテスト用に差し替えられません");
  try {
    const workFolder = path.join(temporaryRoot, "星の町");
    await scaffoldWorkFolder(workFolder, "星の町");
    const work = makeWork(workFolder);
    const episodePath = path.join(workFolder, "本文", "001.txt");
    const body = "彼は学校え行った。空はとても青かった。";
    await fs.writeFile(episodePath, body, "utf8");
    // **許可の印は一時フォルダーの作り物の作品にだけ置く**（作者の作品には触れない）
    await fs.writeFile(
      path.join(workFolder, ".aiwriter", "external-access.json"),
      JSON.stringify({
        schemaVersion: "2",
        clients: [{ name: "claude-code", tools: ["run.request"], sampling: false, decidedAt: "" }],
      }),
      "utf8"
    );

    const memory = new Map<string, unknown>();
    const fakeContext = {
      globalStorageUri: vscode.Uri.file(storage),
      globalState: {
        get: <T>(key: string, fallback?: T) => (memory.has(key) ? (memory.get(key) as T) : fallback),
        update: async (key: string, value: unknown) => {
          memory.set(key, value);
        },
        keys: () => [...memory.keys()],
        setKeysForSync: () => undefined,
      },
      secrets: {
        get: async () => undefined,
        store: async () => undefined,
        delete: async () => undefined,
        onDidChange: () => ({ dispose: () => undefined }),
      },
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;
    const aiRegistry = new AIRegistry(fakeContext);

    const modals: Array<{ message: string; detail: string }> = [];
    const warnings: string[] = [];
    let answer: string | undefined;
    Object.defineProperty(vscode.window, "showWarningMessage", {
      configurable: true,
      value: async (message: string, ...rest: unknown[]) => {
        const options = rest[0] as { modal?: boolean; detail?: string } | undefined;
        if (options && typeof options === "object" && options.modal) {
          modals.push({ message, detail: options.detail ?? "" });
          return answer;
        }
        warnings.push(message);
        return undefined;
      },
    });

    const handlerDeps = createRunRequestDeps({
      context: fakeContext,
      findWork: (folder: string) =>
        path.resolve(folder) === path.resolve(workFolder) ? work : undefined,
      aiRegistry,
      log: () => undefined,
    });
    const delivered: string[] = [];
    const mcpDeps = {
      open: async (uri: string) => {
        delivered.push(uri);
        await handleRunRequest(uri.slice(uri.indexOf("?") + 1), handlerDeps);
      },
      now: () => Date.now(),
      random: (bytes: number) =>
        Array.from({ length: bytes * 2 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join(""),
      storageRoot: () => storage,
      clientName: () => "claude-code",
    };
    const beforeBody = await fs.readFile(episodePath, "utf8");

    // ── 1. AIが未設定なら、確認を出さずに断る（次の操作を返す）
    const first = await runRequest({ folder: workFolder, feature: "typo" }, mcpDeps);
    assert.equal(modals.length, 0, "AIが未設定なのに確認が出ました");
    const refused = runResult({ folder: workFolder, requestId: first.requestId }, mcpDeps);
    assert.equal(refused.status, "refused");
    assert.match(refused.nextAction ?? "", /AI設定/u);

    // ── 2. 作者の設定したAI（手元の Ollama）で、作者が断る
    await aiRegistry.select("ollama", RECOMMENDED_CHAT_MODEL);
    answer = undefined;
    const second = await runRequest({ folder: workFolder, feature: "typo" }, mcpDeps);
    assert.equal(modals.length, 1, "確認のモーダルが出ていません");
    for (const expected of ["claude-code", work.title, "誤字脱字の検知", RECOMMENDED_CHAT_MODEL, "無料"]) {
      assert.ok(modals[0].detail.includes(expected) || modals[0].message.includes(expected), `確認に「${expected}」がありません:\n${modals[0].detail}`);
    }
    assert.equal(runResult({ folder: workFolder, requestId: second.requestId }, mcpDeps).status, "declined");
    // 状態は保管庫に書かれ、本物のファイル装置で「新しく作るだけ」の錠が効く
    const statePath = path.join(storage, RUN_REQUEST_DIRECTORY, runStateFileName(second.requestId));
    assert.ok((await fs.stat(statePath)).isFile());
    const secondUri = delivered[delivered.length - 1];
    await handleRunRequest(secondUri.slice(secondUri.indexOf("?") + 1), handlerDeps);
    assert.equal(modals.length, 1, "使い回した合言葉で確認が出ました");
    assert.ok(warnings.some((message) => message.includes("1回しか")), warnings.join("\n"));

    // ── 3. 手元の Ollama に薦めるモデルがあれば、走らせて結果を読む
    let hasModel = false;
    try {
      const response = await fetch("http://localhost:11434/api/tags");
      const tags = (await response.json()) as { models?: Array<{ name: string }> };
      hasModel = (tags.models ?? []).some((model) => model.name === RECOMMENDED_CHAT_MODEL);
    } catch {
      hasModel = false;
    }
    if (!hasModel) {
      console.log(`SKIP 手元の Ollama に ${RECOMMENDED_CHAT_MODEL} が無いため、走らせる道は省略`);
    } else {
      answer = "走らせる";
      const third = await runRequest({ folder: workFolder, feature: "typo" }, mcpDeps);
      const read = runResult({ folder: workFolder, requestId: third.requestId }, mcpDeps);
      assert.equal(read.status, "done", `走り終えていません: ${JSON.stringify(read)}`);
      assert.equal(read.result?.provider.id, "ollama");
      assert.equal(read.result?.model, RECOMMENDED_CHAT_MODEL);
      assert.ok(read.result?.promptVersion, "プロンプトの版がありません");
      console.log(
        `run.result（手元の Ollama ${RECOMMENDED_CHAT_MODEL}）: 指摘 ${read.result?.findings.length}件 / ` +
          `落とした ${read.result?.dropped.count}件 / 失敗 ${read.result?.failures.count}件\n` +
          JSON.stringify(read.result?.findings, null, 2)
      );
    }

    // **原稿は1文字も変わらない。** 結果は作品の外（保管庫）にだけある
    assert.equal(await fs.readFile(episodePath, "utf8"), beforeBody);
    const inWork = await listFilesRecursive(workFolder);
    assert.ok(
      !inWork.some((file) => file.includes(RUN_REQUEST_DIRECTORY)),
      `作品フォルダーに依頼の置き場ができています: ${inWork.join(", ")}`
    );
  } finally {
    Object.defineProperty(vscode.window, "showWarningMessage", warningDescriptor);
    // 走らせた機能のログ（.aiwriter/logs）の書き込みが、終わった直後にまだ続いていることがある。
    // 消す最中に書かれると ENOTEMPTY で落ちる（2026-09-25、配布前の検査で1度落ちた）ので、少し待ってやり直す
    await fs.rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? listFilesRecursive(full) : [full];
    })
  );
  return nested.flat();
}

function makeWork(folderPath: string): WorkEntry {
  return {
    id: "work_integration",
    title: "テスト作品",
    folderPath,
    registeredAt: "2026-08-06T00:00:00.000Z",
  };
}
