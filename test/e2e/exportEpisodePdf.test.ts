/**
 * 原稿エディターの［出力］→「PDF（この話）」（0.150.0。設計書6.25.13・6.113。実機確認リスト 0.150.0 の項目）。
 *
 * 見張ること：
 * 1. 押すと**紙を訊かずに**、開いている話だけの印刷用 HTML が `.aiwriter/exports/` に
 *    「印刷用_〈話のファイル名〉 日付 時刻.html」で出来る（ほかの話の本文は入らない）
 * 2. 知らせに紙の名前（記録が無ければ「文庫サイズ・縦書き」）が出る
 * 3. 合本（1ファイルに複数話）ではカーソルのある話だけが出る（名前は「印刷用_〈話のファイル名〉_〈何話目〉 …」）
 * 4. 開く先（外のブラウザ）へ渡そうとしたこと
 *
 * ## 作者の本物のブラウザは開かせない
 *
 * 製品は `core/openExternalFile.ts` で、拡張機能ホストから `cmd /c start`（Mac は `open`）を起こす。
 * **起こす VS Code の PATH を空のフォルダーにする**（`LaunchOptions.env`）と、`spawn("cmd")` は
 * ENOENT になり、製品は `vscode.env.openExternal` へ落ちる。そちらは本体側の `shell.openExternal`
 * （と念のため `shell.openPath`）を、開く先を控えるだけの関数に替えて止める（`postingKitSteps` と同じ道）。
 * **押す前の安全弁**：テストの側で、同じ作りの環境（PATH が空のフォルダー）では `cmd` が ENOENT になる
 * ことを確かめる。ENOENT にならなければ、押さずに落とす（本物のブラウザが開くため）。
 * 製品にテスト専用の口は足していない。
 *
 * **見ていないこと**：ブラウザでの見た目・印刷（PDF にする所）。「開いた」のは、開く先へ渡したことまで
 * （「ブラウザを開けませんでした」ではなく「ブラウザで開きました」の知らせが出ること）。
 * 「OS の `start` で本当に開くこと」は見ていない（開かせないため）。**AI は呼ばない。**
 */
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  clickToolButton,
  openEpisode,
  placeCaretAfter,
} from "./support/manuscriptFrame";
import { waitForNotice } from "./support/noticeRecord";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";

const SEP = (n: number) =>
  `------------------------- エピソード${n}開始 -------------------------`;

const PLAIN = [
  {
    name: "001_駅.txt",
    text: "　終電を逃した駅のホームに、雨の音だけが残っていた。\n",
  },
  { name: "002_灯台.txt", text: "　彼は灯台を見上げて、静かに息を吐いた。\n" },
];

/** 合本（1ファイルに2話） */
const COLLECTED = [
  SEP(1),
  "【エピソードタイトル】",
  "1話　潮の匂い",
  "",
  "【本文】",
  "　潮の匂いのする朝だった。",
  "",
  SEP(2),
  "【エピソードタイトル】",
  "2話　古い地図",
  "",
  "【本文】",
  "　古い地図を机に広げた。",
  "",
].join("\n");

/** 「cmd」（Mac は open）が PATH の空のフォルダーでは見つからないことを、押す前に確かめる安全弁 */
async function assertOpenCommandCannotRun(
  env: Record<string, string>,
  cwd: string,
): Promise<void> {
  const file =
    process.platform === "win32"
      ? "cmd"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "echo", "x"] : [];
  const outcome = await new Promise<string>((resolve) => {
    try {
      const child = spawn(file, args, {
        env,
        cwd,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", (error) =>
        resolve((error as NodeJS.ErrnoException).code ?? String(error)),
      );
      child.once("exit", (code) => resolve(`起動できた（終了 ${code}）`));
    } catch (error) {
      resolve((error as NodeJS.ErrnoException).code ?? String(error));
    }
  });
  expect(
    outcome,
    `PATH を空にしても「${file}」が起こせます。本物のブラウザが開くので、押さずに止めます`,
  ).toBe("ENOENT");
}

/** 空のフォルダーを PATH にした環境（製品が子へ渡す環境と同じ形：親の環境から PATH だけ替える） */
async function emptyPathEnv(): Promise<{
  env: Record<string, string>;
  full: Record<string, string>;
  empty: string;
}> {
  const empty = await mkdtemp(path.join(os.tmpdir(), "imp11-emptypath-"));
  const env = { PATH: empty };
  const full: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value === undefined ||
      name.toLowerCase() === "path" ||
      name === "ELECTRON_RUN_AS_NODE"
    )
      continue;
    full[name] = value;
  }
  full[process.platform === "win32" ? "Path" : "PATH"] = empty;
  return { env, full, empty };
}

/** 本体側の `shell.openExternal`・`shell.openPath` を、開く先を控えるだけの関数に替える */
async function blockBrowser(session: E2ESession): Promise<void> {
  await session.app.evaluate(({ shell }) => {
    const target = globalThis as unknown as { __e2eOpened?: string[] };
    target.__e2eOpened = [];
    const patched = shell as unknown as {
      openExternal: (url: string) => Promise<void>;
      openPath: (file: string) => Promise<string>;
    };
    patched.openExternal = async (url: string) => {
      target.__e2eOpened?.push(url);
    };
    patched.openPath = async (file: string) => {
      target.__e2eOpened?.push(file);
      return "";
    };
  });
}

