/**
 * 設定資料パネルの人物の「関係」欄と、人物相関図の読み直し（画面の自動テスト、設計書6.5・6.38・6.113）。
 *
 * 実機確認リスト 0.82.4〜0.83.13 の節の項目を機械へ移したもの（2026-10-04）：
 * - 人物に「関係」欄が出て、「相手=関係」の形（ターナ=母）で書き直して保存できる
 * - 退けた関係が関係欄の下に「相手=関係（日付に外部AIの提案を承認して退けました）」と出て、
 *   「退けた記録から外す」を押すと一覧から消える（記録だけ外れ、関係は戻らない）
 * - 人物相関図を開いたまま関係を直すと、図が読み直されて古い関係のまま残らない
 *   （設定資料パネルの保存でも、外からのファイルの書き換え＝承認待ちの反映でも）
 *
 * 退けた関係は、外部AIの提案を承認した結果と同じ形（`via: "external"`）の記録を置いて見る
 * （提案→承認で記録が残る道は単体テスト `core/rejectedRelations.test.ts` が見ている）。
 * 人物の記録は製品が読む形で置く。**AI は呼ばない。**
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame } from "playwright-core";
import { expect, test } from "vitest";
import { characterFileName, emptyCharacter, type Character } from "../../src/models/character";
import { runCommand } from "./support/quickInput";
import { defaultCharactersFolder, settingsFolder, settingsPanelFrame, writeCharactersTo } from "./support/settingsFixture";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";

const EPISODE = { name: "001_はじまり.txt", text: "リナはターナと話した。\n" };

/** リナ（母＝ターナ。退けた関係が1件）とターナ */
function cast(): Character[] {
  return [
    {
      ...emptyCharacter("char_001", "リナ"),
      appearedChapters: [1],
      relations: [{ name: "ターナ", relation: "母" }],
      rejectedRelations: [
        { target: "シーゲン", relation: "婚約者", rejectedAt: "2026-10-01T00:00:00.000Z", via: "external" },
      ],
    },
    { ...emptyCharacter("char_002", "ターナ"), appearedChapters: [1] },
  ];
}

const LAUNCH = {
  prepareWork: async ({ workFolder }: { workFolder: string }) => {
    await writeCharactersTo(defaultCharactersFolder(workFolder), cast());
  },
};

async function openSettingsPanel(session: E2ESession): Promise<Frame> {
  await runCommand(session.page, "設定資料集閲覧");
  let panel: Frame | undefined;
  await waitUntil(async () => (panel = await settingsPanelFrame(session)) !== undefined, "設定資料パネルが開く", 30_000);
  if (!panel) throw new Error("設定資料パネルの面が見つかりません");
  const frame = panel;
  await waitUntil(async () => (await frame.locator("#list .item", { hasText: "リナ" }).count()) > 0, "人物の一覧にリナが出る", 20_000);
  return frame;
}

/** 左の一覧でリナを選び、右の詳細の「関係」欄（textarea）を返す */
async function selectRina(frame: Frame) {
  await frame.locator("#list .item", { hasText: "リナ" }).first().click();
  const field = frame.locator("#detail .field", { hasText: "関係（1行に1つ" });
  await field.first().waitFor({ timeout: 15_000 });
  return field.first().locator("textarea");
}

