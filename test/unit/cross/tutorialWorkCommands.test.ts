import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { TUTORIAL_WORK_COMMANDS } from "../../../src/core/tutorialFlow";
import { PROOFREADING_SUITE_COMMAND } from "../../../src/core/proofreadingSuite";

/**
 * はじめの案内が作品を渡すコマンドの一覧（`core/tutorialFlow.ts`）と、
 * `extension.ts` の登録が食い違わないことを見張る（設計書6.90.7）。
 *
 * - 一覧に無いのに作品を受けるコマンド → 押すたびに作品を選ばされる
 *   （2026-10-10 の永久ループと同じ形に戻る）
 * - 一覧にあるのに作品を受けないコマンド → 渡した作品が黙って捨てられる
 *
 * 段を足したとき、どちらの書き忘れもここで止まる。
 */
const root = path.resolve(__dirname, "../../..");
const extensionSource = fs.readFileSync(
  path.join(root, "src/extension.ts"),
  "utf8"
);
const writerStyleSource = fs.readFileSync(
  path.join(root, "src/core/writerStyle.ts"),
  "utf8"
);

/** 案内の段に出てくるコマンド（writerStyle.ts の `command: "novelai.…"`） */
function tutorialCommands(): string[] {
  const found = new Set<string>();
  for (const match of writerStyleSource.matchAll(
    /command:\s*"(novelai\.[A-Za-z]+)"/g
  )) {
    found.add(match[1]);
  }
  return [...found].sort();
}

/** 登録の第1引数が作品（WorkNode / WorkRef）か。登録が見つからなければ undefined */
function takesWork(command: string): boolean | undefined {
  const names = [`"${command}"`];
  if (command === PROOFREADING_SUITE_COMMAND) {
    names.push("PROOFREADING_SUITE_COMMAND");
  }
  for (const name of names) {
    const at = extensionSource.search(
      new RegExp(`registerCommand\\(\\s*${name.replace(/\./g, "\\.")}\\s*,`)
    );
    if (at < 0) continue;
    const head = extensionSource.slice(at, at + 200);
    // `importRuby` のように関数名だけを渡す登録は、作品を受けない
    return /,\s*(async\s*)?\(\s*\w+\?:\s*Work(Node|Ref)\b/.test(head);
  }
  return undefined;
}

describe("はじめの案内が作品を渡すコマンド", () => {
  test("案内の段のコマンドは、どれも登録が見つかる", () => {
    const missing = tutorialCommands().filter(
      (command) => takesWork(command) === undefined
    );
    expect(missing).toEqual([]);
  });

  test("作品を受ける段と、一覧に載っている段が一致する", () => {
    const commands = tutorialCommands();
    const takes = commands.filter((command) => takesWork(command) === true);
    const listed = commands.filter((command) =>
      TUTORIAL_WORK_COMMANDS.has(command)
    );
    expect(listed).toEqual(takes);
  });

  test("一覧に、案内に出てこないコマンドを載せていない", () => {
    const commands = new Set(tutorialCommands());
    const extra = [...TUTORIAL_WORK_COMMANDS].filter(
      (command) => !commands.has(command)
    );
    expect(extra).toEqual([]);
  });
});
