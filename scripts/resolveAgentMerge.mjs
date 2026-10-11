/**
 * 担当の枝を main へ合わせたときの、版まわりのぶつかりを解く（作者の指示、2026-10-11）。
 *
 * 担当はみな版を上げるので、合流のたびに同じ6か所と CHANGELOG と引継ぎ書の
 * 版の表がぶつかる。使い捨ての台本で解いていたが、次の2つを起こした。
 *
 *   1. 版の表（`docs/進捗と引継ぎ.md` の「| 版 |」の行）を枝の側（theirs）で
 *      丸ごと取ったため、GitHub Release・Marketplace の欄が古い値に戻った
 *      （本体の側のほうが新しいことがある。2回）
 *   2. 解けない塊を「両方残す」で連結したため、同じ行の古い形と訂正つきの形が
 *      両方残り、訂正つきの行が別の節の後ろに入った
 *
 * ## 決まり
 *
 * - 版の行は、**版の数字の出現ごとに大きいほうを取る**（日付は新しいほう）。
 *   版の表の行だけは欄（手元／GitHub Release／Marketplace）ごとに、版の大きい
 *   側の欄を丸ごと取って組み立て直す（欄の注記は版と一緒に動くため）
 * - CHANGELOG は、両方の項を版の新しい順に並べる。同じ版が両側にあって中身が
 *   違うなら解かない（2つの担当が同じ版を使った事故なので、人が見る）
 * - **それ以外の塊は解かない。** 塊はファイルにそのまま残し、一覧を出して
 *   終了コード1で止める。「両方残す」はしない
 * - 解けた塊だけを書き戻す。`git add` はしない（人が中身を見てから足す）
 * - 残りが無ければ、6か所の版がそろっているかと、版の表の3つの欄が本体・枝の
 *   どちらよりも下がっていないかを表示する
 *
 * ## 使い方
 *
 *   node scripts/resolveAgentMerge.mjs            いまぶつかっているファイルを git から拾う
 *   node scripts/resolveAgentMerge.mjs a.md b.json  指定したファイルだけ
 *
 * 判定は純粋な関数に分けてある（`test/unit/cross/resolveAgentMerge.test.ts`）。
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

// ── 版の数字 ──────────────────────────────────────────

const VERSION_RE = /v?\d+\.\d+\.\d+/g;
const DATE_RE = /\d{4}-\d{2}-\d{2}/g;

/** 版を数で比べる（文字列で比べると 0.99.0 が 0.103.0 より大きくなる） */
export function compareVersions(a, b) {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function firstVersion(text) {
  const match = text.match(/v?\d+\.\d+\.\d+/);
  return match ? match[0] : undefined;
}

// ── 塊を読む ──────────────────────────────────────────

/**
 * 競合マーカーで区切る。行の終わり（LF／CRLF）は読んだまま持つ。
 *
 * @returns 区切り。`{ kind: "text", text }` と
 *   `{ kind: "hunk", ours, theirs, base, raw, line }`（`line` は `<<<<<<<` の行番号、1始まり）
 */
export function splitConflicts(source) {
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const parts = [];
  let text = "";
  let hunk;
  let section = "";
  lines.forEach((line, index) => {
    const body = line.replace(/\r?\n$/, "");
    if (!hunk && /^<{7}( |$)/.test(body)) {
      if (text) parts.push({ kind: "text", text });
      text = "";
      hunk = { kind: "hunk", ours: "", theirs: "", base: undefined, raw: line, line: index + 1 };
      section = "ours";
      return;
    }
    if (hunk) {
      hunk.raw += line;
      if (/^\|{7}( |$)/.test(body) && section === "ours") {
        hunk.base = "";
        section = "base";
      } else if (/^={7}$/.test(body) && section !== "theirs") {
        section = "theirs";
      } else if (/^>{7}( |$)/.test(body) && section === "theirs") {
        parts.push(hunk);
        hunk = undefined;
      } else if (section === "base") {
        hunk.base += line;
      } else {
        hunk[section] += line;
      }
      return;
    }
    text += line;
  });
  // 閉じていない塊は解かずに、読んだまま残す
  if (hunk) text += hunk.raw;
  if (text) parts.push({ kind: "text", text });
  return parts;
}

function linesOf(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function eolOf(line) {
  const match = line.match(/\r?\n$/);
  return match ? match[0] : "";
}

// ── 版の行 ────────────────────────────────────────────

/**
 * その行が、そのファイルで版として扱ってよい行か。
 *
 * **決まった行だけにする。** 設計書の本文や依存の版まで「大きいほう」で
 * 解くと、別の意味の数字を黙って書き換える。
 *
 * @param lineNo ファイルの中の行番号（1始まり）。lock の依存の版と見分けるのに使う
 */
export function isVersionLine(file, line, lineNo) {
  const name = normalizeName(file);
  const body = line.replace(/\r?\n$/, "");
  switch (name) {
    case "package.json":
      return /^\s*"version": "[^"]+",?\s*$/.test(body);
    case "package-lock.json":
      // 自分の版は先頭（3行目と9行目）にだけある。下は依存の版なので触らない
      return lineNo <= 20 && /^\s*"version": "[^"]+",?\s*$/.test(body);
    case "README.md":
      return body.includes("このリポジトリの版");
    case "docs/設計書.md":
      return /^version \S+ \/ \d{4}-\d{2}-\d{2}\s*$/.test(body);
    case "docs/プロンプト設計書.md":
      return (
        /^version \S+ \/ \d{4}-\d{2}-\d{2}\s*$/.test(body) ||
        /^（対象：`docs\/設計書\.md` version \S+）\s*$/.test(body)
      );
    case "src/mcp/version.ts":
      return /^export const SERVER_VERSION = "[^"]+";\s*$/.test(body);
    case "docs/進捗と引継ぎ.md":
      return isVersionTableRow(body);
    default:
      return false;
  }
}

