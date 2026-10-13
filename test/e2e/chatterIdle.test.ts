/**
 * 独り言（画面の自動テスト、設計書6.21・6.21.4・6.113。仕分け 2026-10-12 の束 E20 として、
 * 実機確認リスト F-81 の「相談パネルを開いたまま…本文を保存し、AI処理を何も走らせずに手を止めて
 * 1〜2分待つと、相談パネルに感想の一言が出ることがあるか（60字以内・1文か）」〔6842 行前後〕を移した。2026-10-13）。
 *
 * 何を見張るか：
 * 1. 相談パネル（横）を開いたまま、偽の Ollama（無料の手元AI）を割り当てた状態で本文を2回保存し
 *    （1回目はその日の起点を置くだけ）、手を止めて待つと、**約80秒以内に相談パネルへ独り言が出る**。
 *    出るのは「AI（独り言）」の札の付いた1件で、文は誤字脱字の申し出、ボタンは［この話の誤字脱字を検知する］。
 *    **この一言は AI を呼ばない**（偽の AI への頼みが増えない）
 * 2. **相談パネルを閉じたまま**同じように保存して待っても、約85秒のあいだ何も起きない（AI も呼ばない）。
 *    そのあとでパネルを開くと、次の様子見（60秒以内）で独り言が出る——止めていたのは「パネルが見えていること」の関門だけ
 * 3. （長い件。既定では走らせない）申し出から10分空けたあと、**偽の AI の感想（60字以内の1文）**が相談パネルに出る
 *
 * ## 待ち時間（製品に縮める口は無い）
 *
 * 様子見の間隔（`features/chatterService.ts` の `TICK_MS` 60秒）・手の止まりの閾値（`core/chatter.ts` の
 * `IDLE_THRESHOLD_MS` 20秒）・前の一言から次までの間合い（`QUIET_GAP_MS` 10分）は、どれも定数で、
 * 設定にも環境変数にも出ていない（2026-10-13 に確かめた。設定は `novelai.chatter.enabled` だけ）。
 * 製品にテスト専用の口は足さない決まりなので、**実時間で待つ**。様子見は起動の時から60秒ごとに
 * 刻まれるので、保存から「20秒の手の止まりを越えた最初の様子見」までは最長80秒。
 *
 * ## 項目の前提とのずれ（2026-10-13、この件を書いていて分かった）
 *
 * **感想（AI の一言）は、1〜2分では出ない。** 候補の並び（`core/chatter.ts` の `candidates`）で感想は最後に
 * 置かれ、条件（保存した本文があり、その日に書いている）は誤字脱字の申し出と同じなので、新しい起動の
 * 初回の様子見では**必ず申し出が先に出る**（単体 `chatter.test.ts`「ほかに言うことが無いときだけ取りに行く」）。
 * 申し出を言った時点で `lastSpokeAt` が進み、感想を取りに行けるのは `QUIET_GAP_MS`（10分）が過ぎた次の
 * 様子見から——保存からおよそ11〜12分後になる。1・2 は「独り言そのものが相談パネルに出るまで」の配線と関門を、
 * 3 が感想の段を見る。3 は14分ほどかかるので、`NOVELAI_E2E_LONG=1` のときだけ走らせる。
 *
 * **本物の AI は呼ばない。** 偽の Ollama（`support/fakeOllama.ts`）が決まった感想を返す。答えは
 * 本物の検算（`parseChatterComment` → `validateChatterComment`）に通るものを `support/chatterFixture.ts` に置いた。
 * 答えの出来（感想・応援になっているか）は見えない——それは実機の AI での測定（2026-09-25 の24回）の側。
 */
