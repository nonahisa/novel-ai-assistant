import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { createHash } from "node:crypto";
import { extractCommit } from "../../../src/mcp/tools/extractCommit";
import { pendingList } from "../../../src/mcp/tools/pendingList";
import { settingsPrompt, settingsValidate } from "../../../src/mcp/tools/settings";
import { emptyCharacter, type Character } from "../../../src/models/character";
import type { RecordChange } from "../../../src/models/jsonValidation";
import type { WorkEntry } from "../../../src/models/types";
import {
  NARRATOR_MOVE_DISMISSED_FILE,
  PENDING_MOVES_DIR,
  readPendingNarratorMoveFile,
} from "../../../src/core/pendingNarratorMoves";
import {
  narratorMoveViewItems,
  reviewPendingNarratorMoves,
} from "../../../src/features/narratorMovePending";
import { FileSystemError, FileType, workspace } from "../support/vscodeStub";

/**
 * 外部AI（MCP）の道で、語り手の取り違えの移す案を積む・読む（0.102.12。
 * 作者の指示 2026-10-11「語り手の残り」。設計書6.5.12）。
 *
 * 0.102.3 までは、移す案を積むのは製品の［設定資料を抽出］の終わりだけで、
 * MCP の `novel.extract.commit` のあとには積まれず、`pending.list` にも並ばな
 * かった。積む・並べるための関数（`findNarratorMoves`・`planNarratorMoveStaging`・
 * `assembleNarratorMoveReview`）はどれも `vscode` を持たないので、MCP でも
 * 同じ関数を通せる。
 *
 * 作り物は「ハイエルフ未亡人」の形を写す——主人公アジャーノは地の文の「俺」、
 * 第2話の前半は皇子の場面（地の文「余」）、後半は皇帝と側近の三人称の場面。
 */

const temporary: string[] = [];
const NUM_CTX = 32768;

/** 主人公の場面（地の文の「俺」。語り手が決まる数を満たすよう長めに） */
const HERO_TEXT =
  Array.from(
    { length: 14 },
    (_, index) =>
      `　俺は${index + 1}本目の串焼きを頬張った。旨い。屋台の親父の腕は確かで、俺は通りの喧噪を眺めながら次の一本を待った。`
  ).join("\n") +
  "\n　エルシーは俺を雇った。報酬は悪くない。\n";

const PRINCE_SCENE =
  "　広い部屋にポツンと置かれた机で、余は先生の話をただ聞いていた。\n" +
  "「これは経済の基本です。殿下、聞いていますか」\n" +
  "　余もいつか、この退屈な皇宮から出ることができるのだろうか。\n";
const EMPEROR_SCENE =
  "「陛下、ご報告に参りました」\n" +
  "　執務室で若い皇帝に声をかけたのは、宰相の側近だった。\n" +
  "「はい、皇子殿下は、どの教科も優秀でございます」\n";
const SECOND_TEXT = `${PRINCE_SCENE}\n◇◆◇◆\n\n${EMPEROR_SCENE}`;

const EPISODE_1 = "001_屋台.txt";
const EPISODE_2 = "002_皇宮.txt";

function change(field: string, value: string, chapters: number[]): RecordChange {
  return {
    field,
    value,
    chapters,
    timepointId: null,
    note: null,
    evidence: null,
    source: "extracted",
  };
}

