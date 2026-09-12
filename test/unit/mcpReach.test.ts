import * as fs from "fs";
import { describe, expect, test } from "vitest";
import {
  SRC,
  chainTo,
  relativeName,
  walkStaticImports,
} from "./support/importGraph";
// 起点の一覧は `scripts/coreEntries.mjs` が持つ。**束ねる側
// （`scripts/bundleCore.mjs`）と同じものを見る**ため、ここへは写さない
import { allEntryFiles } from "../../scripts/coreEntries.mjs";

/**
 * 外から呼ぶ束（MCP サーバー）に、`vscode` が混ざっていないか（設計書6.87.3）。
 *
 * **出す層は `prompts`（プロンプトの組み立て）と `core`（材料の組み立て・検算）
 * までで、`features`・`views` は出さない。** その束に `vscode` が1つでも
 * 静的に混ざると、**Node 単体では読み込んだ瞬間に落ちる**——ブラウザ版で
 * 起きるのと同じことが、今度は VS Code の外で起きる
 * （`browserReach.test.ts` と同じ理屈なので、たどる部分は共有している）。
 *
 * 実際に混ざっていた。`chunker.ts` が `hashText` を1つ借りるために
 * `textFile.ts`（`vscode` を import している）を指しており、
 * **チャンク分割を通る検算の系がぜんぶ `vscode` 依存**になっていた。
 *
 * **起点を減らして通してはいけない。** 切れないものが出たら、下の
 * `ALLOWED`（理由付きの除外）へ書いて、その理由ごと残す。
 */

/**
 * どうしても切れない起点と、その理由。
 *
 * **空で保つのが正しい。** 埋めるときは「なぜ切れないか」と
 * 「代わりに何をするか」を書く。黙って外すと、束ねられない理由が
 * 分からなくなる。
 */
const ALLOWED = new Map<string, string>();

describe("外から呼ぶ束に `vscode` が混ざっていないか", () => {
  const entries: string[] = allEntryFiles(SRC);

  test("起点のファイルがすべて実在する", () => {
    // 名前を書き間違えると、走査が静かに空振りする
    const missing = entries.filter((file) => !fs.existsSync(file));
    expect(missing.map(relativeName)).toEqual([]);
  });

  test("どの起点からも、静的 import で `vscode` へ届かない", () => {
    // 起点ごとに歩く。**経路（起点 → 経由 → 到達）を出すため**で、
    // まとめて歩くと「どの入口が悪いか」が消える
    const offenders: string[] = [];
    for (const entry of entries) {
      const name = relativeName(entry);
      if (ALLOWED.has(name)) continue;
      const reach = walkStaticImports([entry]);
      for (const bare of reach.bare) {
        if (bare.spec !== "vscode") continue;
        offenders.push(`${chainTo(reach, bare.file)} -> vscode`);
      }
    }
    // 落ちたら：経路の**終わりに近いところ**で、`vscode` を使う部分を
    // 別ファイルへ分ける（`textFile.ts` の `hashText` を `hash.ts` へ
    // 出したのと同じ形）。起点を消して通してはいけない
    expect([...new Set(offenders)].sort()).toEqual([]);
  });

  test("検査が空振りしていない（起点も、たどった先も十分ある）", () => {
    // たどり方が壊れて0件になっても、上の検査は通ってしまう
    expect(entries.length).toBeGreaterThan(30);
    const reach = walkStaticImports(entries);
    expect(reach.files.size).toBeGreaterThan(60);
  });

  test("除外している起点には、必ず理由が書いてある", () => {
    for (const [name, reason] of ALLOWED) {
      expect(reason.length, `${name} の理由が空`).toBeGreaterThan(0);
    }
  });
});
