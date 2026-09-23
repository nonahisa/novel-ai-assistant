import { beforeEach, describe, expect, test } from "vitest";
import { syncAllWorks } from "../../src/features/syncAllWorks";
import type { GitCommandRunner } from "../../src/core/git";
import type { WorkRegistry } from "../../src/core/workRegistry";
import type { GitSyncMonitorLike } from "../../src/features/gitSyncStub";
import type { WorkEntry } from "../../src/models/types";
import { window } from "./support/vscodeStub";

/**
 * 「作品をすべて同期」を、作り物の git で一通り走らせる（設計書5.5.14）。
 *
 * 実機確認リスト A-15 のうち、**画面に出る中身**——確認が何回出るか、
 * 進捗に何と書くか、どの順に git を呼ぶか、中止したときに何も起きないか
 * ——を機械で見るためのもの。QuickPick や通知が実際に画面へ出ることは
 * 実機に残る。
 *
 * **本物の git は呼ばない。** ここで確かめたいのは手順の並びであって、
 * git そのものの振る舞いではない（そちらは `resolveDivergence.test.ts` が
 * 本物のリポジトリで見ている）。
 */

const library = "C:/書庫";

/** 同じ置き場（書庫）に入っている2作品 */
const works: WorkEntry[] = [
  { id: "w1", title: "いじめられっ子", folderPath: "C:/書庫/いじめられっ子" },
  { id: "w2", title: "ハイエルフ未亡人", folderPath: "C:/書庫/ハイエルフ未亡人" },
] as WorkEntry[];

const registry = { list: () => works } as unknown as WorkRegistry;

let refreshedAll = 0;
const monitor = {
  refreshAll: async () => {
    refreshedAll += 1;
  },
} as unknown as GitSyncMonitorLike;

/** 呼ばれた git の副コマンド（順番どおり） */
let calls: string[][] = [];

/**
 * 記録するものが2件あり、1件遅れていて、1件送っていない置き場。
 *
 * 記録・取り込み・送信の3つが全部立つので、**順番が見える。**
 */