import type { Frame, Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  CHATTER_COMMENT,
  CHATTER_COMMENT_ANSWER,
  CHATTER_EPISODE,
  CHATTER_EPISODE_TEXT,
  CHATTER_TYPED,
  IDLE_TYPOS_BUTTON,
  IDLE_TYPOS_TEXT,
  isChatterCommentRequest,
} from "./support/chatterFixture";
import { describeFakeRequests, fakeOllamaLaunch, passLocalAiGate, startFakeOllama, type FakeOllama } from "./support/fakeOllama";
import { footText, openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import { describeNotices } from "./support/noticeRecord";
import { withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { dialogText, pressWorkbenchKey } from "./support/workbenchDom";

const OPEN_SIDE_KEY = "ctrl+alt+shift+c";
const OPEN_SIDE_PRESS = "Control+Alt+Shift+KeyC";

/** 独り言の札（`features/workChatPanel.ts` の `postChatter` が付ける発言者の名前） */
const CHATTER_WHO = "AI（独り言）";

/**
 * 保存から、独り言が相談パネルに出るまでに待つ上限。
 * 手の止まり20秒＋様子見の間隔60秒＝最長80秒に、拡張機能ホストの遅れの余裕を足す
 */
const FIRST_CHATTER_WAIT_MS = 100_000;
/** パネルを閉じたまま「出ない」を見続ける長さ。最長80秒の様子見を必ず1回は含む */
const CLOSED_HOLD_MS = 85_000;
/** パネルを開いてから、次の様子見（60秒以内）で出るまでに待つ上限 */
const AFTER_OPEN_WAIT_MS = 70_000;

let fake: FakeOllama;
beforeAll(async () => {
  // 感想の頼みにだけ感想を返す。それ以外の頼みが来たら（来ないはずだが）空の JSON で黙らせる
  fake = await startFakeOllama((request) => (isChatterCommentRequest(request) ? CHATTER_COMMENT_ANSWER : "{}"));
});
afterAll(async () => {
  await fake.close();
});

function launch(): LaunchOptions {
  return fakeOllamaLaunch(fake, {
    keybindings: [{ key: OPEN_SIDE_KEY, command: "novelai.openChat" }],
  });
}

/** 横の相談パネルの面（`#context-what` と `#to-main` を持つ）。開いていなければ undefined */
async function sideChatFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const isSide = await frame
      .evaluate(() => document.getElementById("context-what") !== null && document.getElementById("to-main") !== null)
      .catch(() => false);
    if (isSide) return frame;
  }
  return undefined;
}

interface ChatterTurn {
  who: string;
  body: string;
  buttons: string[];
}

/** 会話の欄に出ている独り言（`.turn.chatter`）。発言者・本文・ボタン */
async function chatterTurns(frame: Frame): Promise<ChatterTurn[]> {
  return frame
    .evaluate(() =>
      Array.from(document.querySelectorAll("#log .turn.chatter")).map((turn) => ({
        who: turn.querySelector(".who")?.textContent ?? "",
        body: turn.querySelector(".body")?.textContent ?? "",
        buttons: Array.from(turn.querySelectorAll("button")).map((button) => button.textContent ?? ""),
      }))
    )
    .catch(() => [] as ChatterTurn[]);
}

/**
 * 落ちたときに添える様子（独り言・会話の欄・確認の窓・知らせ・偽の AI への頼み）。
 * **部品が1つ読めなくても投げない**——投げると、本来の「何を待って時間切れか」の文ごと消える
 */
async function situation(session: E2ESession, frame: Frame | undefined, sentBefore: number): Promise<string> {
  const unreadable = (error: unknown): string => `読めない（${String(error)}）`;
  const turns = frame ? JSON.stringify(await chatterTurns(frame)) : "（相談パネルの面が無い）";
  const log = frame
    ? await frame
        .evaluate(() => document.getElementById("log")?.innerText ?? "")
        .then((text) => JSON.stringify(text))
        .catch(unreadable)
    : "";
  const dialog = await dialogText(session.page)
    .then((text) => JSON.stringify(text))
    .catch(unreadable);
  const notices = await describeNotices(session).catch(unreadable);
  return [`独り言：${turns}`, `会話の欄：${log}`, `確認の窓：${dialog}`, notices, describeFakeRequests(fake.requests, sentBefore)].join("／");
}

/** 話を開く（相談パネルより先に開く。パネルを開いたあとの焦点の取り合いを避ける） */
async function openSample(page: Page): Promise<Frame> {
  return openEpisode(page, CHATTER_EPISODE, "朝の駅は静かだった");
}

/**
 * 開いてある話へ打ち足して、2回保存する。1回目はその日の起点を置くだけ（統計の作り）、2回目で「今日 +N字」になる。
 * 2回目の記録が下段に届いたこと（＝保存の道が `recordWritingProgress` → 独り言の `noteEdit` まで通った）を確かめる。
 * 原稿の面を押してから打つので、相談パネルに焦点があっても原稿へ戻る
 */
