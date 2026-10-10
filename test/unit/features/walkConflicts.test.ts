import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

/**
 * 1件ずつ見比べる入口（設計書5.5.18）。
 *
 * 作者の手元で13作品ぶんの分岐が起き、**「1件ずつ選ぶ」しか道が無い画面から
 * 抜けられなくなった**（2026-09-11）。作者の言葉：「全部最新を優先する
 * 選択肢をまず提示し、操作をシンプルにしてください」。
 *
 * ここでも vscode だけを差し替えて、**gitとファイルは本物を使う**。
 * 索引の版を取り出して書き戻すところは、作り物の返事では確かめられない。
 */

/** 画面に出た問いと、答えとして用意したボタン */
const answers: string[] = [];
const shown: string[] = [];
/** QuickPick で選ぶ項目の見出し（含まれていれば、それを選ぶ） */
const picks: string[] = [];
/**
 * 呼ばれた順に使う QuickPick の答え。`undefined` は「選ばずに閉じた」。
 * 空になったら `picks` へ戻る（「1回目は閉じる・2回目は選ぶ」を書くため）
 */
const pickScript: Array<string | undefined> = [];
/** QuickPick に渡された項目と設定（見出し・ignoreFocusOut を確かめる） */
const quickPicks: Array<{
  items: Array<{ label?: string; description?: string; detail?: string }>;
  options?: { title?: string; placeHolder?: string; ignoreFocusOut?: boolean };
}> = [];

vi.mock("vscode", () => {
  /** 本物の vscode と同じく、無いファイルは FileNotFound で知らせる */
  class FileSystemError extends Error {
    constructor(
      message: string,
      public code: string
    ) {
      super(message);
    }
  }
  const readFile = async (uri: { fsPath: string }) => {
    if (!fs.existsSync(uri.fsPath)) {
      throw new FileSystemError(uri.fsPath, "FileNotFound");
    }
    return new Uint8Array(fs.readFileSync(uri.fsPath));
  };
  return {
    FileSystemError,
    window: {
      showInformationMessage: (message: string, ...rest: unknown[]) => {
        record(message, rest);
        return Promise.resolve(pickAnswer(rest));
      },
      showWarningMessage: (message: string, ...rest: unknown[]) => {
        record(message, rest);
        return Promise.resolve(pickAnswer(rest));
      },
      showErrorMessage: (message: string, ...rest: unknown[]) => {
        record(message, rest);
        return Promise.resolve(pickAnswer(rest));
      },
      showQuickPick: (
        items: unknown,
        options?: { title?: string; placeHolder?: string; ignoreFocusOut?: boolean }
      ) => {
        shown.push(options?.title ?? "（見出しなし）");
        quickPicks.push({
          items: Array.isArray(items) ? items : [],
          options,
        });
        if (pickScript.length > 0) {
          const wanted = pickScript.shift();
          return Promise.resolve(
            wanted === undefined ? undefined : pickItem(items, [wanted])
          );
        }
        return Promise.resolve(pickItem(items));
      },
      showTextDocument: () => Promise.resolve(undefined),
      createOutputChannel: () => ({
        appendLine() {},
        show() {},
        dispose() {},
      }),
    },
    workspace: {
      fs: {
        readFile,
        // 「両方とも残す」の別ファイルを本当に作るため（`atomicWriteFile` の create）
        writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
          fs.mkdirSync(nodePath.dirname(uri.fsPath), { recursive: true });
          fs.writeFileSync(uri.fsPath, bytes);
        },
        rename: async (
          from: { fsPath: string },
          to: { fsPath: string },
          options?: { overwrite?: boolean }
        ) => {
          if (!options?.overwrite && fs.existsSync(to.fsPath)) {
            throw new FileSystemError(to.fsPath, "FileExists");
          }
          fs.renameSync(from.fsPath, to.fsPath);
        },
        delete: async (uri: { fsPath: string }) => {
          fs.rmSync(uri.fsPath, { force: true });
        },
        readDirectory: async (uri: { fsPath: string }) =>
          fs.readdirSync(uri.fsPath).map((name) => [name, 1] as const),
      },
      getConfiguration: () => ({ get: () => undefined }),
      openTextDocument: () => Promise.resolve({}),
      textDocuments: [],
    },
    commands: {
      registerCommand: () => ({ dispose() {} }),
      executeCommand: () => Promise.resolve(undefined),
    },
    languages: { setTextDocumentLanguage: () => Promise.resolve(undefined) },
    Uri: {
      file: (value: string) => ({ fsPath: value, scheme: "file", path: value }),
      parse: (value: string) => ({ fsPath: value, scheme: "file", path: value }),
      from: (parts: { scheme: string; path: string }) => ({
        ...parts,
        fsPath: parts.path,
        toString: () => `${parts.scheme}:${parts.path}`,
      }),
    },
    Position: class {
      constructor(
        public line: number,
        public character: number
      ) {}
    },
    WorkspaceEdit: class {
      insert() {}
    },
    EventEmitter: class {
      event = () => ({ dispose() {} });
      fire() {}
      dispose() {}
    },
  };
});

