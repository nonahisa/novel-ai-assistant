import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 設定資料の見張りを、同期のあいだ黙らせる／知らせを1件ずつ出す（設計書5.5.18）。
 *
 * 作者の指摘（2026-09-10）：
 * 「同期時、設定資料の変更で再読み込みをポップアップさせていませんか？」
 * 「同期後の再読み込みに『すべてあとで』を導入」。
 *
 * **gitが書いたファイルは、拡張機能自身の書き込みとして除けない**
 * （`SelfWriteTracker` は書き込み口を通ったものしか知らない）。
 * 取り込んでいる間だけ黙らせるのが、いちばん確かである。
 */

/** 画面に出た知らせと、そのときのボタン */
const shown: Array<{ message: string; buttons: string[] }> = [];
/** 押す答え。先頭から順に使う */
const answers: Array<string | undefined> = [];

vi.mock("vscode", () => ({
  window: {
    showInformationMessage: (message: string, ...rest: unknown[]) => {
      const buttons = rest.filter(
        (item): item is string => typeof item === "string"
      );
      shown.push({ message, buttons });
      return Promise.resolve(answers.shift());
    },
    createOutputChannel: () => ({
      appendLine() {},
      show() {},
      dispose() {},
    }),
  },
  workspace: {
    createFileSystemWatcher: () => ({
      onDidChange: (handler: (uri: { fsPath: string }) => void) => {
        handlers.push(handler);
      },
      onDidCreate: (handler: (uri: { fsPath: string }) => void) => {
        handlers.push(handler);
      },
      dispose() {},
    }),
    getConfiguration: () => ({ get: () => undefined }),
  },
  RelativePattern: class {
    constructor(readonly base: string, readonly pattern: string) {}
  },
  Uri: {
    file: (value: string) => ({ fsPath: value, scheme: "file", path: value }),
  },
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  },
}));

/** 登録した監視の受け口。ここへ流し込むと「外で変わった」ことになる */
const handlers: Array<(uri: { fsPath: string }) => void> = [];

const 作品フォルダー = "C:/書庫/短編";

vi.mock("../../src/core/workRegistry", () => ({
  readWorkConfig: async () => ({}),
  workPaths: () => ({ settings: `${作品フォルダー}/設定` }),
}));

const {
  SettingsWatcher,
  notifyExternalChange,
  clearExternalChangeQueue,
  describeExternalChange,
  externalChangeButtons,
} = await import("../../src/features/watchSettings");
const { SelfWriteTracker } = await import("../../src/core/externalChanges");

const 短編 = { id: "w1", title: "短編", folderPath: 作品フォルダー } as never;
const 長編 = {
  id: "w2",
  title: "長編",
  folderPath: "C:/書庫/長編",
} as never;

/** 何もしない操作の組。押されたことだけ数える */
function actions() {
  const calls = { review: 0, reload: 0, protect: 0 };
  return {
    calls,
    handlers: {
      review: async () => {
        calls.review += 1;
      },
      reload: () => {
        calls.reload += 1;
      },
      protect: async () => {
        calls.protect += 1;
      },
    },
  };
}

