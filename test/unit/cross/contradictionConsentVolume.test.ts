import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  describeSendVolume,
  describeSentAgainstPlanned,
  sumPlannedSends,
} from "../../../src/core/sendVolume";
import { describeWholeReadConsent } from "../../../src/core/wholeReadConsent";

/**
 * **まるごと読む矛盾検知の同意画面に、送る量が2通り書かれた**
 * （ノートPCの実機、0.76.1、2026-09-23）。
 *
 * 教科書チート_確認用・はじめの10話・さくらのAI（クラウド）で「まるごと」を
 * 選ぶと、同意画面の上に「本文 約36,324字を1回に区切って送ります（指示と
 * 設定資料を含めて 約127,986字）」、下に「送る量: 約63,420字（本文 36,324字
 * ＋指示と設定資料 27,096字）」と**違う数**が出た。
 *
 * ## どちらが正しかったか
 *
 * **上（127,986字）が実際の送信に合う。** 矛盾検知は1つの区切りについて
 * 2回呼ぶ——本命（settled、63,420字）と、「あとで判明する事実」との
 * 突き合わせ（future、64,566字。同じ本文をもう一度送る。設計書6.10.4）。
 * 下の「送る量」は本命しか数えておらず、**同意した量の半分しか言って
 * いなかった**。分けて読むときの確認も同じく本命だけだった。
 *
 * ## 直し方
 *
 * 送る呼び出しを1つの一覧（`plannedSends`）に積み、**同意の文面も、確認の
 * 「送る量」も、時間の見積もりも、そこだけから数える**。送ったあとは
 * 実際に送った字数を数え、示した量と並べて操作ログへ残す。
 */

/** 実機で出た数（本文・本命・あとで判明する事実） */
const BODY = 36_324;
const SETTLED = 63_420;
const FUTURE = 64_566;

const SOURCE = readFileSync(
  join(__dirname, "..", "..", "..", "src", "features", "checkContradictions.ts"),
  "utf8"
);

describe("送る量は、全呼び出しの合計で1つだけ言う", () => {
  const total = sumPlannedSends([
    { chars: SETTLED, bodyChars: BODY },
    { chars: FUTURE, bodyChars: BODY },
  ]);

  test("本命と、あとで判明する事実の突き合わせの両方を足す", () => {
    expect(total.totalChars).toBe(127_986);
    expect(total.calls).toBe(2);
    // 本文は2回ぶん送っている
    expect(total.bodyChars).toBe(BODY * 2);
  });

  test("同意の文面に、送る量の合計がちょうど1つだけ出る（食い違う2つを並べない）", () => {
    const text = describeWholeReadConsent({
      serviceName: "さくらのAI",
      bodyChars: BODY,
      pieces: 1,
      volume: total,
      tokensPerChar: 0.7,
      maxOutputTokensPerCall: 8000,
    });
    // 実機で出た本命だけの数を出さない
    expect(text).not.toContain("63,420");
    // 合計は1回だけ
    expect(text.match(/127,986/g)?.length).toBe(1);
    expect(text.match(/送る量/g)?.length).toBe(1);
    // 「指示と設定資料を含めて」のもう1つの数え方を出さない
    expect(text).not.toContain("指示と設定資料を含めて");
    // 同じ本文を2度送ることを黙らない
    expect(text).toContain("のべ72,648字");
    expect(text).toMatch(/同じ本文をもう一度送ります/);
    // 入力のトークンも同じ合計から出す（127,986 × 0.7 ＝ 89,591 を切り上げ）
    expect(text).toContain("入力 約89,591トークン");
    // 出力の上限は呼ぶ回数ぶん（2回 × 8,000）
    expect(text).toContain("出力 最大16,000トークン");
  });

  test("同じ本文を重ねて送らないなら、「のべ」と言わない", () => {
    expect(
      describeSendVolume(sumPlannedSends([{ chars: 12_345, bodyChars: 10_000 }]))
    ).toBe("送る量: 約12,345字（本文 10,000字＋指示と設定資料 2,345字）");
  });
});

describe("送ったあと、示した量と実際に送った量を並べる", () => {
  test("合っていれば、そのまま並べる", () => {
    const line = describeSentAgainstPlanned({
      planned: { totalChars: 127_986, bodyChars: BODY * 2, calls: 2 },
      sentChars: 127_986,
      sentCalls: 2,
    });
    expect(line).toContain("送った量: 約127,986字（2回）");
    expect(line).toContain("確認で示した量: 約127,986字（2回）");
    expect(line).not.toContain("超えました");
  });

  test("示した量を超えたら、超えたと言う（黙って多く送ったことにしない）", () => {
    const line = describeSentAgainstPlanned({
      planned: { totalChars: 63_420, bodyChars: BODY, calls: 1 },
      sentChars: 127_986,
      sentCalls: 2,
    });
    expect(line).toContain("超えました");
  });
});

describe("矛盾検知への配線（書き方で押さえる）", () => {
  test("確認の「送る量」を、本命だけ（`promptFor(chunk, \"settled\")` の合計）で数えない", () => {
    // 直す前は、本命だけの `sendChars` の合計を送る量として出していた
    expect(SOURCE).not.toMatch(
      /describeSendVolume\(\{\s*totalChars:\s*sendChars\.reduce/
    );
    expect(SOURCE).toMatch(/describeSendVolume\(plannedTotal\)/);
  });

  test("あとで判明する事実の突き合わせも、送る予定に積む", () => {
    // 送る予定の一覧は `planContradictionSends`（core）が組む（2026-09-23。
    // 確認を出すかどうかも同じ一覧で決めるようにしたとき、core へ出した）
    const start = SOURCE.indexOf("planContradictionSends(chunks");
    expect(start).toBeGreaterThan(0);
    const plan = SOURCE.slice(start, SOURCE.indexOf("countPendingVerifies()", start));
    expect(plan).toMatch(/promptFor\(chunk,\s*"settled"\)/);
    expect(plan).toMatch(/promptFor\(chunk,\s*"future",/);
  });

  test("同意の文面は、確認と同じ合計（送る予定の一覧の合計）から組む", () => {
    const consent = SOURCE.slice(SOURCE.indexOf("describeWholeReadConsent({"));
    expect(consent.slice(0, 900)).toMatch(/volume:\s*sendPlan\.total/);
    // 確認の本体の「送る量」も同じ合計
    expect(SOURCE).toMatch(/plannedTotal\s*=\s*sendPlan\.sends\.length\s*>\s*0\s*\?\s*sendPlan\.total/);
    // 別の数え方（本命＋future を別に足し直す）を置かない
    expect(SOURCE).not.toMatch(/futureSendChars\(/);
  });

  test("送るたびに字数を数え、終わりに示した量と並べて残す", () => {
    const ask = SOURCE.slice(SOURCE.indexOf("async function ask("));
    const beforeGenerate = ask.slice(0, ask.indexOf("provider.generate("));
    expect(beforeGenerate).toMatch(/sentChars\s*\+=\s*sendCharsOf\(built\)/);
    expect(SOURCE).toMatch(/describeSentAgainstPlanned\(\{/);
  });

  test("数え方は1つ（送るときも見積もるときも `sendCharsOf`）", () => {
    const uses = SOURCE.match(/sendCharsOf\(/g) ?? [];
    // 定義＋本命の見積もり＋future の見積もり＋送るとき
    expect(uses.length).toBeGreaterThanOrEqual(4);
  });
});
