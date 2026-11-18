/**
 * 原稿エディターの既定の書体（ゴシック・行間1.8）と、［表示］→［書体］での切り替えを
 * 本物の VS Code で確かめる（設計書6.25.3。作者の決定 2026-11-18「なろうに寄せる」。1.0.29）。
 *
 * 実機確認リスト「1.0.29 原稿エディターの既定の書体をゴシックに」の〔Win〕の項目の写し。
 * 見張ること：
 *  1. 書体を選んでいない（設定が空）ときの打つ面は、Windows はメイリオ・Mac はヒラギノ角ゴで
 *     始まり、行の高さが字の大きさの1.8倍
 *  2. 書体に「游ゴシック」を選ぶと、開き直さずに Yu Gothic で始まり、行の高さが1.9倍
 *  3. 「既定（ゴシックを自動で選ぶ）」を選び直すと、開き直さずに 1 へ戻る
 *  4. 用語の色の層（#marks）は、どの状態でも打つ面（#write）と同じ書体・同じ行の高さ
 *     （ずれると用語の色の字が本文の字に重ならない）
 *
 * **見た目の良し悪し（読みやすさ・「――」の繋がり）は見ない。** それは作者の目で（実機確認リスト）。
 * 設定は使い捨ての利用者データの中だけに入り、作者の設定には触らない。
 */
import type { Frame } from "playwright-core";
import { expect, test } from "vitest";
import { clickToolButton, openEpisode } from "./support/manuscriptFrame";
import { pickQuickPickRow, quickPickRows, quickPickTitle } from "./support/workbenchDom";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";

const EPISODE = "001_はじまり.txt";

interface Look {
  /** 引用符を外し、小文字にした font-family の並び */
  family: string;
  /** 行の高さ ÷ 字の大きさ */
  ratio: number;
}

/** 打つ面と用語の色の層の、計算された書体と行の高さ */
async function looks(frame: Frame): Promise<{ write: Look; marks: Look }> {
  return frame.evaluate(() => {
    const read = (id: string) => {
      const element = document.getElementById(id);
      if (!element) throw new Error(`#${id} がありません`);
      const style = getComputedStyle(element);
      return {
        family: style.fontFamily.replace(/["']/g, "").toLowerCase(),
        ratio: parseFloat(style.lineHeight) / parseFloat(style.fontSize),
      };
    };
    return { write: read("write"), marks: read("marks") };
  });
}

/** 先頭の書体の名前（並びの最初） */
function firstFamily(look: Look): string {
  return look.family.split(",")[0].trim();
}

/** 既定の先頭：Windows はメイリオ、Mac はヒラギノ角ゴ（どちらも許す） */
function isDefaultFirst(name: string): boolean {
  return name === "meiryo" || name === "メイリオ" || name.startsWith("hiragino kaku gothic");
}

/** ［表示］→［書体］を押し、選ぶ画面で `label` の行を選ぶ */
async function chooseFont(session: E2ESession, frame: Frame, label: string): Promise<void> {
  await clickToolButton(frame, "font");
  await waitUntil(
    async () => ((await quickPickTitle(session.page)) ?? "").startsWith("原稿の書体"),
    "選ぶ画面「原稿の書体」が出る"
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（いまの題：${String(await quickPickTitle(session.page))}）`);
  });
  await waitUntil(
    async () => (await quickPickRows(session.page)).some((row) => row.label.includes(label)),
    `選ぶ画面に「${label}」の行が出る`
  );
  await pickQuickPickRow(session.page, label);
}

test("書体を選んでいない原稿は既定のゴシック（Windows はメイリオ・Mac はヒラギノ角ゴ）で行の高さ1.8倍、［書体］で游ゴシックを選ぶと開き直さずに1.9倍、既定へ戻すと1.8倍へ戻り、用語の色の層はいつも同じ", async () => {
  await withVsCode("既定の書体", [{ name: EPISODE, text: "既定の書体を確かめる行。\n" }], async (session) => {
    const frame = await openEpisode(session.page, EPISODE, "既定の書体");
    const report = async (stage: string) => `（${stage}：${JSON.stringify(await looks(frame))}）`;

    // 1. 設定が空のまま開いた
    await waitUntil(async () => isDefaultFirst(firstFamily((await looks(frame)).write)), "既定の書体が既定のゴシック（メイリオかヒラギノ角ゴ）で始まる").catch(
      async (error: unknown) => {
        throw new Error(`${String(error)}${await report("開いた直後")}`);
      }
    );
    let now = await looks(frame);
    expect(now.write.ratio, `既定の行の高さが1.8倍でありません${await report("開いた直後")}`).toBeCloseTo(1.8, 2);
    expect(now.marks, "開いた直後、用語の色の層が打つ面と違います").toEqual(now.write);

    // 2. 游ゴシックを選ぶ（開き直さない）
    await chooseFont(session, frame, "游ゴシック");
    await waitUntil(async () => firstFamily((await looks(frame)).write) === "yu gothic", "游ゴシックを選ぶと Yu Gothic で始まる").catch(
      async (error: unknown) => {
        throw new Error(`${String(error)}${await report("游ゴシックを選んだあと")}`);
      }
    );
    now = await looks(frame);
    expect(now.write.ratio, `選んだ書体の行の高さが1.9倍でありません${await report("游ゴシック")}`).toBeCloseTo(1.9, 2);
    expect(now.marks, "游ゴシックのとき、用語の色の層が打つ面と違います").toEqual(now.write);

    // 3. 既定へ戻す（開き直さない）
    await chooseFont(session, frame, "既定（ゴシックを自動で選ぶ）");
    await waitUntil(async () => isDefaultFirst(firstFamily((await looks(frame)).write)), "既定へ戻すと既定のゴシック（メイリオかヒラギノ角ゴ）で始まる").catch(
      async (error: unknown) => {
        throw new Error(`${String(error)}${await report("既定へ戻したあと")}`);
      }
    );
    now = await looks(frame);
    expect(now.write.ratio, `既定へ戻した行の高さが1.8倍でありません${await report("既定へ戻したあと")}`).toBeCloseTo(1.8, 2);
    expect(now.marks, "既定へ戻したあと、用語の色の層が打つ面と違います").toEqual(now.write);
  });
});
