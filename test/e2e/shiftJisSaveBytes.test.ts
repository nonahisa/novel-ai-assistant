/**
 * Shift_JIS の原稿を作者が VS Code で打って保存したときの、ファイルのバイト（画面の自動テスト、
 * 設計書5.4.2・6.113。0.148.1。作者の決定 2026-11-08「〜などは黙って置き換える」・11-09「置き換え先の
 * 無い字は、どこにあるかを出して止める」。作者の打って保存する道も含む意図）。
 *
 * 見張ること：
 * 1. **作品一覧に登録していない原稿**（作品の外の Shift_JIS の .txt）に「〜」「♡」を打って保存すると、
 *    「～」（81 60）と「〓」（81 AC）で書かれ、置き換えたことが知らされる（0.152.10。それまでは製品の受け口が
 *    作品の外に効かず、素の VS Code が黙って「?」〈0x3f〉にしていた。2026-11-14 夕 Mac の実機確認で見つかった）
 * 2. 作品の話を素のエディターで開いて「〜」を打ち Ctrl+S → ファイルは「～」（81 60）で、0x3f が無い
 * 3. 原稿エディターで「〜」を打ち Ctrl+S → 同じく 81 60（原稿エディターの保存も同じ受け口を通る）
 * 4. 自動保存（`files.autoSave: afterDelay`）の原稿エディターで「〜」を打つ → 押さずに 81 60 になり、
 *    画面の本文も「～」に替わる
 * 5. 置き換え先の無い字「♡」を打って保存 → 保存は止められないので、保存の直前に目印の「〓」（81 AC）へ
 *    置き換えて書く（0.148.3。作者の答え 2026-11-09「目印に置き換えた上で、メモ校正パネルに説明を残して、
 *    ポップアップもあげてください」）。「?」にはならない。真ん中の窓で「♡」と場所が知らされ、校正・メモパネルの
 *    置き場（`.aiwriter/findings.jsonl`）に説明が、元の字を含む控え（UTF-8、BOM 付き）が `.novelai-recovery` に残る
 *
 * 文書を Shift_JIS で開くのは設定 `files.encoding: shiftjis`（使い捨ての settings.json）。
 * 落ちたときは読んだバイト列を16進で添える（離れた機械で落ちても原因が読めるように）。
 * **AI は呼ばない。**
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import iconv = require("iconv-lite");
import { expect, test } from "vitest";
import { composeText, openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import { withVsCode, type LaunchOptions } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { dialogText, focusTextEditor, quickOpen } from "./support/workbenchDom";
import { describeNotices, waitForNotice } from "./support/noticeRecord";
import { EDITOR_BOTTOM_PRESS } from "./support/keys";

const EPISODE = "001_駅.txt";
const BODY = "終電を逃した駅のホーム。\n雨の音だけが残っていた。\n";
const CONTROL = "対照.txt";

/** 「～」（全角チルダ）の Shift_JIS（CP932）のバイト */
const FULLWIDTH_TILDE = [0x81, 0x60];
const QUESTION = 0x3f;
/** 目印の「〓」（U+3013）の Shift_JIS（CP932）のバイト */
const GETA_MARK = [0x81, 0xac];

/** 作品の話も対照も、Shift_JIS のバイトで置き直す（見本はいったん UTF-8 で書かれる） */
function sjisLaunch(settings: Record<string, unknown> = {}): LaunchOptions {
  return {
    settings: { "files.encoding": "shiftjis", ...settings },
    prepareWork: async ({ workFolder, manuscriptFolder }) => {
      await writeFile(path.join(manuscriptFolder, EPISODE), iconv.encode(BODY, "shift_jis"));
      // 作品の外（書庫の直下）。開いているフォルダーの中なので Ctrl+P で開ける
      await writeFile(path.join(path.dirname(workFolder), CONTROL), iconv.encode(BODY, "shift_jis"));
    },
  };
}

const PLAIN_EDITOR = { "workbench.editorAssociations": { "*.txt": "default", "*.md": "default" } };

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

function includesSequence(bytes: Uint8Array, sequence: readonly number[]): boolean {
  outer: for (let at = 0; at + sequence.length <= bytes.length; at += 1) {
    for (let index = 0; index < sequence.length; index += 1) {
      if (bytes[at + index] !== sequence[index]) continue outer;
    }
    return true;
  }
  return false;
}

/** 元の本文より長くなる（＝保存が書いた）まで待って、そのバイトを返す */
async function waitForSavedBytes(file: string, label: string, done: (bytes: Uint8Array) => boolean): Promise<Uint8Array> {
  let last = new Uint8Array();
  try {
    await waitUntil(
      async () => {
        last = await readFile(file).catch(() => last);
        return done(last);
      },
      label,
      15_000
    );
  } catch (error) {
    throw new Error(`${String(error)}（いまのバイト：${hex(last)}）`);
  }
  return last;
}