function normalizeName(file) {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** 引継ぎ書の「いまの状態」の版の行（古い記録の表の「| 版 |」は（手元）を持たない） */
export function isVersionTableRow(body) {
  return /^\| 版 \| /.test(body) && body.includes("（手元）");
}

/**
 * 版の数字と日付だけが違う2行を、出現ごとに大きいほう・新しいほうで組み立てる。
 *
 * @returns 組み立てた行。数字と日付以外も違えば undefined（解かない）
 */
export function mergeVersionLine(ours, theirs) {
  const eol = eolOf(ours) || eolOf(theirs);
  const a = ours.replace(/\r?\n$/, "");
  const b = theirs.replace(/\r?\n$/, "");
  if (isVersionTableRow(a) && isVersionTableRow(b)) {
    const row = mergeVersionTableRow(a, b);
    return row === undefined ? undefined : row + eol;
  }
  const mask = (text) => text.replace(VERSION_RE, "\u0001").replace(DATE_RE, "\u0002");
  if (mask(a) !== mask(b)) return undefined;
  const versionsB = b.match(VERSION_RE) ?? [];
  const datesB = b.match(DATE_RE) ?? [];
  let vi = 0;
  let di = 0;
  // 版の数字と日付を、出現の順にもう一方と比べて置き換える
  const merged = a.replace(new RegExp(`${VERSION_RE.source}|${DATE_RE.source}`, "g"), (token) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(token)) {
      const other = datesB[di++] ?? token;
      return other > token ? other : token;
    }
    const other = versionsB[vi++] ?? token;
    return compareVersions(other, token) > 0 ? other : token;
  });
  return merged + eol;
}

/** 版の表の行の欄の名前。並びは「手元 ／ GitHub Release ／ Marketplace」 */
function cellKind(segment, index) {
  if (segment.includes("GitHub Release")) return "release";
  if (segment.includes("Marketplace")) return "marketplace";
  if (index === 0 && segment.includes("（手元）")) return "local";
  return undefined;
}

