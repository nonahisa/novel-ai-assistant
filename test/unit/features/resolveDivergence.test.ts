import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { git } from "../support/gitTemplate";
import {
  answers,
  shown,
  root,
  write,
  pushFromOtherMachine,
  commitHere,
  deps,
  status,
  useRepository,
  resetScreen,
} from "../support/divergenceHarness";

/**
 * 分岐を合わせる（設計書5.5.16）を、**本物のgitリポジトリで動かす**。
 *
 * この作品で繰り返した失敗は「単体テストが通っても実データで動かない」である。
 * 作り物の返事だけで確かめると、**gitの実際の振る舞い**（何が衝突と数えられ、
 * `--no-commit` のあと何がステージに載るか）を確かめたことにならない。
 *
 * vscode だけを差し替えて、gitとファイルは本物を使う。
 *
 * **1つのファイルを3つに分けてある**（2026-10-17。並列に走らせるため。
 * 前準備と代役は `support/divergenceHarness.ts` に共通で置いた）。
 * 自動合流（`foldDivergence`）の件は `resolveDivergenceFoldSettings.test.ts` と
 * `resolveDivergenceFoldFiles.test.ts`。
 */

vi.mock("vscode", async () => (await import("../support/divergenceHarness")).vscodeStub);

const {
  resolveDivergence,
  describeAuthoredStop,
  describeDivergenceBreakdown,
  describeDivergenceConfirm,
  describeFoldSuccess,
} = await import("../../../src/features/resolveDivergence");

