import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { ENTRANCE_SHOTS } from "../../../src/core/entranceShots";
import { GUIDE_EXPORT_NAMES, guideExport } from "../../../src/core/guideExport";
import { MENU_PATH_START } from "../../../src/core/menuPath";
import { PROCEDURES } from "../../../src/core/procedures";

/**
 * Discord のボットが束ねて呼ぶ口の形（2026-11-06）。**名前と形を変えると、ボットだけが黙って壊れる。**
 * 変えるときは、ボットのセッション（製品：Discord）へ先に知らせてからここを直す。
 */
const repositoryRoot = path.resolve(__dirname, "..", "..", "..");

describe("guideExport（ボットへ渡す口）", () => {
  test("名前の一覧が、約束した10の並びのまま（前からの9つ＋末尾の ENTRANCE_SHOTS）", () => {
    expect([...GUIDE_EXPORT_NAMES]).toEqual([
      "menuPathsOf",
      "renderMenuPathText",
      "menuPathLine",
      "MENU_PATH_START",
      "guideMenuEntries",
      "PROCEDURES",
      "proceduresForMode",
      "renderProcedure",
      "procedureActionLookup",
      "ENTRANCE_SHOTS",
    ]);
  });

  test("入口の画面ショットの一覧：画像が実在し、メニューは2つ・囲みは1枚に2つずつ", () => {
    const shots = guideExport().ENTRANCE_SHOTS;
    expect(shots).toBe(ENTRANCE_SHOTS);
    expect(shots.map((shot) => shot.menu)).toEqual(["簡単ステップメニュー", "詳細メニュー"]);
    for (const shot of shots) {
      expect(existsSync(path.join(repositoryRoot, ...shot.file.split("/"))), shot.file).toBe(true);
      expect(shot.rings, shot.file).toHaveLength(2);
    }
  });

  test("渡す中身は一覧と同じ名前だけで、関数は関数・値は値", () => {
    const exported = guideExport();
    expect(Object.keys(exported).sort()).toEqual([...GUIDE_EXPORT_NAMES].sort());
    for (const name of ["menuPathsOf", "renderMenuPathText", "menuPathLine", "guideMenuEntries", "proceduresForMode", "renderProcedure", "procedureActionLookup"] as const) {
      expect(typeof exported[name], name).toBe("function");
    }
    expect(exported.MENU_PATH_START).toBe(MENU_PATH_START);
    expect(exported.PROCEDURES).toBe(PROCEDURES);
  });

  test("ボットの使い方の通しで、場所の図と手順書きが組める", () => {
    const exported = guideExport();
    const paths = exported.menuPathsOf("novelai.runProofreadingSuite", "author");
    expect(paths.length).toBeGreaterThan(0);
    expect(exported.menuPathLine(paths[0]!)).toContain(exported.MENU_PATH_START);
    expect(exported.renderMenuPathText("novelai.runProofreadingSuite", "author")).toContain(exported.MENU_PATH_START);
    expect(exported.guideMenuEntries("author").length).toBeGreaterThan(0);
    const polish = exported.proceduresForMode("author").find((procedure) => procedure.key === "polish");
    expect(polish).toBeDefined();
    const text = exported.renderProcedure(polish!, (command) => exported.procedureActionLookup(command, "author"));
    expect(text.length).toBeGreaterThan(0);
  });
});