/**
 * 版の表の行を欄ごとに組み立て直す。
 *
 * **欄ごとに、版の大きい側の欄を丸ごと取る**（同じ版なら本体の側）。
 * 手元の版は枝の側が新しく、GitHub Release・Marketplace は本体の側が
 * 新しいことがあるため、行ごとにどちらかを取ると必ずどれかの欄が下がる。
 */
export function mergeVersionTableRow(ours, theirs) {
  const split = (row) => row.split("／");
  const a = split(ours);
  const b = split(theirs);
  if (a.length !== b.length) return undefined;
  const out = [];
  for (let i = 0; i < a.length; i += 1) {
    const kind = cellKind(a[i], i);
    if (kind === undefined || cellKind(b[i], i) !== kind) return undefined;
    const va = firstVersion(a[i]);
    const vb = firstVersion(b[i]);
    if (!va || !vb) return undefined;
    out.push(compareVersions(vb, va) > 0 ? b[i] : a[i]);
  }
  return out.join("／");
}

/** 版の表の行から3つの欄の版を読む */
export function readVersionTable(row) {
  const result = {};
  row.split("／").forEach((segment, index) => {
    const kind = cellKind(segment, index);
    const version = firstVersion(segment);
    if (kind && version) result[kind] = version.replace(/^v/, "");
  });
  return result;
}

// ── CHANGELOG ─────────────────────────────────────────

/** `## 版` で始まる項に分ける。項の前に何かあれば undefined（解かない） */
function changelogEntries(text) {
  const lines = linesOf(text);
  const entries = [];
  for (const line of lines) {
    if (/^## /.test(line)) {
      entries.push({ heading: line, text: line });
    } else if (entries.length === 0) {
      if (line.trim() !== "") return undefined;
    } else {
      entries[entries.length - 1].text += line;
    }
  }
  return entries;
}

/**
 * CHANGELOG の塊を、両方の項を版の新しい順に並べて解く。
 *
 * @returns 解いた文。解けなければ `{ reason }`
 */
export function mergeChangelogHunk(ours, theirs) {
  const a = changelogEntries(ours);
  const b = changelogEntries(theirs);
  if (!a || !b || a.length === 0 || b.length === 0) {
    return { reason: "項（## 版）の途中で分かれている" };
  }
  const eol = eolOf(ours) || eolOf(theirs) || "\n";
  const trim = (text) => text.replace(/(\r?\n)+$/, "");
  const byVersion = new Map();
  for (const entry of [...a, ...b]) {
    const version = firstVersion(entry.heading);
    if (!version) return { reason: `版の読めない見出し：${trim(entry.heading)}` };
    const known = byVersion.get(version);
    if (known !== undefined && trim(known) !== trim(entry.text)) {
      return { reason: `同じ版 ${version} の項が両方にあり、中身が違う` };
    }
    byVersion.set(version, entry.text);
  }
  const sorted = [...byVersion.entries()].sort((x, y) => compareVersions(y[0], x[0]));
  // 項のあいだは空行1つ。塊の終わりは本体の側の終わり方にそろえる
  // （後ろに続く文が空行で始まるかどうかは、本体の側の形が知っている）
  const body = sorted.map(([, text]) => trim(text)).join(eol + eol);
  const endsBlank = /\r?\n\r?\n$/.test(ours);
  return { text: body + eol + (endsBlank ? eol : "") };
}

// ── 1つのファイル ─────────────────────────────────────

/**
 * 1つのファイルの塊を解く。
 *
 * @returns `{ text, resolved, unresolved }`。`unresolved` は
 *   `{ line, reason, ours, theirs }`（ours・theirs は先頭の1行）。
 *   解けない塊は `text` にマーカーごと残る
 */
