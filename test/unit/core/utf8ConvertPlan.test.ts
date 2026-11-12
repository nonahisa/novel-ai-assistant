import { describe, expect, test } from "vitest";
import {
  describeUtf8Confirm,
  planUtf8Targets,
  type Utf8Candidate,
} from "../../../src/core/utf8ConvertPlan";

function candidate(name: string, over: Partial<Utf8Candidate> = {}): Utf8Candidate {
  return {
    filePath: `C:\\作品\\${name}`,
    name,
    encoding: "shift_jis",
    plan: "convert",
    hash: `hash-${name}`,
    dirty: false,
    settingShiftJis: false,
    ...over,
  };
}

describe("何話を UTF-8 にするか", () => {
  test("Shift_JIS の話だけを変え、読めない・競合・未保存の話は飛ばす", () => {
    const all = [
      candidate("第1話.txt"),
      candidate("第2話.txt", { plan: "undecodable" }),
      candidate("第3話.txt", { plan: "conflict_markers" }),
      candidate("第4話.txt", { dirty: true }),
      candidate("第5話.txt", { encoding: "utf8", plan: "not_shift_jis" }),
    ];
    const plan = planUtf8Targets(all, all);
    expect(plan.targets.map((target) => target.name)).toEqual(["第1話.txt"]);
    expect(plan.targets[0].hash).toBe("hash-第1話.txt");
    expect(plan.undecodable).toEqual(["第2話.txt"]);
    expect(plan.conflicted).toEqual(["第3話.txt"]);
    expect(plan.dirty).toEqual(["第4話.txt"]);
  });

  test("「この話だけ」なら、その1話だけ。BOM は範囲の外の UTF-8 の話に合わせる", () => {
    const one = candidate("第1話.txt");
    const all = [
      one,
      candidate("第2話.txt"),
      candidate("第3話.txt", { encoding: "utf8-bom", plan: "not_shift_jis" }),
    ];
    const plan = planUtf8Targets(all, [one]);
    expect(plan.targets).toEqual([{ filePath: one.filePath, name: "第1話.txt", hash: one.hash, bom: true }]);
  });

  test("ほかに UTF-8 の話が無ければ BOM なし。設定が shiftjis の話には付ける", () => {
    const all = [candidate("第1話.txt"), candidate("第2話.txt", { settingShiftJis: true })];
    const plan = planUtf8Targets(all, all);
    expect(plan.targets.map((target) => target.bom)).toEqual([false, true]);
    expect(plan.bomForSetting).toBe(true);
  });
});

describe("確かめの窓の文", () => {
  test("何話かと話の名前の一覧・飛ばす話・外の道具の注意を出す", () => {
    const all = [candidate("第1話 出会い.txt"), candidate("第2話.txt", { plan: "undecodable" })];
    const { message, detail } = describeUtf8Confirm(planUtf8Targets(all, all));
    expect(message).toBe("1話を Shift_JIS から UTF-8 に変換します。");
    expect(detail).toContain("・第1話 出会い.txt");
    expect(detail).toContain("Shift_JIS として読めないバイトがある1話（第2話.txt）");
    expect(detail).toContain("BOM（先頭の印）は付けません。");
    expect(detail).toContain("控え（.novelai-recovery）");
    expect(detail).toContain("Shift_JIS でしか読めない道具で開いている場合は、その道具の設定も変えてください。");
  });

  test("設定が shiftjis で BOM を付けるときは、そう書く（設定は書き換えない）", () => {
    const all = [candidate("第1話.txt", { settingShiftJis: true })];
    const { detail } = describeUtf8Confirm(planUtf8Targets(all, all));
    expect(detail).toContain("BOM（先頭の印）を付けます。");
    expect(detail).toContain("設定「files.encoding」が shiftjis");
    expect(detail).toContain("設定はそのままにしています。");
  });

  test("話が多いときは名前を15話まで並べ、残りは数だけ", () => {
    const all = Array.from({ length: 20 }, (_, index) => candidate(`第${index + 1}話.txt`));
    const { detail } = describeUtf8Confirm(planUtf8Targets(all, all));
    expect(detail).toContain("・第15話.txt");
    expect(detail).not.toContain("・第16話.txt");
    expect(detail).toContain("ほか5話");
  });
});
