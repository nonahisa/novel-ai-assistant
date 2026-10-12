/**
 * プロットモードで選んだ名前の「名前を直す案」と、plot.md の保存からの反映（画面の自動テスト、設計書6.4.8・
 * 6.4.9・6.113。実機確認リスト 545・561 行を、仕分け 2026-10-12 の束 E11 として移した。作者の裁定
 * 「仕分けて機械の分から減らす」）。
 *
 * 見本：資料に役名のままの人物「主人公」がいる作品。プロットモードの「名前の候補を出す」で主人公に
 * 「相馬 誠」を選んで［入れる］と、plot.md は「主人公（相馬 誠）」になり、承認待ちに「主人公」の
 * 名前を直す案が1件置かれる（ここまでは 2026-10-10 に写真で確かめ済み）。
 *
 * 1. 545：その案を「見送る」で片付けたあと、plot.md を書き換えて保存しても、同じ案は並び直さない。
 *    **知らせに「相馬 誠は、…前に置いたため、置き直していません」が添えられる。**
 *    添えられるのは、その保存で**ほかに積むものがあるときだけ**（`features/plotCharacterSync.ts` の
 *    `announce`。積むものが無ければ黙る作り）。2026-10-10 の写真で知らせが写っていなかったのは、
 *    書き換えたのが「あらすじ」の行だけで、主要登場人物の欄が前回と同じ（＝反映を見送る）だったため。
 *    そこで2段にする：①主要登場人物の欄（班長の説明）を書き換えて保存 → 知らせに添えられ、相馬 誠の案は
 *    戻らない ②続けて「あらすじ」だけ書き換えて保存 → 何も積まれず、相馬 誠の案は戻らない
 * 2. 561：見送らずに「主人公（相馬 誠）」の行の説明を書き換えて保存すると、直す案の説明が新しい文になり、
 *    理由（「プロットモードで選んだ名前に直します…」）と読みが残る。承認すると資料に「相馬 誠」が
 *    1人だけでき、「主人公」は残らない
 *
 * 知らせは右下ですぐ畳まれるので、**知らせの記録ファイル**（`support/noticeRecord.ts`）で読む。
 * 承認待ちは `.aiwriter/pending-characters/` のファイルで見る。**本物の AI は呼ばない**（偽の Ollama）。
 */
import { afterAll, beforeAll, expect, test } from "vitest";
import { fakeOllamaLaunch, startFakeOllama, type FakeOllama } from "./support/fakeOllama";
import { waitForNotice } from "./support/noticeRecord";
import {
  characterNames,
  EXISTING_PERSON,
  isPlotNamesRequest,
  LEDGER_ROLE,
  openPlotMode,
  openUpdates,
  pendingCharacterFiles,
  pendingFilesMentioning,
  plotNamesAnswer,
  preparePlotWork,
  readPlot,
  rewritePlotAndSave,
  startNameSuggest,
  waitNameResults,
} from "./support/plotNames";
import { SIDEBAR_LAUNCH } from "./support/sidebar";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { clearNotifications } from "./support/workbenchDom";

const RENAMED = "相馬 誠";

let fake: FakeOllama;
beforeAll(async () => {
  fake = await startFakeOllama((request) => (isPlotNamesRequest(request) ? plotNamesAnswer(request) : "{}"));
});
afterAll(async () => {
  await fake.close();
});

function launchOptions() {
  return fakeOllamaLaunch(fake, {
    ...SIDEBAR_LAUNCH,
    settings: {
      ...SIDEBAR_LAUNCH.settings,
      // plot.md は作者の既定どおり素のテキストエディターで開く（6.4.8）
      "workbench.editorAssociations": { "*.txt": "novelai.manuscriptEditorHorizontal", "*.md": "default" },
    },
    prepareWork: async ({ workFolder }) => preparePlotWork(workFolder, [EXISTING_PERSON, LEDGER_ROLE]),
  });
}

