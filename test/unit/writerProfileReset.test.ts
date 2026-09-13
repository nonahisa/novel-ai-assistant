import { describe, expect, test } from "vitest";
import type * as vscode from "vscode";
import {
  WriterProfileStore,
  WRITER_PROFILE_KEY,
  WRITER_WELCOME_KEY,
} from "../../src/core/writerProfileStore";
import { buildWriterStyle } from "../../src/core/writerStyle";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * **答えを消したら、はじめて使うときの状態に戻る**（設計書6.90.3）。
 *
 * 作者の報告（2026-09-13）：「テストのためタイプ診断をやり直したいのですが、
 * 方法がよくわかりません」。
 *
 * 答え直す道（5問を答え直す）はあったが、**はじめての声かけだけは
 * 二度と出せなかった**——答えを消しても、声かけの記憶が「済み」のまま
 * 残っていたためである。実機で初回の流れを確かめたい作者は、そこで詰まる。
 *
 * **答えを捨てたのなら、その人は「まだ診断していない人」である。**
 * 声かけを止めたい人は、声かけそのものの「出さない」を押せばよい——
 * そちらは別に残してある。
 */

function memento(): vscode.Memento {
  const box = new Map<string, unknown>();
  return {
    keys: () => [...box.keys()],
    get: <T>(key: string, fallback?: T) =>
      (box.has(key) ? box.get(key) : fallback) as T,
    update: async (key: string, value: unknown) => {
      if (value === undefined) box.delete(key);
      else box.set(key, value);
    },
  } as vscode.Memento;
}

const STYLE = buildWriterStyle({
  situation: "have_files",
  plan: "hybrid",
  revise: "per_episode",
  material: "memo",
  outlet: "serial",
});

describe("診断のやり直し", () => {
  test("**消すと、声かけの記憶も一緒に消える**", async () => {
    if (!STYLE) throw new Error("組み立てられない");
    const box = memento();
    const store = new WriterProfileStore(box);

    await store.set(STYLE);
    await store.setWelcomeState("done");
    expect(store.get()).toBeDefined();
    expect(store.welcomeState()).toBe("done");

    await store.clear();

    expect(store.get()).toBeUndefined();
    // **ここが肝心**——「済み」が残ると、二度と最初から試せない
    expect(store.welcomeState()).toBeUndefined();
    expect(box.keys()).not.toContain(WRITER_PROFILE_KEY);
    expect(box.keys()).not.toContain(WRITER_WELCOME_KEY);
  });

  test("答え直しでは、声かけの記憶を消さない", async () => {
    // 答え直したあとに声をかけ直されると、うるさいだけである
    if (!STYLE) throw new Error("組み立てられない");
    const store = new WriterProfileStore(memento());

    await store.setWelcomeState("done");
    await store.set(STYLE);

    expect(store.welcomeState()).toBe("done");
  });

  test("読み直すたびに、答えの形を見る", async () => {
    // 手で書き換えた値や、古い版の値をそのまま使わない
    const box = memento();
    await box.update(WRITER_PROFILE_KEY, {
      style: { situation: "むかしの値" },
      updatedAt: "2026-09-13T00:00:00.000Z",
    });

    expect(new WriterProfileStore(box).get()).toBeUndefined();
  });
});

/**
 * **押す前に、質問の数を約束しない**（作者の指摘、2026-09-13
 * 「それなら5問と書かないほうが良いかもしれませんね」）。
 *
 * 声かけは「5問」と言って押させていたが、そのあと9問を出す。
 * 途中でやめられるとはいえ、**押した時点の約束と違う**。
 *
 * 数を言ってよいのは、答え終わって区切りに来たとき（「ここまで5問」）である
 * ——そこは約束ではなく、事実の報告になる。
 */
describe("質問の数の言い方", () => {
  const source = readFileSync(
    resolve(__dirname, "../../src/features/writerDiagnosis.ts"),
    "utf8"
  );
  const menu = readFileSync(
    resolve(__dirname, "../../src/views/actionList.ts"),
    "utf8"
  );

  test("**押す前の文には、数を書かない**", () => {
    // 声かけのボタンと本文
    expect(source).toContain('const START = "診断する";');
    expect(source).toContain("はじめまして。いくつかお答えいただくと");
    // やり直しの札（続けて9問へ行けるので、ここでも約束しない）
    expect(source).not.toContain("5問を答え直す");
  });

  test("メニューの説明でも、数を約束しない", () => {
    const at = menu.indexOf('command: "novelai.runWriterDiagnosis"');
    expect(at).toBeGreaterThan(0);
    const entry = menu.slice(at, at + 500);
    expect(entry).toContain("いくつかお答えいただくと");
    expect(entry).not.toContain("5問お答え");
  });

  test("**区切りでは数を言ってよい**（そこは事実の報告である）", () => {
    // 5問答え終わった時点で「ここまで5問」と出し、残りが9問だと伝える
    expect(source).toContain("作家タイプ診断（ここまで5問）");
    expect(source).toContain(
      "const GO = `続けて答える（${ADVICE_QUESTIONS.length}問）`;"
    );
  });
});