beforeEach(() => {
  shown.length = 0;
  answers.length = 0;
  handlers.length = 0;
  clearExternalChangeQueue();
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("知らせの文面とボタン", () => {
  test("作品名と、変わったファイルの名前を出す", () => {
    const text = describeExternalChange(短編, [
      `${作品フォルダー}/設定/characters/char_001_太志.json`,
    ]);

    expect(text).toContain("短編");
    expect(text).toContain("char_001_太志.json");
  });

  test("4件目からは「ほか」でまとめる", () => {
    const text = describeExternalChange(
      短編,
      ["a", "b", "c", "d", "e"].map((name) => `${作品フォルダー}/設定/characters/${name}.json`)
    );

    expect(text).toContain("ほか2件");
  });

  test("待っているものが無ければ「すべてあとで」は出さない", () => {
    // 1件しか無いときに出しても、意味が違って読める
    expect(externalChangeButtons(false)).not.toContain("すべてあとで");
  });

  test("待っているものがあれば「すべてあとで」を足す", () => {
    // 作者の指示（2026-09-10）。**1つずつ閉じさせない**
    expect(externalChangeButtons(true)).toContain("すべてあとで");
  });
});

describe("知らせの待ち行列", () => {
  test("同時に来ても、1件ずつ順に出す", async () => {
    // 通知を積み上げると、返事を待っている問いが下へ押し出される
    const first = actions();
    const second = actions();
    answers.push("閉じる", "閉じる");

    const running = notifyExternalChange(短編, ["a.json"], first.handlers);
    await notifyExternalChange(長編, ["b.json"], second.handlers);
    await running;

    expect(shown).toHaveLength(2);
    expect(shown[0].message).toContain("短編");
    expect(shown[1].message).toContain("長編");
  });

  test("「すべてあとで」で待ち行列を空にする", async () => {
    const first = actions();
    const second = actions();
    const third = actions();
    answers.push("すべてあとで");

    const running = notifyExternalChange(短編, ["a.json"], first.handlers);
    const alsoRunning = notifyExternalChange(長編, ["b.json"], second.handlers);
    await notifyExternalChange(短編, ["c.json"], third.handlers);
    await running;
    await alsoRunning;

    // 出たのは1件だけ。残りは問わずに片づける
    expect(shown).toHaveLength(1);
    // **読み直しだけは各作品ぶん行う。** 画面が古いままだと、
    // 「あとで」を押しただけで見えているものが嘘になる
    expect(first.calls.reload).toBe(1);
    expect(second.calls.reload).toBe(1);
    expect(third.calls.reload).toBe(1);
  });

  test("「変更を確認」は、その1件だけに効く", async () => {
    const first = actions();
    const second = actions();
    answers.push("変更を確認", "閉じる");

    const running = notifyExternalChange(短編, ["a.json"], first.handlers);
    await notifyExternalChange(長編, ["b.json"], second.handlers);
    await running;

    expect(first.calls.review).toBe(1);
    expect(second.calls.review).toBe(0);
    // 2件目もちゃんと出る
    expect(shown).toHaveLength(2);
  });
});

describe("同期のあいだは黙らせる", () => {
  /** 見張りを1つ立てて、監視の受け口が張られるのを待つ */
  async function watcher(): Promise<{
    watcher: InstanceType<typeof SettingsWatcher>;
    fire: (fileName: string) => void;
    changes: Array<{ title: string; files: string[] }>;
  }> {
    const changes: Array<{ title: string; files: string[] }> = [];
    const registry = {
      list: () => [短編],
      onDidChange: () => ({ dispose() {} }),
    } as never;
    const made = new SettingsWatcher(
      registry,
      new SelfWriteTracker(),
      (work, files) => changes.push({ title: work.title, files })
    );
    // 監視の張り直しは非同期。受け口が並ぶまで待つ
    for (let i = 0; i < 20 && handlers.length === 0; i += 1) {
      await Promise.resolve();
    }
    return {
      watcher: made,
      fire: (fileName) => {
        const uri = {
          fsPath: `${作品フォルダー}/設定/characters/${fileName}`,
        };
        for (const handler of handlers) handler(uri);
      },
      changes,
    };
  }

  test("止めている間に来た変更は捨てる", async () => {
    vi.useFakeTimers();
    const { watcher: made, fire, changes } = await watcher();
    expect(handlers.length).toBeGreaterThan(0);

    const resume = made.pause(短編);
    fire("char_001_太志.json");
    await vi.advanceTimersByTimeAsync(5000);

    expect(changes).toHaveLength(0);
    resume();
    made.dispose();
  });

  test("再開の直後に遅れて届いた分も捨てる", async () => {
    // **ファイル監視の知らせは、書き込みより遅れて届く**
    vi.useFakeTimers();
    const { watcher: made, fire, changes } = await watcher();

    made.pause(短編)();
    fire("char_001_太志.json");
    await vi.advanceTimersByTimeAsync(2000);

    expect(changes).toHaveLength(0);
    made.dispose();
  });

  test("しばらく経てば、また知らせる", async () => {
    vi.useFakeTimers();
    const { watcher: made, fire, changes } = await watcher();

    made.pause(短編)();
    await vi.advanceTimersByTimeAsync(4000);
    fire("char_001_太志.json");
    await vi.advanceTimersByTimeAsync(2000);

    expect(changes).toHaveLength(1);
    expect(changes[0].files[0]).toContain("char_001_太志.json");
    made.dispose();
  });

  test("作品を指定しなければ、全部を止める", async () => {
    vi.useFakeTimers();
    const { watcher: made, fire, changes } = await watcher();

    const resume = made.pause();
    fire("char_001_太志.json");
    await vi.advanceTimersByTimeAsync(5000);

    expect(changes).toHaveLength(0);
    resume();
    made.dispose();
  });
});