beforeEach(() => {
  resetScreen();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// 本物のgitを子プロセスで何度も起動するため、全体実行の並列負荷では1本が
// 6秒台まで伸びることがある（既定5秒を際どく超え、落ちるテストが毎回入れ替わる）。
// 単独実行では1.6秒程度。処理の遅さではなく起動の重さなので、待ちだけ伸ばす
describe("分かれた分を合わせる", { timeout: 30_000 }, () => {
  useRepository();

  test("衝突しなければ、そのまま合わせる", async () => {
    // 別のPCで新しい話を書き、こちらでは別の話を直した
    pushFromOtherMachine([["短編/本文/第2話.txt", "つづき。\n"]]);
    commitHere([["短編/本文/第1話.txt", "むかしむかし、あるところに。\n"]], "こちらで加筆");
    git(root, "fetch", "-q");
    expect(status()).toContain("ahead 1, behind 1");

    answers.push("そろえる");
    await resolveDivergence(deps());

    // こちらの1件＋合わせた1件で、送るものは2件になる
    expect(status()).toContain("ahead 2");
    expect(status()).not.toContain("behind");
    // 両方の原稿が残っている
    expect(fs.readFileSync(nodePath.join(root, "短編/本文/第2話.txt"), "utf8")).toBe(
      "つづき。\n"
    );
    expect(fs.readFileSync(nodePath.join(root, "短編/本文/第1話.txt"), "utf8")).toBe(
      "むかしむかし、あるところに。\n"
    );
  });

  test("押さなければ、何も起きない", async () => {
    pushFromOtherMachine([["短編/本文/第2話.txt", "つづき。\n"]]);
    commitHere([["短編/本文/第1話.txt", "こちら。\n"]], "こちらで加筆");

    // 「合わせる」を押さない
    await resolveDivergence(deps());

    expect(status()).toContain("ahead 1, behind 1");
  });

  test("戻せるように、退避の枝を残す", async () => {
    pushFromOtherMachine([["短編/本文/第2話.txt", "つづき。\n"]]);
    commitHere([["短編/本文/第1話.txt", "こちら。\n"]], "こちらで加筆");

    answers.push("そろえる");
    await resolveDivergence(deps());

    expect(git(root, "branch", "--list", "backup/*")).toContain("backup/");
  });

  test("未記録の変更は、合わせる前に記録する", async () => {
    // 汚れたままではマージを始められない。**書きかけを失わせない**
    pushFromOtherMachine([["短編/本文/第2話.txt", "つづき。\n"]]);
    commitHere([["短編/本文/第1話.txt", "こちら。\n"]], "こちらで加筆");
    write(root, "短編/本文/第3話.txt", "書きかけ。\n");

    answers.push("そろえる");
    await resolveDivergence(deps());

    expect(git(root, "status", "--porcelain").trim()).toBe("");
    expect(fs.readFileSync(nodePath.join(root, "短編/本文/第3話.txt"), "utf8")).toBe(
      "書きかけ。\n"
    );
  });

  test("同じ原稿が両方で書き換えられていたら、作者に選ばせる（設計書5.5.18）", async () => {
    // **どちらを残すかは、書いた本人にしか分からない**（設計書5.5.4）。
    // 0.45.0 からは、そこで手を引かずに1件ずつ選ばせる。
    // ここでは見比べの画面を用意していないので、取りやめて元へ戻る
    pushFromOtherMachine([["短編/本文/第1話.txt", "むこうの直し。\n"]]);
    commitHere([["短編/本文/第1話.txt", "こちらの直し。\n"]], "こちらで直した");

    answers.push("そろえる");
    await resolveDivergence(deps());

    // 分かれたまま。原稿はこちらのまま
    expect(status()).toContain("ahead 1, behind 1");
    expect(fs.readFileSync(nodePath.join(root, "短編/本文/第1話.txt"), "utf8")).toBe(
      "こちらの直し。\n"
    );
    // **押す前に、選ぶことになると言ってある**
    expect(shown.join("\n")).toContain("残すほうを選んでください");
  });

  test("自動で書かれるものだけの食い違いなら、この端末の側を残して合わせる", async () => {
    // 執筆量の記録は端末ごとで、読み込むときに合算する（設計書5.5.6）
    pushFromOtherMachine([["短編/.aiwriter/stats/pc.json", '{"at":"むこう"}\n']]);
    commitHere([["短編/.aiwriter/stats/pc.json", '{"at":"こちら"}\n']], "こちらの記録");

    answers.push("そろえる");
    await resolveDivergence(deps());

    expect(status()).not.toContain("behind");
    expect(
      fs.readFileSync(nodePath.join(root, "短編/.aiwriter/stats/pc.json"), "utf8")
    ).toBe('{"at":"こちら"}\n');
  });

  test("同じ中身を両方で入れていたら、衝突にしない", async () => {
    // 作者の置き場で実際に起きた形。**名前で判定していたら行き止まりだった**
    const 同じ原稿 = "投稿サイトから取り込んだ本文。\n";
    pushFromOtherMachine([["短編/本文/第9話.txt", 同じ原稿]]);
    commitHere([["短編/本文/第9話.txt", 同じ原稿]], "こちらでも取り込んだ");

    answers.push("そろえる");
    await resolveDivergence(deps());

    expect(status()).not.toContain("behind");
    expect(fs.readFileSync(nodePath.join(root, "短編/本文/第9話.txt"), "utf8")).toBe(
      同じ原稿
    );
  });

  test("改行の自動変換が入る環境でも、合わせられる", async () => {
    // gitは書き戻すときに改行を変える（`core.autocrlf`）。
    // **取り込んだファイルはそれで構わないが、触っていない原稿が変わったら止める**
    // ——それを見分けられずに止まっていた不具合を、ここで抑える
    git(root, "config", "core.autocrlf", "true");
    pushFromOtherMachine([["短編/本文/第2話.txt", "つづき。\n"]]);
    commitHere([["短編/本文/第1話.txt", "こちら。\n"]], "こちらで加筆");
    const 触らない原稿 = fs.readFileSync(
      nodePath.join(root, "短編/本文/第1話.txt")
    );

    answers.push("そろえる");
    await resolveDivergence(deps());

    expect(status()).not.toContain("behind");
    // 触っていない原稿は1バイトも変わっていない
    expect(fs.readFileSync(nodePath.join(root, "短編/本文/第1話.txt"))).toEqual(
      触らない原稿
    );
  });

  test("分かれていなければ、何もしない", async () => {
    pushFromOtherMachine([["短編/本文/第2話.txt", "つづき。\n"]]);

    answers.push("そろえる");
    await resolveDivergence(deps());

    expect(shown.join("\n")).toContain("2台の原稿がそろっています");
    // 取り込みもしない（それは「同期」の仕事である）
    expect(fs.existsSync(nodePath.join(root, "短編/本文/第2話.txt"))).toBe(false);
  });

  test("そろえても、その場では送らない。送るのは自動の送り直しで、そう知らせる", async () => {
    // この関数は push しない（設計書5.5.1）。そろえた記録は「送っていない記録」になり、
    // 自動の送り直しが数分のうちに送る（2026-10-11、窓に「送りません」と書いて
    // あったのに送られていた。**知らせを事実に合わせる**）
    pushFromOtherMachine([["短編/本文/第2話.txt", "つづき。\n"]]);
    commitHere([["短編/本文/第1話.txt", "こちら。\n"]], "こちらで加筆");

    answers.push("そろえる");
    await resolveDivergence(deps());

    expect(status()).toContain("ahead");
    // 設定が読めない試験の場では、既定（送り直しが入っている）として扱う
    expect(shown.join("\n")).toContain("数分のうちに自動でGitHubへ送ります");
    expect(shown.join("\n")).not.toContain("送りません");
  });
});

/**
 * 押す前に見せる中身（実機確認リスト A-17。作者の裁定で書き直し、2026-10-11）。
 *
 * **確認の画面が出ること自体は実機に残る。** ここで見るのは、出たときに
 * 「何が起き、作者が何を選ぶことになり、GitHubへ送るのか」が書いてあるかである。
 * 自動で書かれるもの・履歴・設定資料の内訳は、窓から外して作品のログへ回した
 * （窓に並べると、どこを読めばよいか分からない）。
 */
describe("そろえる前の確認に出す中身", () => {
  const 基本 = {
    label: "確認用コピー",
    behind: 3,
    ahead: 2,
    autoWritten: 0,
  };

  test("自動の送り直しが入っていれば、そろえて送ると言う", () => {
    const text = describeDivergenceConfirm({
      ...基本,
      manuscripts: 1,
      autoResend: true,
      sideExample: "第1話.conflict-2026-10-13-2240.txt",
    });

    expect(text.message).toBe("「確認用コピー」：2台の原稿をそろえて、GitHubへ送ります。");
    expect(text.detail).toBe(
      [
        "もう1台で書いた分を入れ、このパソコンで書いた分も残します。",
        "同じところを両方で書き換えた原稿が 1件あります。このあと両方の文を並べるので、残すほうを選んでください。",
        // 「両方とも残す」で何が起きるか（作者、2026-10-13 夜「どうやって統合するかわからない」）
        "「両方とも残す」を選ぶと、このパソコンの文が原稿になり、もう1台の文は同じフォルダーに" +
          "別のファイル（例：第1話.conflict-2026-10-13-2240.txt）として残ります。あとで読み比べて直せます。",
        "そろえ終わったら、数分のうちに自動でGitHubへ送ります。",
        "",
        "途中でやめれば、原稿は元のままです。そろえたあとでも「そろえる前」へ戻せます。",
      ].join("\n")
    );
  });

  test("自動の送り直しが切ってあれば、送らないと言い、送り方を示す", () => {
    const text = describeDivergenceConfirm({ ...基本, autoResend: false });

    expect(text.message).toBe("「確認用コピー」：2台の原稿をそろえます。");
    expect(text.detail).toContain(
      "GitHubへは送りません。送るときは「保存・同期」を押してください。"
    );
    expect(text.detail).not.toContain("自動でGitHubへ送ります");
  });

  test("選ぶ原稿が無ければ、選ぶ行を出さない", () => {
    const text = describeDivergenceConfirm({ ...基本, autoResend: true });

    expect(text.detail).not.toContain("残すほうを選んでください");
    expect(text.detail).not.toContain("両方とも残す");
  });

  test("内訳（自動で書かれるもの・追記型・設定資料）は窓に出さない", () => {
    const text = describeDivergenceConfirm({
      ...基本,
      autoWritten: 4,
      appendOnly: 3,
      settings: 2,
      autoResend: true,
    });

    expect(text.detail).not.toContain("自動で書かれるもの");
    expect(text.detail).not.toContain("追記型");
    expect(text.detail).not.toContain("設定資料");
  });

  test("窓から外した内訳は、ログへ1行で残す", () => {
    const line = describeDivergenceBreakdown({
      ...基本,
      autoWritten: 4,
      appendOnly: 3,
      settings: 2,
      settingsToChoose: 1,
      manuscripts: 5,
    });

    expect(line).toContain("自動で書かれるもの 4件");
    expect(line).toContain("追記型 3件");
    expect(line).toContain("設定資料 2件（作者が選ぶ 1件）");
    expect(line).toContain("作者が選ぶ原稿 5件");
    expect(line).not.toContain("\n");
  });

  test("作者の目に触れる文に、開発の言葉（分岐・環境・枝）を出さない", () => {
    const text = describeDivergenceConfirm({
      ...基本,
      settingsToChoose: 2,
      manuscripts: 1,
      autoResend: true,
    });
    const all = [text.message, text.detail, ...text.buttons].join("\n");

    for (const word of ["分岐", "環境", "枝", "合わせる"]) {
      expect(all).not.toContain(word);
    }
  });

  /*
    確認［そろえる］と見比べの入口の窓を1つにまとめる（作者の裁定、2026-10-01 案2）。
    「分岐合流」から入ったときも、窓は1つで済むようにする
  */
  test("選ぶ設定資料があれば、確認の窓に選び方のボタンを並べ、その意味を1行だけ残す", () => {
    const text = describeDivergenceConfirm({
      ...基本,
      settingsToChoose: 2,
      manuscripts: 1,
      autoResend: true,
    });

    expect(text.buttons).toEqual([
      "そろえる（設定資料は新しいほうへ）",
      "そろえる（1件ずつ選ぶ）",
    ]);
    expect(text.detail).toContain(
      "作者が書いたところが両方で違う設定資料が 2件あります。下のボタンで決め方を選んでください。"
    );
    expect(text.detail).toContain("途中でやめれば");
  });

  test("選ぶ設定資料が無ければ、ボタンは「そろえる」1つ", () => {
    const text = describeDivergenceConfirm({
      ...基本,
      settings: 3,
      manuscripts: 1,
      autoResend: true,
    });

    expect(text.buttons).toEqual(["そろえる"]);
  });
});

// 本物のgitを起動するので、上の describe と同じだけ待つ
describe("本物のリポジトリでも、確認の窓が出る", { timeout: 30_000 }, () => {
  useRepository();

  test("実際に2台で書き進めた状態で、そろえる確認が出る（実機確認リスト A-17 の代わり）", async () => {
    // 作り物の入力ではなく、**gitが数えた ahead / behind** から窓まで届くかを見る。
    // 件数は窓から外して作品のログへ回した（作者の裁定、2026-10-11）
    pushFromOtherMachine([["短編/本文/第2話.txt", "つづき。\n"]]);
    commitHere([["短編/本文/第1話.txt", "こちら。\n"]], "こちらで加筆");

    await resolveDivergence(deps());

    expect(shown.join("\n")).toContain("「短編」：2台の原稿をそろえて、GitHubへ送ります。");
    expect(shown.join("\n")).toContain(
      "もう1台で書いた分を入れ、このパソコンで書いた分も残します。"
    );
  });
});

/**
 * 済んだあとの知らせ（2026-09-11。文は作者の裁定で書き直し、2026-10-11）。
 *
 * 作者が13件を「全部、新しいほうを採る」で片づけたのに、
 * 「本文など13件はお選びいただきました」と出ていた。
 * **やっていないことを、やったと言わない。** 画面を出さずに文面だけ確かめる。
 */
describe("そろえた結果の知らせ", () => {
  function 結果(input: {
    bulk?: number;
    picked?: string[];
    auto?: Array<"ours" | "theirs" | "merged">;
  }) {
    return {
      ok: true as const,
      backup: "backup/2026-09-11-101112-合わせる前",
      incoming: 4,
      settingsAutoResolved: (input.auto ?? []).map((side, index) => ({
        file: `短編/設定/characters/char_00${index + 1}.json`,
        side,
        reason: "作者の書いた部分が同じ",
      })),
      settingsBulkResolved: input.bulk ?? 0,
      manuscriptConflicts: input.picked ?? [],
    };
  }

  test("作者の裁定どおりの文になる（自動の送り直しが入っているとき）", () => {
    const text = describeFoldSuccess(
      "確認用コピー",
      結果({ picked: ["確認用コピー/本文/episode_9999_同期の確認.md"] }),
      { sending: false, autoResend: true }
    );

    expect(text).toBe(
      "「確認用コピー」の2台の原稿をそろえました" +
        "（もう1台から入れたファイル 4件／選んでいただいた原稿 1件）。" +
        "数分のうちに自動でGitHubへ送ります。" +
        "そろえる前へ戻したいときは、控え「backup/2026-09-11-101112-合わせる前」から戻せます。"
    );
  });

  test("自動の送り直しが切ってあれば、送り方を示す", () => {
    const text = describeFoldSuccess("短編", 結果({}), {
      sending: false,
      autoResend: false,
    });

    expect(text).toContain("GitHubへは「保存・同期」で送ります。");
    expect(text).not.toContain("自動でGitHubへ送ります");
  });

  test("同期の流れの中なら、続けて送ると言う", () => {
    expect(describeFoldSuccess("短編", 結果({}), { sending: true })).toContain(
      "続けてGitHubへ送ります。"
    );
  });

  test("両方とも残した別ファイルの名前を出す（選ぶ一覧には出さないため）", () => {
    const text = describeFoldSuccess("短編", {
      ...結果({ picked: ["短編/本文/第1話.txt"] }),
      sideFiles: ["短編/本文/第1話.conflict-2026-10-11-0045.txt"],
    });

    expect(text).toContain(
      "もう1台の文は、同じフォルダーの「第1話.conflict-2026-10-11-0045.txt」に残しました" +
        "（原稿はこのパソコンの文です。あとで読み比べて直せます）。"
    );
    expect(describeFoldSuccess("短編", 結果({}))).not.toContain("に残しました");
  });

  /*
    そろえたあと GitHub へ送るかを、別のファイルについても書く（作者、2026-10-13 夜。
    そろえた15秒後に自動の送り直しが送っていた）。別のファイルはそろえた記録に
    入る（`foldDivergence` が記録の直前に足す）ので、原稿と一緒に送られる
  */
  test("両方とも残したときは、別のファイルも一緒に GitHub へ送るかどうかを書く", () => {
    const withSide = {
      ...結果({ picked: ["短編/本文/第1話.txt"] }),
      sideFiles: ["短編/本文/第1話.conflict-2026-10-11-0045.txt"],
    };

    expect(
      describeFoldSuccess("短編", withSide, { sending: false, autoResend: true })
    ).toContain("数分のうちに自動でGitHubへ送ります（別のファイルも一緒に送ります）。");
    expect(describeFoldSuccess("短編", withSide, { sending: true })).toContain(
      "続けてGitHubへ送ります（別のファイルも一緒に送ります）。"
    );
    expect(
      describeFoldSuccess("短編", withSide, { sending: false, autoResend: false })
    ).toContain("GitHubへは「保存・同期」で送ります（別のファイルも一緒に送ります）。");
    // 別のファイルが無いときは、添えない
    expect(
      describeFoldSuccess("短編", 結果({}), { sending: false, autoResend: true })
    ).not.toContain("別のファイル");
  });

  test("一括だけなら、選んだとは言わない", () => {
    const text = describeFoldSuccess("短編", 結果({ bulk: 13 }));

    expect(text).toContain("設定資料 13件は、まとめて新しいほうを採りました");
    expect(text).not.toContain("選んでいただいた");
  });

  test("手選びだけなら、選んだ件数だけ", () => {
    const text = describeFoldSuccess(
      "短編",
      結果({ picked: ["短編/本文/第1話.txt", "短編/本文/第2話.txt"] })
    );

    expect(text).toContain("選んでいただいた原稿 2件");
    expect(text).not.toContain("新しいほうを採りました");
  });

  test("両方あれば、両方を別々に数える", () => {
    const text = describeFoldSuccess(
      "短編",
      結果({ bulk: 13, picked: ["短編/本文/第1話.txt"] })
    );

    expect(text).toContain("設定資料 13件は、まとめて新しいほうを採りました");
    expect(text).toContain("選んでいただいた原稿 1件");
  });

  test("どちらも無ければ、入れた件数だけ", () => {
    const text = describeFoldSuccess("短編", 結果({}));

    expect(text).toContain("もう1台から入れたファイル 4件");
    expect(text).not.toContain("新しいほうを採りました");
    expect(text).not.toContain("選んでいただいた");
  });

  test("規則で揃えた分とは、別の言い方で並べる", () => {
    // 規則（`settingsConflictRule`）で決めた分と、入口で一括に寄せた分は
    // **別の経路**である。同じ数え方に畳むと、どちらが起きたのか分からない
    const text = describeFoldSuccess(
      "短編",
      結果({ auto: ["theirs", "ours", "merged"], bulk: 13 })
    );

    expect(text).toContain(
      "設定資料 3件は新しいほうにそろえました（うち両方の変更を合わせた 1件）"
    );
    expect(text).toContain("設定資料 13件は、まとめて新しいほうを採りました");
  });

  test("作者の目に触れる文に、開発の言葉（分岐・環境）を出さない", () => {
    const text = describeFoldSuccess(
      "短編",
      結果({ auto: ["theirs"], bulk: 1, picked: ["短編/本文/第1話.txt"] }),
      { sending: false, autoResend: true }
    );
    expect(text).not.toContain("分岐");
    expect(text).not.toContain("環境");
  });
});

/**
 * 選ばずにやめたときの文（2026-10-11）。
 *
 * それまでは「もう一度同期すると、続きから選べます」と書いていた。実際には
 * やめると `merge --abort` で全部戻るので、**次は最初から選び直し**になる。
 */
describe("選ばずにやめたときの知らせ", () => {
  test("「続きから」とは言わず、最初から選び直すと言う", () => {
    const text = describeAuthoredStop(["短編/本文/第1話.txt", "短編/設定/x.json"]);

    expect(text).not.toContain("続きから");
    expect(text).toContain("そろえるのをやめて、元のままにしました。");
    expect(text).toContain("最初から選び直せます");
    expect(text).toContain("（第1話.txt、x.json）");
  });
});