async function readRina(session: E2ESession): Promise<Character> {
  const rina = cast()[0];
  const file = path.join(defaultCharactersFolder(session.workFolder), characterFileName(rina));
  // 保存の置き換えの瞬間（書き換え中のファイルが一瞬見えない）を読んでしまったら、少し待って読み直す
  for (let attempt = 0; ; attempt++) {
    try {
      return JSON.parse(await readFile(file, "utf8")) as Character;
    } catch (error) {
      if (attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

test("関係欄に「ターナ=母」が出て、書き直して保存でき、退けた関係が出て、「退けた記録から外す」で消える（関係は戻らない）", async () => {
  await withVsCode(
    "設定資料の関係欄",
    [EPISODE],
    async (session) => {
      const frame = await openSettingsPanel(session);
      const relations = await selectRina(frame);
      expect(await relations.inputValue(), "関係欄").toBe("ターナ=母");

      // 退けた関係が、関係欄の下に「相手=関係（日付に…退けました）」で並ぶ
      const rejected = frame.locator("#detail .rejected-relations .row .sub");
      expect(await rejected.allInnerTexts()).toEqual(["シーゲン=婚約者（2026-10-01に外部AIの提案を承認して退けました）"]);

      // 「相手=関係」の形で書き直して保存する（行を足す）
      await relations.fill("ターナ=母\nシエナ=友人");
      await frame.locator("#detail .saverow button.action", { hasText: "保存" }).click();
      await waitUntil(
        async () => (await readRina(session)).relations.some((entry) => entry.name === "シエナ" && entry.relation === "友人"),
        "書き直した関係がファイルに入る",
        20_000
      );
      const saved = await readRina(session);
      expect(saved.relations.map((entry) => `${entry.name}=${entry.relation}`)).toEqual(["ターナ=母", "シエナ=友人"]);
      expect(saved.rejectedRelations, "保存で退けた記録は変わらない").toHaveLength(1);

      // 「退けた記録から外す」：一覧から消え、記録だけが外れる（関係そのものは戻らない）
      const forget = frame.locator("#detail .rejected-relations button.forget-rejected");
      await waitUntil(async () => (await forget.count()) === 1 && (await forget.isEnabled()), "外すボタンが押せる", 15_000);
      await forget.click();
      await waitUntil(async () => (await frame.locator("#detail .rejected-relations").count()) === 0, "退けた関係の欄が消える", 20_000);
      await waitUntil(async () => (await readRina(session)).rejectedRelations.length === 0, "記録がファイルから外れる", 20_000);
      const after = await readRina(session);
      expect(after.relations.map((entry) => `${entry.name}=${entry.relation}`), "関係そのものは戻らない").toEqual([
        "ターナ=母",
        "シエナ=友人",
      ]);
    },
    LAUNCH
  );
});

test("人物相関図を開いたまま関係を直すと、設定資料パネルの保存でも、ファイルの書き換えでも、図が読み直される", async () => {
  await withVsCode(
    "相関図の読み直し",
    [EPISODE],
    async (session) => {
      const { page } = session;
      // 先に相関図を開く
      await runCommand(page, "人物相関図");
      /**
       * 図を「リナ中心」にして、右の「つながっている人」の行を読む。
       * 図は背面のタブでも描き直される（見えていない面は押せないので、画面の中からクリックを送る）
       */
      const graphSide = async (): Promise<string[]> => {
        for (const frame of page.frames()) {
          const has = await frame.evaluate(() => document.querySelector(".g-node") !== null).catch(() => false);
          if (!has) continue;
          return frame.evaluate(() => {
            if (!document.querySelector(".g-node-circle.g-center")) {
              const node = Array.from(document.querySelectorAll(".g-node")).find((n) => (n.textContent ?? "").includes("リナ"));
              node?.querySelector(".g-node-hit")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            }
            return Array.from(document.querySelectorAll(".side-row"))
              .filter((row) => row.querySelector(".person-link") !== null)
              .map((row) => (row as HTMLElement).innerText.trim());
          });
        }
        return [];
      };
      await waitUntil(async () => (await graphSide()).length > 0, "相関図に人物が並び、リナの「つながっている人」が出る", 30_000);
      expect(await graphSide(), "最初の関係").toEqual(["ターナ →母／←（記録なし）"]);

      // 設定資料パネルで「ターナ=母」を「ターナ=姉」に直して保存する
      const panel = await openSettingsPanel(session);
      const relations = await selectRina(panel);
      await relations.fill("ターナ=姉");
      await panel.locator("#detail .saverow button.action", { hasText: "保存" }).click();
      await waitUntil(async () => (await readRina(session)).relations[0]?.relation === "姉", "保存がファイルに入る", 20_000);
      // 図が読み直され、古い「母」が残らない
      await waitUntil(
        async () => (await graphSide()).join("|") === "ターナ →姉／←（記録なし）",
        "相関図が読み直されて、関係が「姉」になる（古い「母」が残らない）",
        30_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（いまの行：${JSON.stringify(await graphSide())}）`);
      });

      // 外からファイルを書き換える（承認待ちの更新を反映したときと同じ道）：「姉」→「師匠」
      const folder = defaultCharactersFolder(session.workFolder);
      const file = path.join(folder, characterFileName(cast()[0]));
      const current = JSON.parse(await readFile(file, "utf8")) as Character;
      current.relations = [{ name: "ターナ", relation: "師匠" }];
      await writeFile(file, JSON.stringify(current, null, 2), "utf8");
      await waitUntil(
        async () => (await graphSide()).join("|") === "ターナ →師匠／←（記録なし）",
        "ファイルの書き換えでも相関図が読み直される（古い「姉」が残らない）",
        30_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（いまの行：${JSON.stringify(await graphSide())}）`);
      });
      // 作品の設定の置き場を読み違えていないことの念押し
      expect((await settingsFolder(session)).endsWith("設定")).toBe(true);
    },
    LAUNCH
  );
});
