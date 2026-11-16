/**
 * オリジナルIME との連動を端から端まで確かめる（2026-11-17。作者の頼み「朝までに IME と統合の連携ができるように」）。
 *
 * 1. 連動を入れた試し用の VS Code で作品の話を開くと、`%LOCALAPPDATA%\novel-ime\integration-current-work.json` が
 *    書かれる（作品の番号は試しの作品なので `test-` で始まる。設計書6.13.7）
 * 2. 原稿エディターの縦横を切り替えると、知らせの `vertical` が替わる
 * 3. 縦書きで `11gatu7ka`＋SPACE の候補の1番目が「十一月七日」、横書きで「11月7日」（IME の P-08。候補の並びは殻の合図から読む）
 *
 * **作者の置き場を書き替える試し**なので、前後は必ず `試しの前後.ps1` の -Before／-After を挟む（`runRealImeTest` が挟む）。
 * -After は知らせ・作品の一覧を試しの前の状態に戻し（無かったファイルは消す）、番号が `test-` で始まる作品の学習を消す。
 * そのため作品のフォルダー名を `test-` で始める（番号も `test-` で始まる）。
 *
 * **流すのは作者がこの PC を使っていないときだけ**。門は `NOVELAI_REAL_IME=1`。AI は呼ばない。
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame } from "playwright-core";
import { expect, test } from "vitest";
import {
  clickToolButton,
  openEpisode,
  placeCaretAfter,
} from "../support/manuscriptFrame";
import { waitUntil } from "../support/wait";
import {
  describeSignals,
  REAL_IME_ENABLED,
  runRealImeTest,
  type RealIme,
} from "./support/imeBridge";

const EPISODE = "001_連動.txt";
const MARKER = "その日は";
const BODY = `${MARKER}晴れていた。\n`;
const WORK_TITLE = "test-連動の作品";

interface CurrentWork {
  sender?: string;
  workUid?: string | null;
  workDir?: string;
  vertical?: boolean | null;
  at?: string;
}

const LINK_FILES = [
  "integration-current-work.json",
  "integration-works.json",
] as const;

function linkFile(name: (typeof LINK_FILES)[number]): string {
  return path.join(process.env.LOCALAPPDATA ?? "", "novel-ime", name);
}

function currentWorkFile(): string {
  return linkFile("integration-current-work.json");
}

/**
 * 知らせと作品の一覧を、試しの前の中身へ戻す（無かったものは消す）。**VS Code が閉じたあと**に呼ぶ。
 * `試しの前後.ps1 -After` は VS Code が開いているうちに走るので、そのあと拡張機能が書いた分（閉じるときの
 * 知らせなど）が残ることがある（2026-11-17 の1回目で integration-works.json が残った）
 */
async function snapshotLinkFiles(): Promise<() => Promise<void>> {
  const saved = new Map<string, string | undefined>();
  for (const name of LINK_FILES) {
    saved.set(
      name,
      await readFile(linkFile(name), "utf8").catch(() => undefined),
    );
  }
  return async () => {
    for (const name of LINK_FILES) {
      const text = saved.get(name);
      if (text === undefined) await rm(linkFile(name), { force: true });
      else await writeFile(linkFile(name), text, "utf8");
    }
  };
}

async function readCurrentWork(): Promise<CurrentWork | undefined> {
  try {
    return JSON.parse(await readFile(currentWorkFile(), "utf8")) as CurrentWork;
  } catch {
    return undefined;
  }
}

/** 拡張機能が書いた知らせ（試しの台本 -Before の test-realime ではない）で、向きが `vertical` になるまで待つ */
async function waitForNotice(
  vertical: boolean,
  what: string,
): Promise<CurrentWork> {
  let last: CurrentWork | undefined;
  await waitUntil(
    async () => {
      last = await readCurrentWork();
      return (
        last?.sender === "novel-ai-assistant" && last.vertical === vertical
      );
    },
    what,
    30_000,
  ).catch((error: unknown) => {
    throw new Error(
      `${String(error)}（最後に読んだ知らせ：${JSON.stringify(last)}）`,
    );
  });
  return last as CurrentWork;
}

