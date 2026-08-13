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
import type { WorkEntry } from "../models/types";
import { CHARACTER_EXTRACT_VERSION } from "../prompts/characterExtract";

const COMMANDS = [
  "novelai.addWork",
  "novelai.createWork",
  "novelai.removeWork",
  "novelai.refresh",
  "novelai.addEpisode",
  "novelai.openWorkFolder",
  "novelai.showWorkStats",
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
    const extension = vscode.extensions.getExtension("local.novel-ai-assistant");
    assert.ok(extension, "拡張機能 local.novel-ai-assistant が見つかりません");
    await extension.activate();
    const registered = await vscode.commands.getCommands(true);
    for (const command of COMMANDS) {
      assert.ok(registered.includes(command), `${command} が登録されていません`);
    }
  });

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
          assert.equal(describeSyncBadge(status), "↓1");

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

function makeWork(folderPath: string): WorkEntry {
  return {
    id: "work_integration",
    title: "テスト作品",
    folderPath,
    registeredAt: "2026-08-06T00:00:00.000Z",
  };
}