async function writeAndSave(page: Page, frame: Frame): Promise<void> {
  await placeCaretAfter(frame, "線路の先をじっと見つめた。");
  await page.keyboard.insertText("。");
  await page.keyboard.press("Control+KeyS");
  await waitUntil(async () => (await footText(frame, "note")).includes("保存しました"), "起点を置く保存が通る", 15_000);
  await page.keyboard.insertText(CHATTER_TYPED);
  await page.keyboard.press("Control+KeyS");
  await waitUntil(async () => /この話で今日 \+\d+字/.test(await footText(frame, "counts")), "2回目の保存で下段が「この話で今日 +N字」になる", 30_000).catch(
    async (error: unknown) => {
      throw new Error(`${String(error)}（いまの下段：「${await footText(frame, "counts")}」／知らせ：${await footText(frame, "note")}）`);
    }
  );
}

/** 独り言が1件以上出るまで待つ（手元のAIの関所が出たら通す） */
async function waitForChatter(session: E2ESession, frame: Frame, label: string, timeoutMs: number, sentBefore: number, match: (turn: ChatterTurn) => boolean): Promise<ChatterTurn[]> {
  await waitUntil(
    async () => {
      await passLocalAiGate(session.page);
      return (await chatterTurns(frame)).some(match);
    },
    label,
    timeoutMs
  ).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（${await situation(session, frame, sentBefore)}）`);
  });
  return chatterTurns(frame);
}

test("相談パネルを開いたまま本文を保存して手を止めると、約80秒以内に独り言（誤字脱字の申し出）が相談パネルに出て、AI は呼ばない", async () => {
  await withVsCode(
    "独り言・パネルを開いたまま",
    [{ name: CHATTER_EPISODE, text: CHATTER_EPISODE_TEXT }],
    async (session) => {
      const { page } = session;
      const sentBefore = fake.requests.length;
      const manuscript = await openSample(page);

      // 相談パネル（横）を開く。最後まで開いたまま（関門「パネルが見えていること」）
      await pressWorkbenchKey(page, OPEN_SIDE_PRESS);
      await waitUntil(async () => (await sideChatFrame(page)) !== undefined, "横の相談パネルが開く", 30_000);
      const chat = await sideChatFrame(page);
      if (!chat) throw new Error("横の相談パネルの面が見つかりません");
      expect(await chatterTurns(chat), "保存する前から独り言が出ています").toEqual([]);

      await writeAndSave(page, manuscript);

      // 手を止めて待つ（何も押さない）
      const turns = await waitForChatter(session, chat, "相談パネルに独り言が出る", FIRST_CHATTER_WAIT_MS, sentBefore, () => true);
      const situationText = await situation(session, chat, sentBefore);
      expect(turns.length, `独り言が1件ではありません（${situationText}）`).toBe(1);
      const [first] = turns;
      expect(first.who, situationText).toBe(CHATTER_WHO);
      expect(first.body, `最初の独り言が誤字脱字の申し出ではありません（${situationText}）`).toBe(IDLE_TYPOS_TEXT);
      expect(first.buttons, situationText).toEqual([`▶${IDLE_TYPOS_BUTTON}`]);
      // 申し出は記録と件数から決まる発言で、AI を呼ばない
      expect(fake.requests.length - sentBefore, `独り言のために AI が呼ばれました（${situationText}）`).toBe(0);
    },
    launch()
  );
});

test("相談パネルを閉じたまま待っても独り言は出ず AI も呼ばれない。パネルを開くと次の様子見で出る", async () => {
  await withVsCode(
    "独り言・パネルを閉じたまま",
    [{ name: CHATTER_EPISODE, text: CHATTER_EPISODE_TEXT }],
    async (session) => {
      const { page } = session;
      const sentBefore = fake.requests.length;

      expect(await sideChatFrame(page), "起動した時点で相談パネルが開いています（閉じたままの前提が崩れた）").toBeUndefined();
      await writeAndSave(page, await openSample(page));

      // 閉じたまま、最長80秒の様子見を必ず1回は含む長さだけ見続ける。パネルは勝手に開かず、AI も呼ばない
      await holdsFor(
        async () => (await sideChatFrame(page)) === undefined && fake.requests.length === sentBefore,
        "相談パネルを閉じたまま、独り言のためにパネルが開いたり AI が呼ばれたりしない",
        CLOSED_HOLD_MS
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（${await situation(session, await sideChatFrame(page), sentBefore)}）`);
      });

      // パネルを開く
      await pressWorkbenchKey(page, OPEN_SIDE_PRESS);
      await waitUntil(async () => (await sideChatFrame(page)) !== undefined, "横の相談パネルが開く", 30_000);
      const chat = await sideChatFrame(page);
      if (!chat) throw new Error("横の相談パネルの面が見つかりません");
      /*
        開いた直後に「まだ0件」は確かめない。開いた瞬間と様子見が重なると1件見えることがあり、揺れの元になる。
        閉じている間に申し出を「言ったこと」にしていた（鍵や間合いを消費していた）なら、開いたあと10分は
        何も出ないので、下の「70秒以内に申し出が1件出る」で十分に分かる
      */

      // 開いたあとの次の様子見で出る（止めていたのは「パネルが見えていること」の関門だけ）
      const turns = await waitForChatter(session, chat, "パネルを開いたあとの様子見で独り言が出る", AFTER_OPEN_WAIT_MS, sentBefore, () => true);
      const situationText = await situation(session, chat, sentBefore);
      expect(turns.map((turn) => turn.body), situationText).toEqual([IDLE_TYPOS_TEXT]);
      expect(fake.requests.length - sentBefore, `独り言のために AI が呼ばれました（${situationText}）`).toBe(0);
    },
    launch()
  );
});