const originalLength = iconv.encode(BODY, "shift_jis").length;

/** 素のエディターで末尾へ行って打ち、Ctrl+S */
async function typeAtEndAndSave(page: Parameters<typeof focusTextEditor>[0], text: string): Promise<void> {
  await focusTextEditor(page);
  await page.keyboard.press(EDITOR_BOTTOM_PRESS);
  await page.keyboard.insertText(text);
  await page.keyboard.press("ControlOrMeta+KeyS");
}

test("作品一覧に登録していない Shift_JIS の原稿でも、「〜」は「～」（81 60）、「♡」は「〓」（81 AC）で書かれ、置き換えたことが知らされる（0.152.10）", async () => {
  await withVsCode("Shift_JIS 登録していない原稿", [{ name: EPISODE, text: BODY }], async (session) => {
    const { page, workFolder } = session;
    const since = Date.now();
    await quickOpen(page, CONTROL);
    await typeAtEndAndSave(page, "〜♡");
    const bytes = await waitForSavedBytes(
      path.join(path.dirname(workFolder), CONTROL),
      "作品の外のファイルが保存される",
      (now) => now.length > originalLength
    );
    const tail = bytes.slice(originalLength);
    expect(Array.from(tail), `作品の外のファイルの末尾：${hex(tail)}（全体：${hex(bytes)}）`).toEqual([
      ...FULLWIDTH_TILDE,
      ...GETA_MARK,
    ]);
    // 「〜」を置き換えた知らせ（右下）
    await waitForNotice(
      session,
      (message) => message.includes("Shift_JIS に無い字を置き換えて保存しました") && message.includes(CONTROL),
      "置き換えたことの知らせが出る",
      { since }
    ).catch(async (error: unknown) => {
      throw new Error(`${String(error)}（${await describeNotices(session, since)}）`);
    });
    // 「♡」を〓にした窓：登録していないのでパネルには残していない、と書く
    let shown: string | undefined;
    await waitUntil(
      async () => {
        shown = await dialogText(page);
        return shown !== undefined && shown.includes("♡");
      },
      "〓にした字の窓が出る",
      15_000
    ).catch((error: unknown) => {
      throw new Error(`${String(error)}（いまの窓：${JSON.stringify(shown)}）`);
    });
    expect(shown).toContain("作品一覧に登録していないので、校正・メモパネルには場所を残していません");
  }, sjisLaunch(PLAIN_EDITOR));
});

test("作品の話を素のエディターで「〜」を打って保存すると、ファイルは「～」（81 60）になり、「?」にならない", async () => {
  await withVsCode("Shift_JIS 素のエディター", [{ name: EPISODE, text: BODY }], async (session) => {
    const { page, manuscriptFolder } = session;
    await quickOpen(page, EPISODE);
    await typeAtEndAndSave(page, "〜");
    const bytes = await waitForSavedBytes(
      path.join(manuscriptFolder, EPISODE),
      "素のエディターで打った字がファイルに入る",
      (now) => now.length > originalLength
    );
    expect(includesSequence(bytes, FULLWIDTH_TILDE), `ファイル：${hex(bytes)}`).toBe(true);
    expect(bytes.includes(QUESTION), `ファイル：${hex(bytes)}`).toBe(false);
  }, sjisLaunch(PLAIN_EDITOR));
});

test("原稿エディターで「〜」を打って Ctrl+S を押すと、ファイルは「～」（81 60）になる", async () => {
  await withVsCode("Shift_JIS 原稿エディター", [{ name: EPISODE, text: BODY }], async (session) => {
    const { page, manuscriptFolder } = session;
    const frame = await openEpisode(page, EPISODE, "雨の音");
    await placeCaretAfter(frame, "雨の音");
    await page.keyboard.insertText("〜");
    await waitUntil(async () => (await composeText(frame)).includes("雨の音〜"), "打った字が画面に出る");
    await page.keyboard.press("ControlOrMeta+KeyS");
    const bytes = await waitForSavedBytes(
      path.join(manuscriptFolder, EPISODE),
      "原稿エディターで打った字がファイルに入る",
      (now) => now.length > originalLength
    );
    expect(includesSequence(bytes, FULLWIDTH_TILDE), `ファイル：${hex(bytes)}`).toBe(true);
    expect(bytes.includes(QUESTION), `ファイル：${hex(bytes)}`).toBe(false);
    // 画面の本文も置き換わった字に揃う（保存の直前の書き換えが原稿エディターへ届く）
    await waitUntil(async () => (await composeText(frame)).includes("雨の音～"), "画面の本文が「～」に替わる");
  }, sjisLaunch());
});