const busyRepo: GitCommandRunner = async (args) => {
  calls.push(args);
  const joined = args.join(" ");
  if (args[0] === "--version") {
    return { code: 0, stdout: "git version 2.55", stderr: "" };
  }
  if (joined === "rev-parse --is-inside-work-tree") {
    return { code: 0, stdout: "true", stderr: "" };
  }
  if (joined === "rev-parse --show-toplevel") {
    return { code: 0, stdout: library, stderr: "" };
  }
  // 記録できる件数（未追跡も含めて数える）。作業ツリーは「きれい」に見せる
  // ——取り込みは未記録の変更が残っていると走らない決まりだからである
  if (joined === "status --porcelain --untracked-files=all") {
    return { code: 0, stdout: " M 本文/001.txt\n M 本文/002.txt\n", stderr: "" };
  }
  if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
  if (joined === "remote") return { code: 0, stdout: "origin", stderr: "" };
  if (args[0] === "symbolic-ref") return { code: 0, stdout: "main", stderr: "" };
  if (joined.startsWith("rev-parse --abbrev-ref")) {
    return { code: 0, stdout: "origin/main", stderr: "" };
  }
  if (args[0] === "rev-list") return { code: 0, stdout: "1\t1", stderr: "" };
  if (args[0] === "config") return { code: 0, stdout: "作者", stderr: "" };
  if (args[0] === "diff") return { code: 1, stdout: "", stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
};

/** 出た確認・通知の本文（detail も含める） */
let shown: string[] = [];
/** 進捗に出た文言 */
let progressed: string[] = [];
/** 確認の答え（「同期する」で進み、undefined で中止） */
let answer: string | undefined = "同期する";

beforeEach(() => {
  calls = [];
  shown = [];
  progressed = [];
  refreshedAll = 0;
  answer = "同期する";

  Object.assign(window, {
    withProgress: (
      _options: unknown,
      task: (
        progress: { report(value: { message?: string }): void },
        token: { isCancellationRequested: boolean }
      ) => unknown
    ) =>
      Promise.resolve(
        task(
          {
            report: (value) => {
              if (value.message) progressed.push(value.message);
            },
          },
          { isCancellationRequested: false }
        )
      ),
    showInformationMessage: async (message: string, ...rest: unknown[]) => {
      const detail = rest.find(
        (item): item is { detail?: string } =>
          typeof item === "object" && item !== null && "detail" in item
      )?.detail;
      shown.push(detail ? `${message}\n${detail}` : message);
      // ボタンが並んでいるものだけが確認。ただの知らせには答えない
      return rest.some((item) => typeof item === "string") ? answer : undefined;
    },
    showWarningMessage: async (message: string) => {
      shown.push(message);
      return undefined;
    },
  });
});

describe("作品をすべて同期", () => {
  test("置き場が同じなら、確認は1回だけ（実機確認リスト A-15 の代わり）", async () => {
    await syncAllWorks({ registry, monitor, run: busyRepo });

    // ボタン付きの問いは1つ。作品が2つあっても、置き場は1つだから
    const confirms = shown.filter((text) => text.includes("か所を同期します"));
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toContain("1か所を同期します");
    // 一覧には、置き場と中の作品の両方が出る
    expect(confirms[0]).toContain("いじめられっ子");
    expect(confirms[0]).toContain("ハイエルフ未亡人");
    expect(confirms[0]).toContain("記録 2件");
  });

  test("記録 → 取り込み → 送信の順に進む（実機確認リスト A-15 の代わり）", async () => {
    await syncAllWorks({ registry, monitor, run: busyRepo });

    const order = calls
      .map((args) => args[0])
      .filter((name) => name === "commit" || name === "pull" || name === "push");
    expect(order).toEqual(["commit", "pull", "push"]);
  });

  test("進捗に置き場の名前が出る（実機確認リスト A-15 の代わり）", async () => {
    await syncAllWorks({ registry, monitor, run: busyRepo });

    expect(progressed.some((text) => text.includes("書庫"))).toBe(true);
    expect(progressed.some((text) => text.includes("（1/1）"))).toBe(true);
  });

  test("中止すると、記録も取り込みも送信もしない（実機確認リスト A-15 の代わり）", async () => {
    answer = undefined;
    await syncAllWorks({ registry, monitor, run: busyRepo });

    const wrote = calls.filter(
      (args) =>
        args[0] === "commit" ||
        args[0] === "pull" ||
        args[0] === "push" ||
        args[0] === "add"
    );
    expect(wrote).toEqual([]);
    // 状態表示も作り直さない（何も起きていないため）
    expect(refreshedAll).toBe(0);
  });

  test("済んだら、同期の印を作り直す（実機確認リスト A-15 の代わり）", async () => {
    await syncAllWorks({ registry, monitor, run: busyRepo });
    expect(refreshedAll).toBe(1);
  });
});

/**
 * 分かれていたときの流れ（設計書5.5.18、実機確認リスト A-17）。
 *
 * 0.45.0 より前は、報告に「『分かれた分を合わせる』でお試しください」と
 * 出すだけだった。**作者にとって、そこが行き止まりだった**——
 * 「競合がぜんぜん消えません」。**いまは同期の中で合わせにいく。**
 */
describe("分かれている置き場があるとき", () => {
  /** 記録も送信もできるが、`pull` だけ早送りできない置き場 */
  const divergedRepo: GitCommandRunner = async (args, cwd, timeout) => {
    if (args[0] === "pull") {
      calls.push(args);
      return { code: 1, stdout: "", stderr: "not possible to fast-forward" };
    }
    if (args[0] === "merge" || args[0] === "branch") {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    }
    return busyRepo(args, cwd, timeout);
  };

  beforeEach(() => {
    Object.assign(window, {
      showWarningMessage: async (message: string, ...rest: unknown[]) => {
        const detail = rest.find(
          (item): item is { detail?: string } =>
            typeof item === "object" && item !== null && "detail" in item
        )?.detail;
        shown.push(detail ? `${message}\n${detail}` : message);
        return undefined;
      },
    });
  });

  test("その場で合わせにいく（設計書5.5.18）", async () => {
    await syncAllWorks({ registry, monitor, run: divergedRepo });

    // 退避の枝を作ってから、確定させずに畳む
    expect(calls.some((args) => args[0] === "branch")).toBe(true);
    expect(
      calls.some(
        (args) => args[0] === "merge" && args.includes("--no-commit")
      )
    ).toBe(true);
  });

  test("合わせたあとも、送信まで進む（設計書5.5.18）", async () => {
    // **同期の流れを途中で止めない。** 合わせただけで終わると、
    // 作者はもう一度同じボタンを押すことになる
    await syncAllWorks({ registry, monitor, run: divergedRepo });

    const order = calls
      .map((args) => args[0])
      .filter((name) => name === "commit" || name === "pull" || name === "push");
    expect(order[order.length - 1]).toBe("push");
  });

  test("報告に、合わせた件数が出る（作者の指摘「件数が出ない」）", async () => {
    await syncAllWorks({ registry, monitor, run: divergedRepo });

    expect(shown.join("\n")).toContain("別の環境の変更を 1か所で合わせました");
  });

  test("押す前の確認に、分かれていることが出る", async () => {
    await syncAllWorks({ registry, monitor, run: divergedRepo });

    const confirms = shown.filter((text) => text.includes("か所を同期します"));
    expect(confirms[0]).toContain("分かれています");
  });
});

/**
 * 遅れているだけの置き場を、記録より先に取り込む（設計書5.5.18）。
 *
 * **分岐は、遅れている側が先にコミットした瞬間に生まれる。** 21件遅れた
 * ままの置き場が「取り込む前の自動保存」を通り、「25件先・21件遅れ」に
 * なって抜けられなくなった（2026-09-11、作者のノートPC）。単独の「同期」
 * には入った直しを、「作品をすべて同期」でも同じ関数で入れる。
 */
describe("記録の前の早送り", () => {
  /** 2件遅れているが、こちらは先へ進んでいない置き場 */
  const behindOnlyRepo: GitCommandRunner = async (args, cwd, timeout) => {
    if (args[0] === "rev-list") {
      calls.push(args);
      return { code: 0, stdout: "2\t0", stderr: "" };
    }
    return busyRepo(args, cwd, timeout);
  };

  test("記録より先に、早送りで取り込む", async () => {
    await syncAllWorks({ registry, monitor, run: behindOnlyRepo });

    const order = calls
      .map((args) => args[0])
      .filter((name) => name === "commit" || name === "pull" || name === "push");
    // **取り込みが記録より前にある。** 逆だと、その1件で分岐が生まれる
    expect(order).toEqual(["pull", "commit", "push"]);
    // 書きかけを巻き込まないよう、退避つきの早送りで取り込む
    const pulls = calls.filter((args) => args[0] === "pull");
    expect(pulls).toHaveLength(1);
    expect(pulls[0]).toContain("--ff-only");
    expect(pulls[0]).toContain("--autostash");
  });

  test("報告に、先に取り込んだ置き場と件数が出る", async () => {
    await syncAllWorks({ registry, monitor, run: behindOnlyRepo });

    expect(shown.join("\n")).toContain("記録より先に、GitHubの分を取り込みました");
    expect(shown.join("\n")).toContain("（2件）");
  });

  test("分かれている置き場では、早送りを試さない（従来どおり記録から）", async () => {
    // busyRepo は 1件先・1件遅れ。早送りは必ず失敗するので、回線を使わない
    await syncAllWorks({ registry, monitor, run: busyRepo });

    const order = calls
      .map((args) => args[0])
      .filter((name) => name === "commit" || name === "pull" || name === "push");
    expect(order).toEqual(["commit", "pull", "push"]);
    expect(calls.some((args) => args.includes("--autostash"))).toBe(false);
  });
});

/**
 * 退避した書きかけを戻すときに食い違ったら、その置き場だけ止める。
 *
 * 取り込み自体は済んでおり、本文には競合マーカーが残っている。そのまま
 * 記録へ進むと `git add -A` がマーカーごと履歴へ入れてしまう
 * （CLAUDE.md「作者の原稿を壊さない」）。**他の置き場は続ける。**
 */
describe("早送りで書きかけと食い違ったとき", () => {
  const libraries: WorkEntry[] = [
    { id: "wa", title: "こじれた作品", folderPath: "C:/書庫A" },
    { id: "wb", title: "無事な作品", folderPath: "C:/書庫B" },
  ] as WorkEntry[];
  const twoRegistry = { list: () => libraries } as unknown as WorkRegistry;

  /** 書庫Aで退避の戻しが食い違ったあとか（gitがマージ未解決として残す） */
  let conflictedInA = false;

  const twoLibraries: GitCommandRunner = async (args, cwd) => {
    const inA = cwd.includes("書庫A");
    const root = inA ? "C:/書庫A" : "C:/書庫B";
    const joined = args.join(" ");
    calls.push([inA ? "A" : "B", ...args]);
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });

    if (args[0] === "--version") return ok("git version 2.55");
    if (joined === "rev-parse --is-inside-work-tree") return ok("true");
    if (joined === "rev-parse --show-toplevel") return ok(root);
    if (joined === "status --porcelain --untracked-files=all") {
      return ok(" M 本文/001.txt\n");
    }
    if (args[0] === "status") {
      return ok(inA && conflictedInA ? "UU 本文/001.txt\n" : "");
    }
    if (joined === "remote") return ok("origin");
    if (args[0] === "symbolic-ref") return ok("main");
    if (joined.startsWith("rev-parse --abbrev-ref")) return ok("origin/main");
    // どちらも2件遅れているだけ。早送りできる形
    if (args[0] === "rev-list") return ok("2\t0");
    if (args[0] === "config") return ok("作者");
    if (args[0] === "diff") return { code: 1, stdout: "", stderr: "" };
    if (args[0] === "pull") {
      if (!inA) return ok("");
      // 取り込めたが、退避した書きかけを戻すときに食い違った
      conflictedInA = true;
      return {
        code: 1,
        stdout: "",
        stderr: "could not restore untracked files from stash",
      };
    }
    return ok("");
  };

  beforeEach(() => {
    conflictedInA = false;
    Object.assign(window, {
      showWarningMessage: async (message: string, ...rest: unknown[]) => {
        const detail = rest.find(
          (item): item is { detail?: string } =>
            typeof item === "object" && item !== null && "detail" in item
        )?.detail;
        shown.push(detail ? `${message}\n${detail}` : message);
        return undefined;
      },
    });
  });

  test("食い違った置き場は、記録も送信もしない", async () => {
    await syncAllWorks({ registry: twoRegistry, monitor, run: twoLibraries });

    const inA = calls.filter((args) => args[0] === "A").map((args) => args[1]);
    expect(inA).not.toContain("commit");
    expect(inA).not.toContain("push");
  });

  test("他の置き場は続ける", async () => {
    await syncAllWorks({ registry: twoRegistry, monitor, run: twoLibraries });

    const inB = calls.filter((args) => args[0] === "B").map((args) => args[1]);
    expect(inB).toContain("commit");
    expect(inB).toContain("push");
  });

  test("報告に、止めた理由と退避の在り処が出る", async () => {
    await syncAllWorks({ registry: twoRegistry, monitor, run: twoLibraries });

    const text = shown.join("\n");
    expect(text).toContain("こじれた作品");
    expect(text).toContain("書きかけと同じ箇所が食い違ったので止めました");
    expect(text).toContain("退避（stash）に残っています");
  });
});
