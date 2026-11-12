import type { Encoding } from "./textDecode";
import { chooseUtf8Bom, type Utf8ConversionSkip } from "./sjisToUtf8";

/**
 * 「原稿を UTF-8 に変換」の、何話をどう変えるかの組み立て（設計書5.4.2、0.149.0）。
 * `vscode` に触らない（確かめの窓の文まで、ここで決めて単体テストで見る）。
 */

/** 作品の1話（か、知らせから名指しされた1ファイル）を読んだ結果 */
export interface Utf8Candidate {
  filePath: string;
  /** 作者に見せる名前（ファイル名） */
  name: string;
  /** 読めなかったファイルは undefined */
  encoding: Encoding | undefined;
  /** 変えられるか。読めなかったファイルは "read_failed" */
  plan: "convert" | Utf8ConversionSkip | "read_failed";
  /** 読んだときのハッシュ（書く直前の照合に使う） */
  hash: string;
  /** 開いたまま保存していない変更があるか */
  dirty: boolean;
  /** その話に効く設定 `files.encoding` が shiftjis か */
  settingShiftJis: boolean;
}

export interface Utf8ConvertTarget {
  filePath: string;
  name: string;
  hash: string;
  bom: boolean;
}

export interface Utf8ConvertPlanResult {
  targets: Utf8ConvertTarget[];
  /** Shift_JIS として読めないバイトがあるので飛ばす話 */
  undecodable: string[];
  /** 競合の印が残っているので飛ばす話 */
  conflicted: string[];
  /** 開いたまま保存していない変更があるので飛ばす話 */
  dirty: string[];
  /** 設定 files.encoding が shiftjis なので BOM を付ける話があるか */
  bomForSetting: boolean;
}

/** その範囲の Shift_JIS の話（変えられるもの・飛ばすもの）を数える */
export function shiftJisCandidates(candidates: readonly Utf8Candidate[]): Utf8Candidate[] {
  return candidates.filter((candidate) => candidate.encoding === "shift_jis");
}

/**
 * 変える話と飛ばす話を決める。`scope` の話だけを見る（「この話だけ」なら1つ）。
 *
 * BOM は**作品のほかの UTF-8 の話**に合わせる（範囲の外の話も数える）。設定が shiftjis の話は
 * 付ける（`chooseUtf8Bom`）。
 */
export function planUtf8Targets(
  all: readonly Utf8Candidate[],
  scope: readonly Utf8Candidate[]
): Utf8ConvertPlanResult {
  const others = all
    .map((candidate) => candidate.encoding)
    .filter((encoding): encoding is Encoding => encoding === "utf8" || encoding === "utf8-bom");
  const result: Utf8ConvertPlanResult = {
    targets: [],
    undecodable: [],
    conflicted: [],
    dirty: [],
    bomForSetting: false,
  };
  for (const candidate of shiftJisCandidates(scope)) {
    if (candidate.plan === "undecodable") {
      result.undecodable.push(candidate.name);
      continue;
    }
    if (candidate.plan === "conflict_markers") {
      result.conflicted.push(candidate.name);
      continue;
    }
    if (candidate.plan !== "convert") continue;
    if (candidate.dirty) {
      result.dirty.push(candidate.name);
      continue;
    }
    const bom = chooseUtf8Bom(others, candidate.settingShiftJis ? "shiftjis" : undefined);
    if (bom.reason === "setting_shiftjis") result.bomForSetting = true;
    result.targets.push({
      filePath: candidate.filePath,
      name: candidate.name,
      hash: candidate.hash,
      bom: bom.bom,
    });
  }
  return result;
}

/** 窓に並べる名前の数（何百話の作品で窓を埋めない） */
const NAMES_LIMIT = 15;

export function listNames(names: readonly string[]): string {
  const shown = names.slice(0, NAMES_LIMIT).map((name) => `・${name}`);
  if (names.length > NAMES_LIMIT) shown.push(`ほか${names.length - NAMES_LIMIT}話`);
  return shown.join("\n");
}

/** 確かめの窓の文（真ん中の窓。`detail` は詳しい欄） */
export function describeUtf8Confirm(plan: Utf8ConvertPlanResult): { message: string; detail: string } {
  const count = plan.targets.length;
  const withBom = plan.targets.filter((target) => target.bom).length;
  const message = `${count}話を Shift_JIS から UTF-8 に変換します。`;
  const lines: string[] = [listNames(plan.targets.map((target) => target.name))];
  lines.push(
    withBom === 0
      ? "BOM（先頭の印）は付けません。"
      : withBom === count
        ? "BOM（先頭の印）を付けます。"
        : `${withBom}話に BOM（先頭の印）を付けます。`
  );
  if (plan.bomForSetting) {
    lines.push(
      "設定「files.encoding」が shiftjis なので、BOM を付けます（付けないと、VS Code が Shift_JIS と読み違えて化けて開きます）。" +
        "設定はそのままにしています。"
    );
  }
  const skipped = describeSkipped(plan);
  if (skipped) lines.push(skipped);
  lines.push(
    "本文の字と改行はそのままです。変える前の原稿は控え（.novelai-recovery）に残ります。"
  );
  lines.push(
    "Shift_JIS でしか読めない道具で開いている場合は、その道具の設定も変えてください。" +
      "投稿サイトから Shift_JIS のファイルを落とし直して上書きすると、Shift_JIS に戻ります。"
  );
  return { message, detail: lines.join("\n\n") };
}

/** 飛ばす話の1行（無ければ空） */
export function describeSkipped(plan: Pick<Utf8ConvertPlanResult, "undecodable" | "conflicted" | "dirty">): string {
  const parts: string[] = [];
  if (plan.undecodable.length > 0) {
    parts.push(`Shift_JIS として読めないバイトがある${plan.undecodable.length}話（${plan.undecodable.join("、")}）`);
  }
  if (plan.conflicted.length > 0) {
    parts.push(`競合の印（<<<<<<<）が残っている${plan.conflicted.length}話（${plan.conflicted.join("、")}）`);
  }
  if (plan.dirty.length > 0) {
    parts.push(`保存していない変更がある${plan.dirty.length}話（${plan.dirty.join("、")}）`);
  }
  return parts.length > 0 ? `変えずに飛ばします：${parts.join("・")}。` : "";
}