async function openedTargets(session: E2ESession): Promise<string[]> {
  return session.app.evaluate(
    () =>
      (globalThis as unknown as { __e2eOpened?: string[] }).__e2eOpened ?? [],
  );
}

/** `.aiwriter/exports/` の「印刷用_」で始まる HTML（書き込み途中の一時ファイルは数えない） */
async function printFiles(session: E2ESession): Promise<string[]> {
  const folder = path.join(session.workFolder, ".aiwriter", "exports");
  const names = await readdir(folder).catch(() => [] as string[]);
  return names
    .filter(
      (name) =>
        name.startsWith("印刷用_") &&
        name.endsWith(".html") &&
        !/\.novelai-[^/\\]*\.tmp$/.test(name),
    )
    .sort();
}

/** HTML の字だけ（タグを外す。1字ずつ別の要素に分けて組む形でも読めるよう、空白も落とす） */
async function visibleText(session: E2ESession, name: string): Promise<string> {
  const html = await readFile(
    path.join(session.workFolder, ".aiwriter", "exports", name),
    "utf8",
  );
  return html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, "");
}

async function pressPdf(
  session: E2ESession,
  frame: Parameters<typeof clickToolButton>[0],
): Promise<void> {
  await clickToolButton(frame, "exportPagePdf");
}

test("［出力］→「PDF（この話）」は、紙を訊かずに開いている話だけの印刷用 HTML を作り、知らせに紙の名前を出して、開く先へ渡す。合本ではカーソルのある話だけ", async () => {
  const { env, full, empty } = await emptyPathEnv();
  try {
    await withVsCode(
      "PDF（この話）",
      [...PLAIN, { name: "003_合本.txt", text: COLLECTED }],
      async (session) => {
        const { page } = session;
        // 押す前の安全弁（落ちたら本物のブラウザが開く形なので、押さない）
        await assertOpenCommandCannotRun(full, session.workFolder);
        await assertOpenCommandCannotRun(
          full,
          path.dirname(
            await session.app.evaluate(({ app }) => app.getPath("exe")),
          ),
        );
        await blockBrowser(session);

        /* ── 1話だけのファイル ── */
        const frame = await openEpisode(page, "002_灯台.txt", "灯台を見上げて");
        const since = Date.now();
        await pressPdf(session, frame);
        const notice = await waitForNotice(
          session,
          (message) =>
            message.includes("ブラウザで開きました") ||
            message.includes("ブラウザを開けませんでした"),
          "印刷用 HTML を開いた知らせ",
          { since },
        );
        expect(notice, "開く先へ渡せたこと").toContain("ブラウザで開きました");
        expect(notice).toContain("紙は");
        expect(notice, "記録が無いときの紙は文庫サイズ・縦書き").toContain(
          "文庫",
        );
        expect(notice).toContain("縦書き");
        // 紙を訊く窓は出ていない
        expect(
          await page.locator(".monaco-dialog-box").count(),
          "紙を訊く窓が出ました",
        ).toBe(0);

        await waitUntil(
          async () => (await printFiles(session)).length === 1,
          "印刷用 HTML が1つ出来る",
          15_000,
        ).catch(async (error: unknown) => {
          throw new Error(
            `${String(error)}（exports：${JSON.stringify(await printFiles(session))}）`,
          );
        });
        const [first] = await printFiles(session);
        expect(
          first,
          "名前は「印刷用_〈話のファイル名〉 日付 時刻.html」",
        ).toMatch(/^印刷用_002_灯台 \S+.*\.html$/);
        const text = await visibleText(session, first);
        expect(text, "開いている話の本文が入る").toContain("灯台を見上げて");
        expect(text, "ほかの話は入らない").not.toContain("終電を逃した");
        expect(text).not.toContain("潮の匂い");
        const opened = await openedTargets(session);
        expect(
          opened.length,
          `開く先へ渡した数（${JSON.stringify(opened)}）`,
        ).toBe(1);
        expect(decodeURIComponent(opened[0])).toContain("印刷用_002_灯台");

        /* ── 合本：カーソルのある話だけ ── */
        const collected = await openEpisode(page, "003_合本.txt", "潮の匂い");
        await placeCaretAfter(collected, "古い地図を机に広げた。");
        const sinceCollected = Date.now();
        await pressPdf(session, collected);
        await waitUntil(
          async () => (await printFiles(session)).length === 2,
          "合本から印刷用 HTML がもう1つ出来る",
          15_000,
        ).catch(async (error: unknown) => {
          throw new Error(
            `${String(error)}（exports：${JSON.stringify(await printFiles(session))}）`,
          );
        });
        const names = await printFiles(session);
        const second = names.find((name) =>
          name.startsWith("印刷用_003_合本_"),
        );
        expect(second, `合本の名前（${JSON.stringify(names)}）`).toBeDefined();
        expect(second).toMatch(/^印刷用_003_合本_2 /);
        const collectedText = await visibleText(session, second as string);
        expect(collectedText, "カーソルのある2話目が入る").toContain(
          "古い地図を机に広げた",
        );
        expect(collectedText, "1話目は入らない").not.toContain(
          "潮の匂いのする朝",
        );
        await waitForNotice(
          session,
          (message) => message.includes("ブラウザで開きました"),
          "合本の知らせ",
          { since: sinceCollected },
        );
        expect(
          (await openedTargets(session)).length,
          "合本でも開く先へ渡したのは1回ずつ",
        ).toBe(2);
      },
      { env },
    );
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
}, 240_000);