export function resolveFile(file, source) {
  const name = normalizeName(file);
  const parts = splitConflicts(source);
  let text = "";
  let resolved = 0;
  const unresolved = [];
  const head = (side) => (linesOf(side)[0] ?? "").replace(/\r?\n$/, "");
  for (const part of parts) {
    if (part.kind === "text") {
      text += part.text;
      continue;
    }
    const outcome = resolveHunk(name, part);
    if (outcome.text !== undefined) {
      text += outcome.text;
      resolved += 1;
    } else {
      text += part.raw;
      unresolved.push({
        line: part.line,
        reason: outcome.reason,
        ours: head(part.ours),
        theirs: head(part.theirs),
      });
    }
  }
  return { text, resolved, unresolved };
}

function resolveHunk(name, hunk) {
  if (hunk.base !== undefined) {
    return { reason: "元の形つき（diff3）の塊は読まない" };
  }
  if (path.posix.basename(name) === "CHANGELOG.md") {
    return mergeChangelogHunk(hunk.ours, hunk.theirs);
  }
  const a = linesOf(hunk.ours);
  const b = linesOf(hunk.theirs);
  if (a.length === 0 || a.length !== b.length) {
    return { reason: "版の行だけの塊ではない" };
  }
  let out = "";
  for (let i = 0; i < a.length; i += 1) {
    // ours の行番号は、マーカーの次の行から数える
    const lineNo = hunk.line + 1 + i;
    if (!isVersionLine(name, a[i], lineNo) || !isVersionLine(name, b[i], lineNo)) {
      return { reason: "版の行だけの塊ではない" };
    }
    const merged = mergeVersionLine(a[i], b[i]);
    if (merged === undefined) return { reason: "版の数字のほかにも違いがある" };
    out += merged;
  }
  return { text: out };
}

// ── 合わせたあとの点検 ───────────────────────────────

/**
 * 6か所（と CHANGELOG・版の表）の版を読む。読めなかった所は undefined。
 *
 * @param read 相対パスを受けて中身を返す（無ければ undefined）
 */
export function readSixVersions(read) {
  const pick = (file, re) => {
    const text = read(file);
    if (text === undefined) return undefined;
    const match = text.match(re);
    return match ? match[1] : undefined;
  };
  const table = (() => {
    const text = read("docs/進捗と引継ぎ.md");
    const row = text?.split(/\r?\n/).find(isVersionTableRow);
    return row ? readVersionTable(row).local : undefined;
  })();
  return {
    "package.json": pick("package.json", /"version": "([^"]+)"/),
    "package-lock.json": pick("package-lock.json", /"version": "([^"]+)"/),
    "package-lock.json（packages の \"\"）": pick(
      "package-lock.json",
      /"": \{\s*"name": "[^"]*",\s*"version": "([^"]+)"/
    ),
    CHANGELOG: pick("CHANGELOG.md", /^## (\d+\.\d+\.\d+)/m),
    README: pick("README.md", /このリポジトリの版：\*\*(\d+\.\d+\.\d+)\*\*/),
    設計書: pick("docs/設計書.md", /^version (\d+\.\d+\.\d+)/m),
    プロンプト設計書: pick("docs/プロンプト設計書.md", /^version (\d+\.\d+\.\d+)/m),
    "プロンプト設計書（対象）": pick(
      "docs/プロンプト設計書.md",
      /^（対象：`docs\/設計書\.md` version (\d+\.\d+\.\d+)）/m
    ),
    SERVER_VERSION: pick("src/mcp/version.ts", /SERVER_VERSION = "([^"]+)"/),
    引継ぎ書の版の表: table,
  };
}

/**
 * 版の表の3つの欄が、合わせる前のどちらの側よりも下がっていないか。
 *
 * @param merged 合わせたあとの行
 * @param before 合わせる前の行（本体・枝。無いものは省く）
 * @returns 下がった欄の説明。無ければ空
 */