async function describePending(session: E2ESession): Promise<string> {
  const files = await pendingCharacterFiles(session);
  return `承認待ち：${JSON.stringify([...files].map(([name, body]) => `${name}=${body.replace(/\s+/g, " ").slice(0, 160)}`))}`;
}

/** プロットモードで主人公に「相馬 誠」を選んで［入れる］まで。直す案が承認待ちに置かれたところで戻る */
async function renameProtagonist(session: E2ESession): Promise<void> {
  const plot = await openPlotMode(session);
  /*
    **この件で増えた頼みだけを見る。** 偽の AI はファイルの中の件で共有なので（`beforeAll`）、前の件の名前の
    候補の頼みが `fake.requests` に残っている。素の `fake.requests.some(...)` では2件目は押した直後に
    「届いた」と見なして戻り、人物を選ぶ画面を通さないまま候補を60秒待って落ちた（2026-10-12 ノートPC、
    名前の欄も一文も空）
  */
  const sentBefore = fake.requests.length;
  await startNameSuggest(session, plot, () => fake.requests.slice(sentBefore).some(isPlotNamesRequest));
  await waitNameResults(plot, session.page);
  // 主人公（name-1）の候補の1つ目＝相馬 誠（0番目は「選ばない」）
  const pick = plot.locator('input[name="name-1"]').nth(1);
  expect(await pick.evaluate((input) => (input.parentElement?.textContent ?? "").trim()), "主人公の候補の1つ目が相馬 誠ではありません").toContain(RENAMED);
  await pick.check();
  await plot.locator("[data-apply-names]").click();
  await waitUntil(async () => (await readPlot(session)).includes(`- 主人公（${RENAMED}）：`), "plot.md の主人公の行が「主人公（相馬 誠）」になる", 20_000).catch(
    async (error: unknown) => {
      throw new Error(`${String(error)}（plot.md：${JSON.stringify(await readPlot(session))}）`);
    }
  );
  await waitUntil(async () => (await pendingFilesMentioning(session, RENAMED)).length === 1, "承認待ちに、主人公の名前を直す案が1件置かれる", 20_000).catch(
    async (error: unknown) => {
      throw new Error(`${String(error)}（${await describePending(session)}）`);
    }
  );
}