/** 皇子の場面から取り違えで入った値を持つ主人公 */
function hero(): Character {
  return {
    ...emptyCharacter("char_001", "アジャーノ"),
    role: "冒険者",
    firstPerson: {
      default: "俺",
      variants: [
        {
          form: "余",
          context: null,
          chapters: [2],
          evidence: "皇子殿下は、どの教科も優秀でございます",
        },
      ],
    },
    changes: [change("role", "冒険者", [1]), change("role", "皇子", [2])],
    appearedChapters: [1, 2],
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

const EMPEROR: Character = {
  ...emptyCharacter("char_002", "皇帝"),
  aliases: ["陛下"],
  firstPerson: { default: "余", variants: [] },
  appearedChapters: [2],
  updatedAt: "2026-10-01T00:00:00.000Z",
};
const PRINCE: Character = {
  ...emptyCharacter("char_003", "殿下"),
  updatedAt: "2026-10-01T00:00:00.000Z",
};

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(nodePath.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeWork(): string {
  const folder = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-mcp-moves-"));
  temporary.push(folder);
  fs.mkdirSync(nodePath.join(folder, "本文"), { recursive: true });
  fs.writeFileSync(nodePath.join(folder, "本文", EPISODE_1), HERO_TEXT, "utf8");
  fs.writeFileSync(nodePath.join(folder, "本文", EPISODE_2), SECOND_TEXT, "utf8");
  for (const person of [hero(), EMPEROR, PRINCE]) {
    writeJson(
      nodePath.join(folder, "設定", "characters", `${person.id}_${person.name}.json`),
      person
    );
  }
  return folder;
}

/** 第1話の答えを1件貯める（保存の道を通すため。新しい人物「エルシー」） */
function stashFirst(folder: string): void {
  const chunkId = settingsPrompt({ folder, filePath: `本文/${EPISODE_1}`, numCtx: NUM_CTX })
    .chunks[0].chunkId;
  settingsValidate({
    folder,
    chunkId,
    response: JSON.stringify({
      characters: [
        {
          name: "エルシー",
          aliases: [],
          entityType: "person",
          role: "雇い主",
          evidence: "エルシーは俺を雇った",
        },
      ],
    }),
    stash: true,
  });
}

function movesDir(folder: string): string {
  return nodePath.join(folder, ".aiwriter", PENDING_MOVES_DIR);
}

function filesIn(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

/** `設定/` の下の全ファイルの指紋。移す案を積んでも台帳は1バイトも変えない */
function settingsFingerprint(folder: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = nodePath.join(dir, name);
      if (fs.statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      hash.update(nodePath.relative(folder, full));
      hash.update(fs.readFileSync(full));
    }
  };
  walk(nodePath.join(folder, "設定"));
  return hash.digest("hex");
}

afterEach(() => {
  for (const folder of temporary.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

describe("novel.extract.commit——保存の終わりに移す案を積む", () => {
  it("主人公に取り違えの値があれば、pending-moves へ1件ずつ積む（製品の読み口で読める形）", () => {
    const folder = makeWork();
    stashFirst(folder);

    const result = extractCommit({ folder });

    const files = filesIn(movesDir(folder));
    expect(files.length).toBeGreaterThan(0);
    expect(result.narratorMoves.staged.length).toBe(files.length);
    // 製品の読み口（提案パネルが使う）で読める
    const kinds = files.map((name) => {
      const parsed: unknown = JSON.parse(
        fs.readFileSync(nodePath.join(movesDir(folder), name), "utf8")
      );
      const move = readPendingNarratorMoveFile(parsed, name);
      expect(move.sourceId).toBe("char_001");
      return move.item.kind;
    });
    expect(kinds).toContain("change");
    expect(kinds).toContain("firstPersonVariant");
    // 案の文は作者が読む言葉で返す
    expect(result.narratorMoves.staged.map((entry) => entry.label)).toContain(
      "移す案：役割「皇子」（第2話）"
    );
  });

  it("台帳（設定/ の既存ファイル）は1バイトも変えない", () => {
    const folder = makeWork();
    stashFirst(folder);
    const before = settingsFingerprint(folder);

    extractCommit({ folder });

    // 新しい人物（エルシー）のファイルが増えるだけで、既存の3人は変わらない
    const created = filesIn(nodePath.join(folder, "設定", "characters")).filter((name) =>
      name.endsWith("_エルシー.json")
    );
    expect(created.length).toBe(1);
    fs.unlinkSync(nodePath.join(folder, "設定", "characters", created[0]));
    expect(settingsFingerprint(folder)).toBe(before);
  });

  it("dryRun では積まず、積む件数だけを返す", () => {
    const folder = makeWork();
    stashFirst(folder);

    const result = extractCommit({ folder, dryRun: true });

    expect(filesIn(movesDir(folder))).toEqual([]);
    expect(result.narratorMoves.staged.length).toBeGreaterThan(0);
  });

  it("同じ案は二度積まない。見送った案も積まない", () => {
    const folder = makeWork();
    stashFirst(folder);
    const first = extractCommit({ folder });
    const files = filesIn(movesDir(folder));
    expect(files.length).toBe(first.narratorMoves.staged.length);

    // 1件を見送ったことにする（製品と同じ置き場へ鍵を書く）
    const dismissed = files[0];
    const payload = JSON.parse(
      fs.readFileSync(nodePath.join(movesDir(folder), dismissed), "utf8")
    ) as { key: string };
    writeJson(nodePath.join(folder, ".aiwriter", "cache", NARRATOR_MOVE_DISMISSED_FILE), [
      payload.key,
    ]);
    fs.unlinkSync(nodePath.join(movesDir(folder), dismissed));

    stashFirst(folder);
    const second = extractCommit({ folder });

    // 残っている案は積み直さず、見送った案も戻らない
    expect(second.narratorMoves.staged).toEqual([]);
    expect(filesIn(movesDir(folder))).toEqual(files.slice(1));
  });

  it("読めない承認待ちがある主人公の案は積まない（壊れたファイルを置き換えない）", () => {
    const folder = makeWork();
    stashFirst(folder);
    fs.mkdirSync(movesDir(folder), { recursive: true });
    fs.writeFileSync(nodePath.join(movesDir(folder), "char_001_broken.json"), "{ 壊れ", "utf8");

    const result = extractCommit({ folder });

    expect(result.narratorMoves.staged).toEqual([]);
    expect(filesIn(movesDir(folder))).toEqual(["char_001_broken.json"]);
    expect(fs.readFileSync(nodePath.join(movesDir(folder), "char_001_broken.json"), "utf8")).toBe(
      "{ 壊れ"
    );
  });
});

describe("pending.list——移す案も並べる", () => {
  it("pending-moves の案を、提案パネルの行と同じ言葉で返す", () => {
    const folder = makeWork();
    stashFirst(folder);
    extractCommit({ folder });

    const result = pendingList({ folder });

    expect(result.narratorMoves.items.length).toBe(filesIn(movesDir(folder)).length);
    const role = result.narratorMoves.items.find(
      (item) => item.label === "移す案：役割「皇子」（第2話）"
    );
    expect(role).toMatchObject({ sourceName: "アジャーノ", status: "pending" });
    expect(role?.changes[0]).toContain("いまの値：");
    // 移し先は MCP からは選べない（理由を添える）
    expect(result.note).toContain("移す案");
  });

  it("人物以外の種類で絞ると、移す案は返さない", () => {
    const folder = makeWork();
    stashFirst(folder);
    extractCommit({ folder });

    expect(pendingList({ folder, kind: "location" }).narratorMoves.items).toEqual([]);
    expect(pendingList({ folder, kind: "character" }).narratorMoves.items.length).toBeGreaterThan(0);
  });

  it("読めない案は直さず unreadable で返す", () => {
    const folder = makeWork();
    fs.mkdirSync(movesDir(folder), { recursive: true });
    fs.writeFileSync(nodePath.join(movesDir(folder), "char_001_broken.json"), "{ 壊れ", "utf8");

    const result = pendingList({ folder });

    expect(result.narratorMoves.items).toEqual([]);
    expect(result.narratorMoves.unreadable.map((entry) => entry.file)).toEqual([
      `.aiwriter/${PENDING_MOVES_DIR}/char_001_broken.json`,
    ]);
  });
});

/**
 * **提案パネルに並ぶものと一致する**こと。製品の出口（`reviewPendingNarratorMoves`
 * → `narratorMoveViewItems`）を、代役の `workspace.fs` を本物のファイルへ繋いで読み比べる。
 */
describe("pending.list の移す案と提案パネルが同じものを並べる", () => {
  beforeEach(() => {
    const missing = (error: unknown): never => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new FileSystemError("missing", "FileNotFound");
      }
      throw error;
    };
    workspace.fs = {
      readFile: async (uri: { fsPath: string }) => {
        try {
          return new Uint8Array(fs.readFileSync(uri.fsPath));
        } catch (error) {
          return missing(error);
        }
      },
      readDirectory: async (uri: { fsPath: string }) => {
        try {
          return fs
            .readdirSync(uri.fsPath, { withFileTypes: true })
            .map(
              (entry) =>
                [
                  entry.name,
                  entry.isDirectory() ? FileType.Directory : FileType.File,
                ] as [string, FileType]
            );
        } catch (error) {
          return missing(error);
        }
      },
      stat: async (uri: { fsPath: string }) => {
        try {
          const stat = fs.statSync(uri.fsPath);
          return {
            type: stat.isDirectory() ? FileType.Directory : FileType.File,
            size: stat.size,
            mtime: stat.mtimeMs,
            ctime: stat.ctimeMs,
          };
        } catch (error) {
          return missing(error);
        }
      },
    } as never;
  });

  it("名前・出どころの欄・本文が、パネルへ渡す形と一致する", async () => {
    const folder = makeWork();
    stashFirst(folder);
    extractCommit({ folder });
    const work: WorkEntry = {
      id: "work_moves",
      title: "作品",
      folderPath: folder,
      registeredAt: "2026-10-11T00:00:00.000Z",
    };

    const panel = narratorMoveViewItems(await reviewPendingNarratorMoves(work));
    const listed = pendingList({ folder }).narratorMoves.items.filter(
      (item) => item.status === "pending"
    );

    expect(panel.length).toBeGreaterThan(0);
    expect(listed.map((item) => item.sourceName)).toEqual(panel.map((item) => item.name));
    expect(listed.map((item) => item.label)).toEqual(panel.map((item) => item.source));
    expect(listed.map((item) => item.changes)).toEqual(panel.map((item) => item.changes));
  });
});