/** 読みを打って SPACE で候補の窓を出し、1番目の候補を返す。確定せずに ESC で取り消す */
async function firstCandidate(
  frame: Frame,
  ime: RealIme,
): Promise<{ first: string | undefined; detail: string }> {
  await placeCaretAfter(frame, MARKER);
  const mark = await ime.mark();
  await ime.type(frame, [
    "romaji:11gatu7ka",
    "wait:400",
    "key:SPACE",
    "wait:1200",
  ]);
  const signals = await ime.signalsSince(mark);
  const window = signals.lastCandidates;
  // 確定させない（原稿を変えない）。変換を2回取り消す
  await ime.type(frame, ["key:ESCAPE", "wait:200", "key:ESCAPE", "wait:300"]);
  const list = window
    ? `並び ${JSON.stringify(window.list)}・選んでいる番目 ${window.selected}`
    : "候補の窓の並びが記録に無い";
  return {
    first: window?.list[0],
    detail: `${list}／${describeSignals(signals)}`,
  };
}

test.skipIf(!REAL_IME_ENABLED)(
  "本物の IME：連動を入れると作品の知らせが書かれ、縦横で vertical が替わり、縦書きでは日付を漢数字で先に出す",
  async (ctx) => {
    const restore = REAL_IME_ENABLED
      ? await snapshotLinkFiles()
      : async () => undefined;
    try {
      await runRealImeTest(
        ctx,
        "IME との連動 縦横",
        [{ name: EPISODE, text: BODY }],
        async (session, ime) => {
          const { page } = session;
          // 横書きの入口で開く（E2E の設定）
          const frame = await openEpisode(page, EPISODE, MARKER);

          // 1. 知らせが書かれる（横書き）
          const horizontal = await waitForNotice(
            false,
            "横書きで開くと、知らせが vertical: false で書かれる",
          );
          expect(
            horizontal.workUid ?? "",
            `試しの作品の番号は test- で始まる（${JSON.stringify(horizontal)}）`,
          ).toMatch(/^test-/);
          expect(
            path.basename(horizontal.workDir ?? ""),
            "知らせの作品は試しの作品",
          ).toBe(WORK_TITLE);

          // 2. 縦書きにすると vertical: true
          await clickToolButton(frame, "dir");
          await waitUntil(
            async () =>
              frame
                .evaluate(() => document.body.classList.contains("vertical"))
                .catch(() => false),
            "［縦書き］で縦書きの面になる",
          );
          await waitForNotice(
            true,
            "縦書きにすると、知らせの vertical が true に替わる",
          );
          await page.waitForTimeout(1_500);

          // 3. 縦書きでは漢数字が1番目
          const vertical = await firstCandidate(frame, ime);
          console.error(
            `[本物のIME] 縦書きの 11gatu7ka の1番目：${String(vertical.first)}（${vertical.detail}）`,
          );
          await ctx.annotate(
            `縦書き：${String(vertical.first)}`,
            "候補の1番目",
          );

          // 横書きへ戻すと vertical: false、算用数字が1番目
          await clickToolButton(frame, "dir");
          await waitUntil(
            async () =>
              frame
                .evaluate(() => !document.body.classList.contains("vertical"))
                .catch(() => false),
            "［横書き］で横書きの面になる",
          );
          await waitForNotice(
            false,
            "横書きへ戻すと、知らせの vertical が false に替わる",
          );
          await page.waitForTimeout(1_500);
          const horizontalPick = await firstCandidate(frame, ime);
          console.error(
            `[本物のIME] 横書きの 11gatu7ka の1番目：${String(horizontalPick.first)}（${horizontalPick.detail}）`,
          );
          await ctx.annotate(
            `横書き：${String(horizontalPick.first)}`,
            "候補の1番目",
          );

          expect(vertical.first, `縦書きの1番目（${vertical.detail}）`).toBe(
            "十一月七日",
          );
          expect(
            horizontalPick.first,
            `横書きの1番目（${horizontalPick.detail}）`,
          ).toBe("11月7日");
        },
        {
          workTitle: WORK_TITLE,
          // E2E の利用者設定は連動を切っている。この試しだけ入れる
          settings: { "novelai.ime.notifyCurrentWork": true },
        },
      );
    } finally {
      await restore();
    }
  },
);