test("自動保存の原稿エディターで「〜」を打つと、押さずに「～」（81 60）で保存され、画面の本文も替わる", async () => {
  await withVsCode("Shift_JIS 自動保存", [{ name: EPISODE, text: BODY }], async (session) => {
    const { page, manuscriptFolder } = session;
    const frame = await openEpisode(page, EPISODE, "雨の音");
    await placeCaretAfter(frame, "雨の音");
    await page.keyboard.insertText("〜");
    const bytes = await waitForSavedBytes(
      path.join(manuscriptFolder, EPISODE),
      "自動保存で打った字がファイルに入る",
      (now) => now.length > originalLength
    );
    expect(includesSequence(bytes, FULLWIDTH_TILDE), `ファイル：${hex(bytes)}`).toBe(true);
    expect(bytes.includes(QUESTION), `ファイル：${hex(bytes)}`).toBe(false);
    await waitUntil(async () => (await composeText(frame)).includes("雨の音～"), "画面の本文が「～」に替わる");
    // 続けて打った字が、置き換えのあとも続きに入る（カーソルが飛んでいない）
    await page.keyboard.insertText("が");
    await waitUntil(async () => (await composeText(frame)).includes("雨の音～が"), "続けて打った字が続きに入る").catch(
      async (error: unknown) => {
        throw new Error(`${String(error)}（画面の本文：${JSON.stringify(await composeText(frame))}）`);
      }
    );
  }, sjisLaunch({ "files.autoSave": "afterDelay", "files.autoSaveDelay": 500 }));
});

test("置き換え先の無い「♡」を打って保存すると、ファイルは「〓」（81 AC）になり、窓で知らされ、校正・メモパネルの置き場と控えが残る", async () => {
  await withVsCode("Shift_JIS 書けない字", [{ name: EPISODE, text: BODY }], async (session) => {
    const { page, manuscriptFolder, workFolder } = session;
    await quickOpen(page, EPISODE);
    await typeAtEndAndSave(page, "♡");
    // 保存は止められない（VS Code の決まり）。保存の直前に「〓」へ置き換えるので、「?」にはならない
    const bytes = await waitForSavedBytes(
      path.join(manuscriptFolder, EPISODE),
      "書けない字を含む保存が書かれる",
      (now) => now.length > originalLength
    );
    expect(includesSequence(bytes, GETA_MARK), `ファイル：${hex(bytes)}`).toBe(true);
    expect(bytes.includes(QUESTION), `ファイル：${hex(bytes)}`).toBe(false);

    let shown: string | undefined;
    await waitUntil(
      async () => {
        shown = await dialogText(page);
        return shown !== undefined && shown.includes("♡");
      },
      "「♡」を「〓」にしたことを知らせる窓が出る",
      15_000
    ).catch((error: unknown) => {
      throw new Error(`${String(error)}（いまの窓：${JSON.stringify(shown)}）`);
    });
    expect(shown).toContain("〓");
    expect(shown).toContain("校正・メモパネル");
    expect(shown).toContain("控え");

    // 校正・メモパネルの置き場（指摘の置き場。本文の外）に、〓の場所の説明が残る
    const findingsFile = path.join(workFolder, ".aiwriter", "findings.jsonl");
    let findings = "";
    await waitUntil(
      async () => {
        findings = await readFile(findingsFile, "utf8").catch(() => "");
        return findings.includes("Shift_JIS に無い字") && findings.includes("♡");
      },
      "校正・メモパネルの置き場に〓の説明が残る"
    ).catch((error: unknown) => {
      throw new Error(`${String(error)}（置き場：${JSON.stringify(findings)}）`);
    });

    // 控えの置き場は話の隣（`core/atomicWrite.ts` の recoveryDirectoryFor）
    const recoveryFolder = path.join(manuscriptFolder, ".novelai-recovery");
    const kept: string[] = [];
    await waitUntil(
      async () => {
        const names = await readdir(recoveryFolder, { recursive: true }).catch(() => [] as string[]);
        kept.length = 0;
        for (const name of names) {
          if (!String(name).endsWith(".bak")) continue;
          const raw = await readFile(path.join(recoveryFolder, String(name))).catch(() => undefined);
          if (raw && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) kept.push(new TextDecoder().decode(raw.slice(3)));
        }
        return kept.some((text) => text.includes("♡"));
      },
      "元の字を含む控え（UTF-8、BOM 付き）が残る"
    ).catch((error: unknown) => {
      throw new Error(`${String(error)}（控え：${JSON.stringify(kept)}）`);
    });
  }, sjisLaunch(PLAIN_EDITOR));
});
