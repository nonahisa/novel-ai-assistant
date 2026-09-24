import { afterEach, beforeEach, describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { chatPrompt, chatRun, episodeHintsOf } from "../../../src/mcp/tools/chat";
import { clearSamplingHost, setSamplingHost } from "../../../src/mcp/tools/sampling";
import { setExternalClientName } from "../../../src/mcp/tools/accessLog";

/**
 * MCP の相談を2往復にする（0.85.1、作者の承認 2026-09-24「4 を作る」）。
 *
 * 製品の相談パネルは、AIが `needFiles` を返すと作品フォルダーから読んで
 * **1回だけ**聞き直す（0.84.7 で、読めなかったときも候補を添えて聞き直す
 * ようにした）。MCP は1往復で止まっており、この聞き直しを外から測れなかった。
 *
 * **見張ること。**
 *
 * 1. 求められたファイルを読んで、2往復目に渡す（拡張子違いも製品と同じく引き当てる）
 * 2. 読めなかったら、見つからなかったことと候補を渡して聞き直す（黙って止まらない）
 * 3. **聞き直しは1回だけ**（2往復目でまた求められても読まない）
 * 4. 作品フォルダーの外・作業用フォルダーは読まない
 * 5. 返り値で、何を求められ・何を読み・何が無かったかが分かる
 *
 * AIには呼び出し元（sampling）を使う。作り物のクライアントが、問われた順に
 * 決まった答えを返す——ネットワークも Ollama も要らない。
 */

const TEST_CLIENT = "試験のクライアント";
const temporary: string[] = [];

/** 問われた順に答えを返す作り物のクライアント。問われた中身を控える */
function scriptedHost(replies: unknown[]) {
  const asked: Array<Record<string, unknown>> = [];
  return {
    asked,
    getClientCapabilities: () => ({ sampling: {} }),
    createMessage: async (params: Record<string, unknown>) => {
      asked.push(params);
      const reply = replies[Math.min(asked.length - 1, replies.length - 1)];
      return {
        model: `答えたモデル${asked.length}`,
        stopReason: "endTurn",
        role: "assistant",
        content: {
          type: "text",
          text: typeof reply === "string" ? reply : JSON.stringify(reply),
        },
      };
    },
  };
}

function useHost(host: ReturnType<typeof scriptedHost>): void {
  setSamplingHost(host as unknown as Parameters<typeof setSamplingHost>[0]);
}

/** 問われたユーザー側の文（1回ぶん） */
function userTextOf(params: Record<string, unknown>): string {
  return JSON.stringify(params.messages);
}

function answer(reply: string, needFiles: string[] = []): Record<string, unknown> {
  return {
    reply,
    options: [],
    needFiles,
    edit: null,
    run: null,
    locate: null,
    reloadRecord: null,
    profileSignals: null,
    writerStyleSignals: null,
  };
}

/** 考えさせることを許した作品を、一時に作る（既定は拒否なので、許可の印を置く） */
function work(): string {
  const folder = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-chat-followup-"));
  temporary.push(folder);
  fs.mkdirSync(nodePath.join(folder, ".aiwriter"), { recursive: true });
  fs.writeFileSync(
    nodePath.join(folder, ".aiwriter", "external-access.json"),
    JSON.stringify({
      clients: [
        {
          name: TEST_CLIENT,
          tools: ["*"],
          sampling: true,
          decidedAt: "2026-09-24T00:00:00.000Z",
          decidedOn: "テスト",
          note: "",
        },
      ],
    }),
    "utf8"
  );
  fs.mkdirSync(nodePath.join(folder, "本文"), { recursive: true });
  fs.writeFileSync(
    nodePath.join(folder, "本文", "episode_0001.md"),
    "灯台の下で、少年は古い地図を広げた。\n",
    "utf8"
  );
  fs.writeFileSync(
    nodePath.join(folder, "本文", "002_再会.txt"),
    "港の朝市で、二人はふたたび出会った。\n",
    "utf8"
  );
  fs.mkdirSync(nodePath.join(folder, "設定"), { recursive: true });
  fs.writeFileSync(
    nodePath.join(folder, "設定", "plot.md"),
    "# プロット\n\n港町の少年が海へ出る話。\n",
    "utf8"
  );
  return folder;
}

beforeEach(() => {
  setExternalClientName(TEST_CLIENT);
});

afterEach(() => {
  setExternalClientName("");
  clearSamplingHost();
  for (const folder of temporary.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

describe("相談の聞き直し（runner: sampling）", () => {
  test("求められたファイルを読んで、1回だけ聞き直す。拡張子違いは製品と同じく引き当てる", async () => {
    const folder = work();
    const host = scriptedHost([
      answer("第1話の本文を確かめたいです。", ["本文/episode_0001.txt"]),
      answer("書き出しの地図の場面が効いています。"),
    ]);
    useHost(host);

    const result = await chatRun({
      folder,
      question: "第1話の書き出しを講評してください",
      runner: "sampling",
    });

    expect(host.asked).toHaveLength(2);
    // 2往復目に、実物（.md）の中身が渡っている
    const second = userTextOf(host.asked[1]);
    expect(second).toContain("【あなたが求めたファイル】");
    expect(second).toContain("灯台の下で、少年は古い地図を広げた。");
    expect(userTextOf(host.asked[0])).not.toContain("【あなたが求めたファイル】");

    if (result.runner !== "sampling") throw new Error("sampling のはず");
    // 検算を通すのは最後の答え
    expect(result.result.answer.reply).toBe("書き出しの地図の場面が効いています。");
    expect(result.model).toBe("答えたモデル2");
    expect(result.followUp).toEqual({
      firstReply: "第1話の本文を確かめたいです。",
      requested: ["本文/episode_0001.txt"],
      needFiles: ["本文/episode_0001.txt"],
      readFiles: ["本文/episode_0001.md"],
      missingFiles: [],
      hints: [],
      askedAgain: [],
    });
  });

  test("読めなかったら、見つからなかったことと候補を渡して聞き直す（黙って止まらない）", async () => {
    const folder = work();
    const host = scriptedHost([
      answer("第2話を見たいです。", ["本文/episode_0002.txt"]),
      answer("渡された範囲では、第2話は 002_再会.txt のようです。"),
    ]);
    useHost(host);

    const result = await chatRun({ folder, question: "第2話はどうですか", runner: "sampling" });

    expect(host.asked).toHaveLength(2);
    const second = userTextOf(host.asked[1]);
    expect(second).toContain("【見つからなかったファイル】");
    expect(second).toContain("今回はファイルの中身を渡せません");
    // 候補は番号の合うものが先（製品と同じ `pickFileHints`）、表示名は製品と同じ付け方
    expect(second).toContain("本文/002_再会.txt（第2話 再会）");

    if (result.runner !== "sampling") throw new Error("sampling のはず");
    expect(result.followUp?.readFiles).toEqual([]);
    expect(result.followUp?.missingFiles).toEqual(["本文/episode_0002.txt"]);
    expect(result.followUp?.hints[0]).toEqual({
      path: "本文/002_再会.txt",
      label: "第2話 再会",
    });
  });

  test("ファイルを求められなければ1往復で終わり、followUp は null", async () => {
    const folder = work();
    const host = scriptedHost([answer("静かな書き出しだと思います。")]);
    useHost(host);

    const result = await chatRun({ folder, question: "どう思いますか", runner: "sampling" });

    expect(host.asked).toHaveLength(1);
    if (result.runner !== "sampling") throw new Error("sampling のはず");
    expect(result.followUp).toBeNull();
    expect(result.result.answer.reply).toBe("静かな書き出しだと思います。");
  });

  test("2往復目でまた求められても読まない（聞き直しは1回だけ）", async () => {
    const folder = work();
    const host = scriptedHost([
      answer("第1話を見たいです。", ["本文/episode_0001.md"]),
      answer("第2話も見たいです。", ["本文/002_再会.txt"]),
      answer("三度目は来ないはず"),
    ]);
    useHost(host);

    const result = await chatRun({ folder, question: "続きはどうですか", runner: "sampling" });

    expect(host.asked).toHaveLength(2);
    if (result.runner !== "sampling") throw new Error("sampling のはず");
    // 求め直したことは返す（材料が足りないまま書かれた答えだと分かるように）
    expect(result.followUp?.askedAgain).toEqual(["本文/002_再会.txt"]);
  });

  test("作品フォルダーの外・作業用フォルダーは読みに行かない", async () => {
    const folder = work();
    const host = scriptedHost([
      answer("見せてください。", ["../secret.txt", ".aiwriter/external-access.json", "C:/Windows/win.ini"]),
      answer("来ないはず"),
    ]);
    useHost(host);

    const result = await chatRun({ folder, question: "どうですか", runner: "sampling" });

    // 関門（`sanitizeRequestedPaths`）で全部落ちるので、聞き直さない（製品と同じ）
    expect(host.asked).toHaveLength(1);
    if (result.runner !== "sampling") throw new Error("sampling のはず");
    expect(result.followUp).toBeNull();
  });

  test("claude の道は変えない（プロンプトを返すだけで、往復しない）", async () => {
    const folder = work();
    const result = await chatRun({ folder, question: "どうですか", runner: "claude" });
    expect(result.runner).toBe("claude");
    expect("followUp" in result).toBe(false);
  });
});

describe("全体像（options.overview）", () => {
  test("既定では添えない（これまでどおり）", () => {
    const folder = work();
    const result = chatPrompt({ folder, question: "どうですか" });
    expect(result.overview).toBe(false);
    expect(result.userPrompt).not.toContain("【作品の全体像】");
  });

  test("true なら、製品と同じ組み方で話の一覧（各話の場所つき）とプロットを添える", () => {
    const folder = work();
    const result = chatPrompt({ folder, question: "どうですか", overview: true });
    expect(result.overview).toBe(true);
    expect(result.userPrompt).toContain("【作品の全体像】");
    expect(result.userPrompt).toContain("全2話。");
    expect(result.userPrompt).toContain("第2話 再会（本文/002_再会.txt）");
    expect(result.userPrompt).toContain("【プロット（plot.md）】");
    expect(result.userPrompt).toContain("港町の少年が海へ出る話。");
  });

  test("話の一覧は、製品と同じ関数で表示名を付ける", () => {
    const folder = work();
    expect(episodeHintsOf(folder)).toEqual([
      { path: "本文/002_再会.txt", label: "第2話 再会" },
      { path: "本文/episode_0001.md", label: "第1話" },
    ]);
  });
});
