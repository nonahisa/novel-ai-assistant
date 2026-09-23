import type { WorkEntry } from "../models/types";
import { readPlotText } from "../core/plotFile";
import { isBlankPlotSection, parsePlotMarkdown } from "../core/plotDoc";
import { readWorkKind } from "../core/workKindStore";
import { workKindDef } from "../core/workKind";
import type { WorkProfile } from "../core/contestMatchText";
import { readSynopsisDoc } from "./generateBlurb";

/**
 * 公募と読み比べる作品の概要を集める（設計書6.3.6.4・6.3.6.5）。
 *
 * プロット（`設定/plot.md`）の形式・ジャンル・ログライン・あらすじ、
 * 作品紹介文（`設定/synopsis.md`）、作品の種類（6.109）。**本文は使わない**
 * ——応募先との合い方は「何を書いているか」で決まり、本文を送ると量も費用も増える。
 *
 * 書かれていない項目（テンプレートの案内だけ）は空にする。
 */
export async function readWorkProfile(work: WorkEntry): Promise<WorkProfile> {
  let sections: ReturnType<typeof parsePlotMarkdown>["sections"] | undefined;
  try {
    sections = parsePlotMarkdown(await readPlotText(work)).sections;
  } catch {
    // プロットが無くても、紹介文だけで比べられる
    sections = undefined;
  }
  let blurb = "";
  try {
    blurb = (await readSynopsisDoc(work)).blurb.trim();
  } catch {
    blurb = "";
  }
  let kind = "";
  try {
    kind = workKindDef(await readWorkKind(work)).label;
  } catch {
    kind = "";
  }
  return {
    title: work.title,
    kind,
    format: written(sections?.format),
    genre: written(sections?.genre),
    logline: written(sections?.logline),
    outline: written(sections?.outline),
    blurb,
  };
}

function written(body: string | undefined): string {
  if (!body || isBlankPlotSection(body)) return "";
  return body
    .replace(/<!--[\s\S]*?-->/gu, "")
    .trim();
}