test("名前を直す案を見送ったあと、主要登場人物の欄を書き換えて保存すると、案は並び直さず「…置き直していません」が知らせに添えられ、あらすじだけの保存でも戻らない", async () => {
  await withVsCode(
    "見送った直す案は置き直さない",
    [{ name: "第1話_はじまり.txt", text: "一話の本文。\n" }],
    async (session) => {
      const { page } = session;
      await renameProtagonist(session);

      /* ── 「設定資料更新分反映」で、相馬 誠の案を見送る ── */
      const updates = await openUpdates(session, RENAMED);
      const card = updates.locator(".issue", { hasText: RENAMED }).first();
      await card.locator('button[data-action="dismiss"]').click();
      await waitUntil(async () => (await pendingFilesMentioning(session, RENAMED)).length === 0, "見送った案が承認待ちから片付く", 20_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（${await describePending(session)}）`);
        }
      );

      /* ── ① 主要登場人物の欄（班長の説明）を書き換えて保存 ── */
      await clearNotifications(page);
      const savedAt = Date.now();
      const base = await readPlot(session);
      await rewritePlotAndSave(session, base.replace("港の見回りをまとめる年配の男。", "港の見回りをまとめる年配の男。口数が少ない。"));
      const notice = await waitForNotice(session, (message) => message.includes("プロットから人物"), "保存のあと、プロットから人物の案を積んだ知らせが出る", {
        since: savedAt,
      });
      expect(notice, `知らせに「置き直していません」が添えられていません：${notice}`).toContain(
        `${RENAMED}は、役名「主人公」の人物の名前を直す案を前に置いたため、置き直していません`
      );
      // 見送った案は戻らない（少し遅れて積まれるものも見逃さないよう、しばらく見続ける）
      await holdsFor(async () => (await pendingFilesMentioning(session, RENAMED)).length === 0, "①の保存のあと、相馬 誠の案が承認待ちに戻らない", 3_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（${await describePending(session)}）`);
        }
      );

      /* ── ② あらすじだけ書き換えて保存（主要登場人物の欄は前回と同じ） ── */
      const pendingBefore = [...(await pendingCharacterFiles(session)).keys()].sort();
      const afterFirst = await readPlot(session);
      await rewritePlotAndSave(session, afterFirst.replace("港の仕事を教わる", "港の仕事を一から教わる"));
      await holdsFor(
        async () =>
          (await pendingFilesMentioning(session, RENAMED)).length === 0 &&
          JSON.stringify([...(await pendingCharacterFiles(session)).keys()].sort()) === JSON.stringify(pendingBefore),
        "②の保存のあと、承認待ちが増えず、相馬 誠の案も戻らない",
        3_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（前の承認待ち：${JSON.stringify(pendingBefore)}／${await describePending(session)}）`);
      });
      // 資料の「主人公」は見送ったので変わっていない
      expect(await characterNames(session)).toEqual(["主人公", "白瀬 灯"].sort());
    },
    launchOptions()
  );
});

test("名前を直す案が承認待ちのうちに「主人公（相馬 誠）」の行の説明を書き換えて保存すると、案の説明が新しくなり理由と読みが残り、承認すると資料に相馬 誠が1人だけできる", async () => {
  await withVsCode(
    "直す案の説明の書き換えと承認",
    [{ name: "第1話_はじまり.txt", text: "一話の本文。\n" }],
    async (session) => {
      const { page } = session;
      await renameProtagonist(session);

      /* ── 主人公（相馬 誠）の行の説明を書き換えて保存 ── */
      const NEW_SUMMARY = "17歳の高校生。船乗りの家に生まれ、船に憧れている。";
      await clearNotifications(page);
      const before = await readPlot(session);
      await rewritePlotAndSave(session, before.replace("17歳の高校生。港町で育ち、船に憧れている。", NEW_SUMMARY));
      const renameBody = async () => {
        const files = await pendingCharacterFiles(session);
        return (await pendingFilesMentioning(session, RENAMED)).map((name) => files.get(name) ?? "");
      };
      await waitUntil(async () => (await renameBody()).some((body) => body.includes("船乗りの家に生まれ")), "直す案の説明が新しい文になる", 20_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（${await describePending(session)}）`);
        }
      );
      // 同じ人の新規の案が別に増えていない（相馬 誠の案は1件のまま）
      const bodies = await renameBody();
      expect(bodies.length, `相馬 誠の案が1件ではありません：${await describePending(session)}`).toBe(1);
      expect(bodies[0], "直す案の理由（プロットモードで選んだ名前に直します）が消えました").toContain("プロットモードで選んだ名前に直します");
      expect(bodies[0], "直す案の読みが消えました").toContain("そうま まこと");

      /* ── 承認する → 資料に相馬 誠が1人だけ、「主人公」は残らない ── */
      const updates = await openUpdates(session, RENAMED);
      const card = updates.locator(".issue", { hasText: RENAMED }).first();
      const cardText = (await card.innerText()).replace(/\s+/g, " ");
      expect(cardText, `更新分反映の案に新しい説明が出ていません：${cardText}`).toContain("船乗りの家に生まれ");
      await card.locator('button[data-action="apply"]').click();
      await waitUntil(async () => (await characterNames(session)).includes(RENAMED), "承認で資料に相馬 誠ができる", 20_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（資料の人物：${JSON.stringify(await characterNames(session))}／${await describePending(session)}）`);
      });
      const names = await characterNames(session);
      expect(names.filter((name) => name === RENAMED).length, `資料に相馬 誠が1人ではありません：${JSON.stringify(names)}`).toBe(1);
      expect(names, `資料に「主人公」が残っています：${JSON.stringify(names)}`).not.toContain("主人公");
      expect(names, "資料にいた白瀬 灯が消えました").toContain("白瀬 灯");
    },
    launchOptions()
  );
});
