/**
 * 作品一覧が書庫ごとに分かれて出る（画面の自動テスト、設計書6.97.7・6.113）。
 *
 * 見張ること：
 * - 書庫が2つ（作品を2つずつ並べたフォルダーが2つ）と、1作品だけで置いた作品があるとき、書庫の段が
 *   2つ出て、単独の作品は書庫の段の後ろに、いまと同じ形（段の外）で並ぶ
 * - 書庫が1つしかないときは、書庫の段が出ない（初めての人に「書庫」を見せない）
 *
 * 作品は登録のキー（`novelai.addWork`）で足す。登録簿の外の見分けは `.git` の有無と
 * 「1つ上のフォルダーに作品が2つ以上」だけなので、git は使わない。
 *
 * **書くだけで走らせていない**（作者が母艦を使っているあいだは回さない決まり）。
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { SIDEBAR_LAUNCH, scrollTreeUntilRow, treeRowLabels, waitTreeSettled } from "./support/sidebar";
import { E2E_WORK_TITLE, withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { pressWorkbenchKey } from "./support/workbenchDom";

const SHOW_SIDEBAR_PRESS = "Control+Alt+Shift+KeyJ";

/** 足す作品。`parent` は作品の1つ上のフォルダー名（一時フォルダーの根から見て） */
interface ExtraWork {
  title: string;
  /** 書庫の名前（1つ上のフォルダー）。`"@main"` は起こした作品と同じ書庫 */
  parent: string;
  key: string;
  press: string;
}

const EPISODE = "001_はじまり.txt";

const TWO_LIBRARIES: ExtraWork[] = [
  { title: "Same隣", parent: "@main", key: "ctrl+alt+shift+b", press: "Control+Alt+Shift+KeyB" },
  { title: "Zeta1", parent: "Z書庫", key: "ctrl+alt+shift+c", press: "Control+Alt+Shift+KeyC" },
  { title: "Zeta2", parent: "Z書庫", key: "ctrl+alt+shift+d", press: "Control+Alt+Shift+KeyD" },
  { title: "Solo作品", parent: "単独の置き場", key: "ctrl+alt+shift+e", press: "Control+Alt+Shift+KeyE" },
];

const ONE_LIBRARY: ExtraWork[] = [
  { title: "Same隣", parent: "@main", key: "ctrl+alt+shift+b", press: "Control+Alt+Shift+KeyB" },
  { title: "Solo作品", parent: "単独の置き場", key: "ctrl+alt+shift+e", press: "Control+Alt+Shift+KeyE" },
];

function folderOf(workFolder: string, extra: ExtraWork): string {
  const library = path.dirname(workFolder);
  const parent = extra.parent === "@main" ? library : path.join(path.dirname(library), extra.parent);
  return path.join(parent, extra.title);
}

function launchFor(extras: readonly ExtraWork[]): LaunchOptions {
  const bindings: Record<string, unknown>[] = extras.map((extra) => ({
    key: extra.key,
    command: "novelai.addWork",
    args: { folderPath: "", title: extra.title },
  }));
  return {
    settings: { ...SIDEBAR_LAUNCH.settings },
    keybindings: [...SIDEBAR_LAUNCH.keybindings, ...bindings],
    prepareWork: async ({ workFolder }) => {
      for (const [index, extra] of extras.entries()) {
        const folder = folderOf(workFolder, extra);
        await mkdir(path.join(folder, "本文"), { recursive: true });
        await writeFile(path.join(folder, "本文", EPISODE), "　本文。\n", "utf8");
        // keybindings.json はこの準備のあとに書かれるので、場所はここで引数へ入れる
        bindings[index].args = { folderPath: folder, title: extra.title };
      }
    },
  };
}

/** 作品を登録する（作品の印ができるまで押し直す。同じ場所の二重の登録は製品が断る） */
async function register(session: E2ESession, extra: ExtraWork): Promise<void> {
  const config = path.join(folderOf(session.workFolder, extra), ".aiwriter", "config.json");
  const until = Date.now() + 60_000;
  for (;;) {
    await pressWorkbenchKey(session.page, extra.press);
    const done = await waitUntil(() => existsSync(config), `${config} ができる`, 5_000)
      .then(() => true)
      .catch(() => false);
    if (done) return;
    if (Date.now() > until) throw new Error(`「${extra.title}」を登録できません`);
  }
}