function record(message: string, rest: unknown[]): void {
  const detail = rest.find(
    (item): item is { detail?: string } =>
      typeof item === "object" && item !== null && "detail" in item
  )?.detail;
  shown.push(detail ? `${message}\n${detail}` : message);
}

function pickAnswer(rest: unknown[]): string | undefined {
  const buttons = rest.filter((item) => typeof item === "string") as string[];
  return answers.find((answer) => buttons.includes(answer));
}

/** 用意した見出しに当たる項目を返す。当たらなければ「取りやめる」扱い */
function pickItem(items: unknown, wantedList: readonly string[] = picks): unknown {
  if (!Array.isArray(items)) return undefined;
  for (const wanted of wantedList) {
    const found = items.find(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { label?: unknown }).label === "string" &&
        (item as { label: string }).label.includes(wanted)
    );
    if (found) return found;
  }
  return undefined;
}

const {
  ConflictContentProvider,
  describeWalkStart,
  describeWalkStartDetail,
  walkConflicts,
} = await import("../../../src/features/resolveConflicts");

let root: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function write(dir: string, file: string, body: string): void {
  const full = nodePath.join(dir, file);
  fs.mkdirSync(nodePath.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

const 人物ファイル = "いじめられっ子/設定/characters/char_001.json";
const 原稿ファイル = "いじめられっ子/本文/第1話.txt";

function 人物(summary: string, updatedAt: string): string {
  return `${JSON.stringify(
    {
      schemaVersion: "0.1",
      id: "char_001",
      name: "太志",
      summary,
      appearedChapters: [1],
      authorNotes: "",
      exportNote: "",
      autoGenerated: true,
      updatedAt,
    },
    null,
    2
  )}\n`;
}

/**
 * 両方の側で同じ箇所を書き換えた状態を作り、**本物のマージを途中で止める**。
 * この状態でないと、索引の2番・3番の版を取り出せない。
 */
function setUpConflict(): void {
  root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-walk-"));
  git(root, "init", "-q", "-b", "main");
  // 端末のgitの設定で結果が変わらないようにする
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "user.name", "作者");
  git(root, "config", "user.email", "author@example.com");

  write(root, 人物ファイル, 人物("もとの紹介", "2026-09-01T00:00:00.000Z"));
  write(root, 原稿ファイル, "もとの一行。\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "土台");

  git(root, "checkout", "-q", "-b", "別環境");
  write(root, 人物ファイル, 人物("むこうの紹介", "2026-09-05T00:00:00.000Z"));
  write(root, 原稿ファイル, "むこうの一行。\n");
  git(root, "commit", "-qam", "別のPCで直した");

  git(root, "checkout", "-q", "main");
  write(root, 人物ファイル, 人物("こちらの紹介", "2026-09-03T00:00:00.000Z"));
  write(root, 原稿ファイル, "こちらの一行。\n");
  git(root, "commit", "-qam", "こちらで直した");

  // 衝突するので終了コードは 0 にならない。**止まった状態が欲しい**
  try {
    git(root, "merge", "--no-commit", "別環境");
  } catch {
    // CONFLICT で落ちるのが正しい
  }
}

function scope() {
  return { id: "w1", title: "いじめられっ子", folderPath: root };
}

function read(file: string): string {
  return fs.readFileSync(nodePath.join(root, file), "utf8");
}

beforeEach(() => {
  answers.length = 0;
  shown.length = 0;
  picks.length = 0;
  pickScript.length = 0;
  quickPicks.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// 本物のgitを子プロセスで何度も起動するので、既定の5秒では足りない
describe("全部、新しいほうを採る", { timeout: 30_000 }, () => {
  /*
    **フックにも別に猶予が要る**（2026-09-18）。`describe` に与えた
    `timeout` は**テスト本体にしか効かない**——フックは `hookTimeout`
    （既定10秒）で動く。`setUpConflict()` は git を子プロセスで7回起こすので、
    **手元では通るのにCIの遅い機械で並列に走ると超える。**
    `resolveDivergence.test.ts` が同じ形で実際に落ちた。
  */
  beforeEach(() => {
    setUpConflict();
  }, 30_000);

  test("設定資料は一度に片づき、原稿だけ見比べに回る", async () => {
    answers.push("全部、新しいほうを採る");
    // 原稿は1件ずつ。ここでは「こちら」を選ぶ
    picks.push("左の文を残す");

    const result = await walkConflicts(scope(), [人物ファイル, 原稿ファイル], {
      provider: new ConflictContentProvider(),
    });

    expect(result.aborted).toBe(false);
    // **一括で寄せた分と、選んでもらった分は分けて返す**（2026-09-11）。
    // 混ぜると、済んだあとの知らせが一括の分まで
    // 「お選びいただきました」と言ってしまう
    expect(result.bulkResolved).toEqual([人物ファイル]);
    expect(result.resolved).toEqual([原稿ファイル]);
    // 設定資料は更新時刻の新しいほう（別環境）へ揃った
    expect(read(人物ファイル)).toContain("むこうの紹介");
    // **原稿は一括で寄せない。** 作者が選んだ側になる
    expect(read(原稿ファイル)).toBe("こちらの一行。\n");
    // 見比べの画面は原稿の1件だけ
    expect(shown.filter((text) => text.includes("どちらの文を残しますか"))).toHaveLength(
      1
    );
  });

  /**
   * 一括で寄せた分を `resolved` に混ぜない（2026-09-11）。
   *
   * 作者が13件を一括で片づけたのに、済んだあとの知らせが
   * 「本文など13件はお選びいただきました」と出ていた。数え分けは、
   * 文面を組む側（`describeFoldSuccess`）ではなく**ここで**する——
   * 混ぜて渡すと、受け取った側にはもう分けようがない。
   */
  test("一括で寄せたものは resolved に入らない", async () => {
    answers.push("全部、新しいほうを採る");
    picks.push("左の文を残す");

    const result = await walkConflicts(scope(), [人物ファイル, 原稿ファイル], {
      provider: new ConflictContentProvider(),
    });

    expect(result.resolved).not.toContain(人物ファイル);
    expect(result.bulkResolved).not.toContain(原稿ファイル);
    // どちらにも入らないファイルは無い（**確定した分は必ずどちらかで数える**）
    expect([...result.resolved, ...result.bulkResolved].sort()).toEqual(
      [人物ファイル, 原稿ファイル].sort()
    );
  });

  test("設定資料しか無ければ、見比べを1件も出さずに終わる", async () => {
    answers.push("全部、新しいほうを採る");

    const result = await walkConflicts(scope(), [人物ファイル], {
      provider: new ConflictContentProvider(),
    });

    expect(result.aborted).toBe(false);
    // 作者は1件も選んでいない。**`resolved` は空のままにする**
    expect(result.resolved).toEqual([]);
    expect(result.bulkResolved).toEqual([人物ファイル]);
    expect(shown.filter((text) => text.includes("どちらの文を残しますか"))).toEqual(
      []
    );
  });

  test("1件ずつ選ぶを選べば、設定資料も見比べに回る", async () => {
    // まとめて片づける道を足しても、**これまでの道は残す**
    answers.push("1件ずつ選ぶ");
    // 1件確定するごとに「次へ」を押す（ボタンであって QuickPick ではない）
    answers.push("次へ");
    picks.push("左の文を残す");

    const result = await walkConflicts(scope(), [人物ファイル, 原稿ファイル], {
      provider: new ConflictContentProvider(),
    });

    expect(result.resolved).toEqual([人物ファイル, 原稿ファイル]);
    // こちらは一括の道を通っていない。**全部が「選んだ」分になる**
    expect(result.bulkResolved).toEqual([]);
    expect(read(人物ファイル)).toContain("こちらの紹介");
  });

  test("どちらのボタンも押さなければ、取りやめる", async () => {
    const result = await walkConflicts(scope(), [人物ファイル, 原稿ファイル], {
      provider: new ConflictContentProvider(),
    });

    expect(result.aborted).toBe(true);
    expect(result.resolved).toEqual([]);
    expect(result.bulkResolved).toEqual([]);
  });
});

/**
 * 入口の窓を省く（作者の裁定、2026-10-01 案2）。
 *
 * ［保存・同期］の確認の窓（または「分岐合流」の確認の窓）で、もう
 * 「設定資料は新しいほうへ／1件ずつ」を選んでもらっている。続けて同じ問いの
 * 窓を出すと、作者の言う「3クリック」の1つになる。
 */
describe("確認の窓で選んだあとは、入口の窓を出さない", { timeout: 30_000 }, () => {
  beforeEach(() => {
    setUpConflict();
  }, 30_000);

  const 入口 = (text: string) => text.includes("同じ箇所を両方で書き換えたものが");

  test("「新しいほうへ」を選んであれば、設定資料はそのまま一括で片づける", async () => {
    picks.push("左の文を残す");

    const result = await walkConflicts(scope(), [人物ファイル, 原稿ファイル], {
      provider: new ConflictContentProvider(),
      start: "newest",
    });

    expect(shown.filter(入口)).toEqual([]);
    expect(result.aborted).toBe(false);
    expect(result.bulkResolved).toEqual([人物ファイル]);
    expect(result.resolved).toEqual([原稿ファイル]);
    expect(read(人物ファイル)).toContain("むこうの紹介");
  });

  test("「1件ずつ」を選んであれば、設定資料も見比べに回す", async () => {
    answers.push("次へ");
    picks.push("左の文を残す");

    const result = await walkConflicts(scope(), [人物ファイル, 原稿ファイル], {
      provider: new ConflictContentProvider(),
      start: "oneByOne",
    });

    expect(shown.filter(入口)).toEqual([]);
    expect(result.resolved).toEqual([人物ファイル, 原稿ファイル]);
  });

  test("選ぶ設定資料が無い見込みで、原稿だけなら入口を出さない", async () => {
    picks.push("左の文を残す");

    const result = await walkConflicts(scope(), [原稿ファイル], {
      provider: new ConflictContentProvider(),
      start: "manuscriptsOnly",
    });

    expect(shown.filter(入口)).toEqual([]);
    expect(result.resolved).toEqual([原稿ファイル]);
  });

  test("見込みが外れて設定資料が出たら、黙って決めずに入口の窓で訊く", async () => {
    // 確認の窓では「選ぶ設定資料は無い」と言っていた。**訊いていないことを決めない**
    answers.push("1件ずつ選ぶ");
    answers.push("次へ");
    picks.push("左の文を残す");

    await walkConflicts(scope(), [人物ファイル, 原稿ファイル], {
      provider: new ConflictContentProvider(),
      start: "manuscriptsOnly",
    });

    expect(shown.filter(入口)).toHaveLength(1);
  });
});

/**
 * どちらの文を残すかの一覧（作者の実機確認、2026-10-11）。
 *
 * 作者は分岐合流を実機で確かめ、**差分を読みに行った拍子に一覧が消え、
 * 「選ばずに閉じた」扱いで最初へ戻った。** 見出しには git の印
 * （`origin/main:本文/…`）がそのまま出ていて、どちらがどちらか読めなかった。
 * 裁定は「閉じない＋訊き直す」「このパソコン／もう1台で呼ぶ」。
 */
describe("どちらの文を残すかの一覧", { timeout: 30_000 }, () => {
  beforeEach(() => {
    setUpConflict();
  }, 30_000);

  test("左右を「このパソコン」「もう1台」で呼び、差分を読みに行っても閉じない", async () => {
    picks.push("左の文を残す");

    await walkConflicts(scope(), [原稿ファイル], {
      provider: new ConflictContentProvider(),
      start: "manuscriptsOnly",
      machineName: "書斎のPC",
    });

    const pick = quickPicks[0];
    expect(pick.options?.title).toBe("第1話.txt：どちらの文を残しますか");
    expect(pick.options?.placeHolder).toContain(
      "左がこのパソコン、右がもう1台の文です"
    );
    expect(pick.options?.ignoreFocusOut).toBe(true);
    const labels = pick.items.map((item) => item.label ?? "");
    expect(labels).toContain("$(arrow-left) 左の文を残す（このパソコン）");
    expect(labels).toContain("$(arrow-right) 右の文を残す（もう1台）");
    expect(labels).toContain("$(files) 両方とも残す");
    // git の印は出さない
    expect(JSON.stringify(pick.items)).not.toContain("origin");
    expect(JSON.stringify(pick.items)).not.toContain("環境");
  });

  test("選ばずに閉じたら、すぐ戻さずに訊く。［もう一度選ぶ］で同じ一覧が出る", async () => {
    // 1回目は閉じる、2回目は左を選ぶ
    pickScript.push(undefined, "左の文を残す");
    answers.push("もう一度選ぶ");

    const result = await walkConflicts(scope(), [原稿ファイル], {
      provider: new ConflictContentProvider(),
      start: "manuscriptsOnly",
      machineName: null,
    });

    expect(
      shown.filter((text) => text.includes("選ばずに閉じました"))
    ).toHaveLength(1);
    expect(shown.join("\n")).toContain("原稿はまだ何も変えていません");
    expect(quickPicks).toHaveLength(2);
    expect(result.aborted).toBe(false);
    expect(result.resolved).toEqual([原稿ファイル]);
    expect(read(原稿ファイル)).toBe("こちらの一行。\n");
  });

  test("［そろえるのをやめる］なら、今までどおりやめる", async () => {
    pickScript.push(undefined);
    answers.push("そろえるのをやめる");

    const result = await walkConflicts(scope(), [原稿ファイル], {
      provider: new ConflictContentProvider(),
      start: "manuscriptsOnly",
      machineName: null,
    });

    expect(result.aborted).toBe(true);
    expect(quickPicks).toHaveLength(1);
  });

  test("訊いた窓も閉じたら、やめる", async () => {
    pickScript.push(undefined);

    const result = await walkConflicts(scope(), [原稿ファイル], {
      provider: new ConflictContentProvider(),
      start: "manuscriptsOnly",
      machineName: null,
    });

    expect(result.aborted).toBe(true);
  });

  test("両方とも残すと、日時の名前の別ファイルを作り、git へはまだ足さない", async () => {
    picks.push("両方とも残す");

    const result = await walkConflicts(scope(), [原稿ファイル], {
      provider: new ConflictContentProvider(),
      start: "manuscriptsOnly",
      machineName: null,
    });

    expect(result.aborted).toBe(false);
    const sideFiles = result.sideFiles ?? [];
    expect(sideFiles).toHaveLength(1);
    const side = sideFiles[0];
    expect(side).toMatch(
      /^いじめられっ子\/本文\/第1話\.conflict-\d{4}-\d{2}-\d{2}-\d{4}\.txt$/
    );
    // 一覧に見せた名前と、作った名前が同じ
    expect(JSON.stringify(quickPicks[0].items)).toContain(
      side.slice(side.lastIndexOf("/") + 1)
    );
    expect(read(side)).toBe("むこうの一行。\n");
    expect(read(原稿ファイル)).toBe("こちらの一行。\n");
    // **索引へはまだ入れない**（やめたときの merge --abort で消えないように）
    expect(git(root, "status", "--porcelain", "--", side).trim()).toMatch(/^\?\?/);
  });
});

/**
 * 押す前に見せる中身。
 *
 * **ファイル名の羅列をやめた。** 13作品ぶんの分岐では、名前を8件並べても
 * 「どの作品がどれだけ残っているか」が分からない（2026-09-11）。
 */
describe("見比べを始める前に出す中身", () => {
  const いじめ設定 = "いじめられっ子/設定/characters/char_001.json";
  const いじめ原稿 = "いじめられっ子/本文/第1話.txt";
  const 短編設定 = "短編/設定/locations/loc_001.json";

  test("合計と内訳を先頭行に出す", () => {
    expect(describeWalkStart([いじめ設定, いじめ原稿, 短編設定])).toContain(
      "同じ箇所を両方で書き換えたものが 3件あります（設定資料 2件・原稿 1件）"
    );
  });

  test("作品ごとの件数になる", () => {
    const detail = describeWalkStartDetail([いじめ設定, いじめ原稿, 短編設定]);

    expect(detail).toContain("いじめられっ子：設定資料 1件／原稿 1件");
    expect(detail).toContain("短編：設定資料 1件／原稿 0件");
    // ファイル名は並べない
    expect(detail).not.toContain("char_001.json");
  });

  test("置き場の直下にあるものは、まとめて1つの束にする", () => {
    expect(describeWalkStartDetail(["README.md"])).toContain(
      "（置き場の直下）：設定資料 0件／原稿 1件"
    );
  });

  test("設定資料があれば、一括で片づく道を案内する", () => {
    const detail = describeWalkStartDetail([いじめ設定, いじめ原稿]);

    expect(detail).toContain("全部、新しいほうを採る");
    expect(detail).toContain("原稿だけ1件ずつ");
  });

  test("設定資料が0件なら、一括の案内を出さない", () => {
    // 押しても何も減らないボタンは出さないので、案内も出さない
    const detail = describeWalkStartDetail([いじめ原稿]);

    expect(detail).not.toContain("全部、新しいほうを採る");
    expect(detail).toContain("1件ずつ両方を並べます");
  });

  test("そろえる前へ丸ごと戻せることを、必ず添える", () => {
    // **選んだあとで後悔しても戻れる**と分かれば、押す手がとまらない
    const detail = describeWalkStartDetail([いじめ原稿]);
    expect(detail).toContain("「そろえる前」へ丸ごと戻せます");
    // 作者の目に触れる文に、開発の言葉（枝・環境）を出さない（2026-10-11）
    expect(detail).not.toContain("枝");
    expect(detail).not.toContain("環境");
  });
});
