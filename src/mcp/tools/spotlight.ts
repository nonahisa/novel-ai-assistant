import fs from "node:fs";
import nodePath from "node:path";
import { z } from "zod";
import { AIWRITER_DIR } from "../../models/types";
import {
  SPOTLIGHT_REQUEST_DIRECTORY,
  SPOTLIGHT_REQUEST_FILE,
  formatSpotlightRequestLine,
} from "../../core/spotlightRequest";
import { getExternalClientName } from "./accessLog";
import { FOLDER_INPUT, McpToolError } from "./shared";

/**
 * 外部AIから、画面のメニュー項目を光らせる（設計書6.104。0.75.6）。
 *
 * **作者の指示（2026-09-22）**：「テストでも製品版でも、AIからの回答で
 * 点滅すると良いと思うので、内部と外部のAIからメニュー操作して2回点滅を
 * 出せるようにしてください」。
 *
 * ## 光らせるだけ。命令は実行しない
 *
 * 外から呼ぶ口は読む・測る・提案するまで（6.87.7）で、**この道具だけが
 * 作者の承認を得た例外**である。それでも**実行はしない**——光った項目を
 * 押すかどうかは作者が決める。原稿も設定資料も台帳も1文字も触らない。
 *
 * ## 別プロセスなので、ファイルへ1行書いて渡す
 *
 * MCPサーバーは VS Code が起動していなくても動く別プロセスで、拡張機能の
 * 画面へ直接は届かない。**断ったノックを知らせる道**（6.87.14）と同じ形で、
 * `.aiwriter/history/spotlight.jsonl` へ1行足し、拡張機能側の見張りが読む。
 *
 * **VS Code が閉じていても失敗にしない。** 次に開いたときに光る
 * （見張りは起動時にも一度読む）ので、呼んだ側には「届けた」と返して、
 * いつ光るかを `note` で正直に伝える。
 *
 * ## ラベルは、解かずにそのまま渡す
 *
 * ラベルとコマンドIDの対応表（`ACTION_TREE`）は 0.94.4 から
 * `core/actionTree.ts` にあり、`vscode` に依存しないので**この束からも読める**。
 * それでも**ここでは解かない**——光らせるのは拡張機能の側で、そちらは
 * 同じ木を読んで解く（`spotlightRequestWatcher.ts`）。ここで解くと、
 * 返す `command` が変わり、知らない名前を断るかどうかという振る舞いも
 * 変わる。**対応表の写しも作らない**（二重に持つと片方だけが古くなる）。
 * 名前のまま書いて、**光らせる側で解く。**
 */

export const GUIDE_SPOTLIGHT_INPUT = {
  ...FOLDER_INPUT,
  command: z
    .string()
    .optional()
    .describe(
      "光らせる操作のコマンドID（例 novelai.runProofread）。" +
        "label とどちらか一方が要ります"
    ),
  label: z
    .string()
    .optional()
    .describe(
      "光らせる項目の表示名（例 推敲）。完全一致で引きます。" +
        "コマンドIDが分かるなら command のほうが確実です"
    ),
};

export interface SpotlightRequestInput {
  folder: string;
  command?: string;
  label?: string;
}

export interface SpotlightRequestResult {
  /** 依頼を置けたか。**光ったかではない**（光るのは拡張機能の側） */
  requested: true;
  command: string;
  label: string;
  /** 呼んだ側へ返す断り。**いつ光るのかを誤解させない** */
  note: string;
}

export function guideSpotlight(
  input: SpotlightRequestInput
): SpotlightRequestResult {
  if (!input.folder?.trim()) {
    throw new McpToolError(
      "folder が要ります（どの作品の画面を光らせるか決められないため断りました）。"
    );
  }
  const command = input.command?.trim() ?? "";
  const label = input.label?.trim() ?? "";
  if (!command && !label) {
    /*
      **どちらも無い呼び出しは断る。** 黙って受けると、呼んだ側からは
      「届いたのに光らない」に見える（`novel.notice` が `count` を
      受け取って捨てなかったのと同じ考え方）。
    */
    throw new McpToolError(
      "command か label のどちらかが要ります（何を光らせるか分からないため断りました）。"
    );
  }

  const entry = {
    at: new Date().toISOString(),
    client: getExternalClientName(),
    command,
    label,
  };
  const target = nodePath.join(
    nodePath.resolve(input.folder),
    AIWRITER_DIR,
    SPOTLIGHT_REQUEST_DIRECTORY,
    SPOTLIGHT_REQUEST_FILE
  );
  try {
    fs.mkdirSync(nodePath.dirname(target), { recursive: true });
    // **追記だけ（`a`）。** 同時に書かれても行が並ぶだけで、両方残る
    fs.appendFileSync(target, `${formatSpotlightRequestLine(entry)}\n`, "utf8");
  } catch (error) {
    /*
      **ここは握りつぶさない。** 記録（`accessLog.ts`）は書けなくても
      測定を止めないが、こちらは**書けなければ依頼そのものが届かない**
      ——「届けた」と返すと、呼んだ側は光るのを待ち続けることになる。
    */
    throw new McpToolError(
      `依頼を置けませんでした: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return {
    requested: true,
    command,
    label,
    note:
      "拡張機能が開いていれば 2回点滅します。閉じていれば次に開いたときに光ります。" +
      "押すのは作者です——この道具は光らせるだけで、操作は実行しません。",
  };
}