async function openList(session: E2ESession, extras: readonly ExtraWork[]): Promise<string[]> {
  const { page } = session;
  await pressWorkbenchKey(page, SHOW_SIDEBAR_PRESS);
  for (const extra of extras) await register(session, extra);
  await waitTreeSettled(page);
  return treeRowLabels(page);
}

/** 行の名前の並びの中での位置（題で始まる行。見つからなければ -1） */
function indexOfHead(labels: readonly string[], head: string): number {
  return labels.findIndex((label) => label.startsWith(head));
}

/**
 * 書庫の段（名前だけの行）の位置。**段の行の名前は後ろに空白が付く**（説明の欄が空のため。
 * 2026-10-19 に母艦で「書庫  」と読めた）ので、空白を落として比べる
 */
function indexOfLibrary(labels: readonly string[], name: string): number {
  return labels.findIndex((label) => label.trim() === name);
}

test("書庫が2つと単独の作品があると、書庫の段が2つ出て、単独の作品は段の後ろに並ぶ", async () => {
  await withVsCode(
    "書庫の段が2つ",
    [{ name: EPISODE, text: "　本文。\n" }],
    async (session) => {
      const labels = await openList(session, TWO_LIBRARIES);
      const mainLibrary = path.basename(path.dirname(session.workFolder));
      // 書庫の段（名前だけの行）
      const mainIndex = indexOfLibrary(labels, mainLibrary);
      const zIndex = indexOfLibrary(labels, "Z書庫");
      expect(mainIndex, `書庫「${mainLibrary}」の段（行：${labels.join(" / ")}）`).toBeGreaterThanOrEqual(0);
      expect(zIndex, `書庫「Z書庫」の段（行：${labels.join(" / ")}）`).toBeGreaterThanOrEqual(0);
      // 書庫の中の作品は、その書庫の段の後ろ
      expect(indexOfHead(labels, E2E_WORK_TITLE)).toBeGreaterThan(mainIndex);
      expect(indexOfHead(labels, "Zeta1")).toBeGreaterThan(zIndex);
      /*
        単独の作品は、最後の書庫の中の作品よりも後ろ。**木は見えている行しか描かない**ので、
        枠の下にある単独の作品は、作品一覧を下へ送ってから読む（2026-10-19、母艦の既定の窓で
        Solo作品の行が描かれず落ちた）
      */
      const lastLibraryWork = mainIndex > zIndex ? E2E_WORK_TITLE : "Zeta2";
      await scrollTreeUntilRow(session.page, lastLibraryWork, "Solo作品");
      const below = await treeRowLabels(session.page);
      const soloIndex = indexOfHead(below, "Solo作品");
      expect(soloIndex, `単独の作品の行（行：${below.join(" / ")}）`).toBeGreaterThan(indexOfHead(below, lastLibraryWork));
      expect(indexOfHead(below, lastLibraryWork), `最後の書庫の作品の行（行：${below.join(" / ")}）`).toBeGreaterThanOrEqual(0);
    },
    launchFor(TWO_LIBRARIES)
  );
});

test("書庫が1つしかないときは、書庫の段が出ない", async () => {
  await withVsCode(
    "書庫の段は出ない",
    [{ name: EPISODE, text: "　本文。\n" }],
    async (session) => {
      const labels = await openList(session, ONE_LIBRARY);
      const mainLibrary = path.basename(path.dirname(session.workFolder));
      expect(indexOfLibrary(labels, mainLibrary), `書庫の段が出ていないこと（行：${labels.join(" / ")}）`).toBe(-1);
      expect(indexOfHead(labels, E2E_WORK_TITLE)).toBeGreaterThanOrEqual(0);
      expect(indexOfHead(labels, "Same隣")).toBeGreaterThanOrEqual(0);
      expect(indexOfHead(labels, "Solo作品")).toBeGreaterThanOrEqual(0);
    },
    launchFor(ONE_LIBRARY)
  );
});