/**
 * 長い件：感想（AI の一言）まで待つ。申し出のあと `QUIET_GAP_MS`（10分）が過ぎた次の様子見で取りに行く。
 * 保存から最長でおよそ 80秒＋10分＋60秒。既定の時間切れ（240秒）に収まらないので、
 * `NOVELAI_E2E_LONG=1` のときだけ走らせ、この件だけ時間切れを15分にする
 */
const LONG = process.env.NOVELAI_E2E_LONG === "1";
const COMMENT_WAIT_MS = 12 * 60_000;

test.runIf(LONG)(
  "（長い件）申し出から10分空けると、偽の AI の感想が60字以内の1文で相談パネルに出て、AI への頼みは感想の1件だけ",
  async () => {
    await withVsCode(
      "独り言・感想まで待つ",
      [{ name: CHATTER_EPISODE, text: CHATTER_EPISODE_TEXT }],
      async (session) => {
        const { page } = session;
        const sentBefore = fake.requests.length;
        const manuscript = await openSample(page);

        await pressWorkbenchKey(page, OPEN_SIDE_PRESS);
        await waitUntil(async () => (await sideChatFrame(page)) !== undefined, "横の相談パネルが開く", 30_000);
        const chat = await sideChatFrame(page);
        if (!chat) throw new Error("横の相談パネルの面が見つかりません");
        await writeAndSave(page, manuscript);

        await waitForChatter(session, chat, "まず誤字脱字の申し出が出る", FIRST_CHATTER_WAIT_MS, sentBefore, (turn) => turn.body === IDLE_TYPOS_TEXT);
        const turns = await waitForChatter(session, chat, "申し出から10分空けたあと、感想が出る", COMMENT_WAIT_MS, sentBefore, (turn) => turn.body === CHATTER_COMMENT);
        const situationText = await situation(session, chat, sentBefore);

        expect(turns.map((turn) => turn.body), situationText).toEqual([IDLE_TYPOS_TEXT, CHATTER_COMMENT]);
        const comment = turns[1];
        expect(comment.who, situationText).toBe(CHATTER_WHO);
        // 60字以内・1文（文の終わりが1つだけ）
        expect([...comment.body].length, situationText).toBeLessThanOrEqual(60);
        expect(comment.body.match(/[。！？]/g)?.length ?? 0, situationText).toBe(1);
        // 感想にはボタンが付かない
        expect(comment.buttons, situationText).toEqual([]);
        // AI への頼みは感想の1件だけ（申し出は AI を呼ばない）
        const sent = fake.requests.slice(sentBefore);
        expect(sent.length, situationText).toBe(1);
        expect(isChatterCommentRequest(sent[0]), situationText).toBe(true);
        expect(sent[0].structured, `感想の頼みに構造化出力が付いていません（${situationText}）`).toBe(true);
      },
      launch()
    );
  },
  15 * 60_000
);