export function tableRegressions(merged, before) {
  const now = readVersionTable(merged);
  const problems = [];
  for (const kind of ["local", "release", "marketplace"]) {
    const label = { local: "手元", release: "GitHub Release", marketplace: "Marketplace" }[kind];
    for (const row of before) {
      const was = readVersionTable(row)[kind];
      if (!was) continue;
      if (!now[kind]) {
        problems.push(`${label}の欄が読めない`);
        break;
      }
      if (compareVersions(now[kind], was) < 0) {
        problems.push(`${label} が ${was} から ${now[kind]} へ下がった`);
      }
    }
  }
  return problems;
}

// ── 走らせる ──────────────────────────────────────────

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gitOrUndefined(args, cwd) {
  try {
    return git(args, cwd);
  } catch {
    return undefined;
  }
}

function main(argv) {
  const root = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
  // 日本語のファイル名を逃がさずに受け取るため、NUL 区切りで読む
  const files =
    argv.length > 0
      ? argv.map((file) => normalizeName(path.relative(root, path.resolve(file))))
      : git(["diff", "--name-only", "--diff-filter=U", "-z"], root)
          .split("\u0000")
          .filter(Boolean);

  const out = [];
  const leftovers = [];
  for (const file of files) {
    const full = path.join(root, file);
    let source;
    try {
      source = fs.readFileSync(full, "utf8");
    } catch (error) {
      leftovers.push({ file, line: 0, reason: `読めない（${error.message}）`, ours: "", theirs: "" });
      continue;
    }
    const result = resolveFile(file, source);
    if (result.resolved > 0) {
      fs.writeFileSync(full, result.text, "utf8");
      out.push(`解いた：${file}（${result.resolved}か所）`);
    }
    for (const one of result.unresolved) leftovers.push({ file, ...one });
  }

  if (leftovers.length > 0) {
    out.push("", `解かずに残した塊：${leftovers.length}か所（人が見てください）`);
    for (const one of leftovers) {
      out.push(`  ${one.file}:${one.line}　${one.reason}`);
      out.push(`    本体：${one.ours}`);
      out.push(`    枝　：${one.theirs}`);
    }
    out.push("", "残りを直してから、もう一度走らせると版の点検をします。git add はしていません。");
    process.stdout.write(out.join("\n") + "\n");
    process.exitCode = 1;
    return;
  }

  const read = (file) => {
    try {
      return fs.readFileSync(path.join(root, file), "utf8");
    } catch {
      return undefined;
    }
  };
  const versions = readSixVersions(read);
  const values = Object.values(versions).filter(Boolean);
  const aligned = values.length === Object.keys(versions).length && new Set(values).size === 1;
  if (out.length > 0) out.push("");
  out.push(aligned ?`版はそろっています：${values[0]}` : "版がそろっていません：");
  if (!aligned) {
    for (const [where, version] of Object.entries(versions)) {
      out.push(`  ${where}：${version ?? "（読めない）"}`);
    }
  }

  const handover = "docs/進捗と引継ぎ.md";
  const mergedRow = read(handover)?.split(/\r?\n/).find(isVersionTableRow);
  const beforeRows = ["HEAD", "MERGE_HEAD"]
    .map((ref) => gitOrUndefined(["show", `${ref}:${handover}`], root))
    .map((text) => text?.split(/\r?\n/).find(isVersionTableRow))
    .filter(Boolean);
  if (mergedRow) {
    const table = readVersionTable(mergedRow);
    out.push(
      `版の表：手元 ${table.local ?? "?"} ／ GitHub Release ${table.release ?? "?"} ／ Marketplace ${table.marketplace ?? "?"}`
    );
    const problems = tableRegressions(mergedRow, beforeRows);
    out.push(problems.length > 0 ? `  下がった欄：${problems.join("、")}` : "  どの欄も下がっていません");
    if (problems.length > 0 || !aligned) process.exitCode = 1;
  } else {
    out.push("版の表の行が見つかりません");
    process.exitCode = 1;
  }
  process.stdout.write(out.join("\n") + "\n");
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) main(process.argv.slice(2));
