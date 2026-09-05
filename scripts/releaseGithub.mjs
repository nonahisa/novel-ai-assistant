// GitHub Release へVSIXを出す。
//
//   npm run release:github                 通常
//   npm run release:github -- --dry-run    実行するコマンドを表示するだけ
//   npm run release:github -- --skip-verify   verify:vsix を省く
//   npm run release:github -- --notes notes.md  ノートを手書きのものへ差し替える
//
// これまでGitHub Releaseは手で `gh release create` を叩いて作っていた
// （引継ぎ書のv0.26.0以降の記録）。**手順が人の記憶にしか無い**ので、
// 「タグを押し忘れる」「VSIXを検証せずに添付する」「SHA-256を控え忘れる」が
// 起きうる。ここへ手順として固定する。
//
// **Marketplace への公開（`publish:marketplace`）はここでは行わない。**
// 作者の明示指示が要る道なので、混ぜると事故になる。
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveReleaseMetadata, validatePublicText } from "./releaseSupport.mjs";
import { prepareReleaseNotes } from "./prepareReleaseNotes.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

/** gh が未ログインのときに出す案内。**推測せず、次に打つものを1つ示す。** */
const GH_LOGIN_HINT =
  "GitHub CLI（gh）が未ログインです。次のどちらかを行ってから、もう一度実行してください。\n" +
  "    1. `gh auth login`（対話。以後この機械に残ります）\n" +
  "    2. その場かぎりで通す場合は、GitHubのトークンを `GH_TOKEN` に入れて実行する\n" +
  "       （過去のリリースは `git credential fill` で取った認証を1回だけ渡していた）";

// ---------------------------------------------------------------------------
// 純粋関数。**外部コマンドを呼ぶ前の判断はすべてここへ寄せる**——
// gh や git を実際に動かさずに単体テストで確かめられるようにするため。
// ---------------------------------------------------------------------------

export function parseReleaseArguments(argv) {
  const options = { dryRun: false, skipVerify: false, notesPath: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--skip-verify") {
      options.skipVerify = true;
    } else if (argument === "--notes") {
      const value = argv[index + 1];
      // 次が別のフラグなら、ファイル名の指定を忘れている
      if (!value || value.startsWith("--")) {
        throw new Error("--notes にはリリースノートのファイルを渡してください。");
      }
      options.notesPath = value;
      index += 1;
    } else if (argument.startsWith("--notes=")) {
      const value = argument.slice("--notes=".length);
      if (!value) {
        throw new Error("--notes にはリリースノートのファイルを渡してください。");
      }
      options.notesPath = value;
    } else {
      throw new Error(
        `知らない引数です: ${argument}\n` +
          "  使える引数: --dry-run / --skip-verify / --notes <ファイル>"
      );
    }
  }
  return options;
}

/**
 * CHANGELOG.md から、その版の節の**中身**を取り出す。
 *
 * 見出し行（`## 0.33.10 - 2026-09-05`）は落とす。GitHubのリリースは
 * 題（`v0.33.10`）を別に持つので、同じ版番号が2度並ぶだけになるため。
 */
export function extractChangelogSection(changelogText, version) {
  const lines = changelogText.split(/\r?\n/);
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // `0.33.1` が `0.33.10` に当たらないよう、後ろに数字と点が続かないことを見る
  const headingPattern = new RegExp(`^##\\s+\\[?v?${escaped}\\]?(?![0-9.])`);
  const start = lines.findIndex((line) => headingPattern.test(line));
  if (start < 0) {
    throw new Error(`CHANGELOG.md に ${version} の節がありません。`);
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s/.test(lines[index])) {
      end = index;
      break;
    }
  }
  const body = lines.slice(start + 1, end).join("\n").trim();
  if (!body) {
    throw new Error(`CHANGELOG.md の ${version} の節が空です。`);
  }
  return body;
}

/**
 * 前提の確認。**満たさないものを全部並べる**——1つ直すたびに
 * 走らせ直して次の1つを知る、という往復を避けるため。
 */
export function evaluatePrerequisites(state) {
  const problems = [];
  const warnings = [];

  if (state.workingTreeStatus.trim() !== "") {
    problems.push(
      "作業ツリーに未コミットの変更があります。\n" +
        "  リリースは「いまpushされているもの」を配るので、先にコミットしてpushしてください。\n" +
        // 先頭の空白は `git status --porcelain` の状態欄なので落とさない
        `  未コミット:\n${indentLines(state.workingTreeStatus.replace(/\s+$/, ""), 4)}`
    );
  }

  if (state.currentBranch !== "main") {
    problems.push(
      `いまの枝は ${state.currentBranch} です。main へ切り替えてから実行してください。`
    );
  } else if (!state.remoteCommit) {
    problems.push(
      "origin/main が見つかりません。`git fetch origin` を先に実行してください。"
    );
  } else if (state.headCommit !== state.remoteCommit) {
    problems.push(
      "main が origin/main と一致していません（push が済んでいません）。\n" +
        `  手元: ${state.headCommit}\n  origin: ${state.remoteCommit}\n` +
        "  `git push origin main` を先に実行してください。"
    );
  }

  if (!state.ghAuthenticated) {
    // **--dry-run は表示するだけ**なので、ここで止めると手順の下見ができない
    (state.dryRun ? warnings : problems).push(state.ghAuthMessage ?? GH_LOGIN_HINT);
  }

  if (state.tagCommit && state.tagCommit !== state.headCommit) {
    problems.push(
      `タグ v${state.version} は既にあり、いまのコミットとは別のものを指しています。\n` +
        `  タグ: ${state.tagCommit}\n  手元: ${state.headCommit}\n` +
        "  版を上げ直すか、タグを付け替えてください（タグの付け替えは作者の判断で）。"
    );
  }

  return { problems, warnings, tagExists: Boolean(state.tagCommit) };
}

export function buildTagCommands(tag, message) {
  return [
    { command: "git", args: ["tag", "-a", tag, "-m", message] },
    { command: "git", args: ["push", "origin", tag] },
  ];
}

/**
 * リリースを作る／差し替えるコマンド。
 *
 * **`--target` は渡さない。** タグはこの前に push しているので不要で、
 * かつ短縮SHAを渡すと422で弾かれる（v0.26.0のときに踏んだ）。
 */
export function buildGithubReleaseCommands({
  tag,
  vsixPath,
  notesPath,
  releaseExists,
}) {
  if (releaseExists) {
    return [
      { command: "gh", args: ["release", "upload", tag, vsixPath, "--clobber"] },
      { command: "gh", args: ["release", "edit", tag, "--notes-file", notesPath] },
    ];
  }
  return [
    {
      command: "gh",
      args: [
        "release",
        "create",
        tag,
        vsixPath,
        "--title",
        tag,
        "--notes-file",
        notesPath,
      ],
    },
  ];
}

export function buildReleaseUrl(repositoryUrl, tag) {
  const base = String(repositoryUrl ?? "")
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  if (!base) {
    throw new Error("package.json の repository.url がありません。");
  }
  return `${base}/releases/tag/${tag}`;
}

/** 表示用。空白を含む引数だけ引用符で囲む（そのまま貼って動く形にする） */
export function formatCommand({ command, args }) {
  return [command, ...args]
    .map((token) => (/[\s"]/.test(token) ? `"${token.replace(/"/g, '\\"')}"` : token))
    .join(" ");
}

function indentLines(text, width) {
  const pad = " ".repeat(width);
  return text
    .split(/\r?\n/)
    .map((line) => `${pad}${line}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// ここから下は外部コマンドを呼ぶ側
// ---------------------------------------------------------------------------

/**
 * 外部コマンドの実行。**シェルは経由しない**（引数をそのまま渡す）。
 *
 * 例外は npm で、Windows では実体が `npm.cmd` である。Node 20以降は
 * `.cmd` をシェル無しで起動できない（CVE-2024-27980 の対策）ので、
 * npm を呼ぶときだけ `shell: true` にする。**渡す引数はこちらで書いた
 * 定数だけ**なので、シェルに解釈させて困るものは混ざらない。
 */
function run(command, args, { capture = false, allowFailure = false, shell = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
    shell,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    // 既定の1MBでは verify:vsix の出力で溢れる
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) {
    if (allowFailure) {
      return { ok: false, stdout: "", stderr: String(result.error.message) };
    }
    throw result.error;
  }
  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();
  if (result.status !== 0) {
    if (allowFailure) return { ok: false, stdout, stderr };
    throw new Error(
      `${command} ${args.join(" ")} が失敗しました (${result.status})\n${stderr || stdout}`
    );
  }
  return { ok: true, stdout, stderr };
}

function runNpm(args) {
  // シェルを使うときは**1本の文字列**にして渡す。配列のまま渡すと Node が
  // 「引数は引用されず連結されるだけ」と警告を出す（DEP0190）。
  // 連結して困るものは無い——ここで渡すのはこのファイルに書いた定数だけ
  if (process.platform === "win32") {
    return run(`npm ${args.join(" ")}`, [], { shell: true });
  }
  return run("npm", args);
}

function gitOutput(args) {
  const result = run("git", args, { capture: true, allowFailure: true });
  return result.ok ? result.stdout : "";
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * リリースノートを用意する。
 *
 * 優先順は「手書きの差し替え → `prepareReleaseNotes.mjs` → CHANGELOG」。
 * `prepareReleaseNotes.mjs` は `docs/releases/vX.Y.Z.md` を読む形で、
 * いまは v0.0.2 のぶんしか無い。**無いことは異常ではない**ので、
 * 落とさずCHANGELOGへ回す。
 */
async function resolveReleaseNotes({ version, tag, vsixPath, options, sha256 }) {
  if (options.notesPath) {
    const resolved = path.resolve(repositoryRoot, options.notesPath);
    if (!(await exists(resolved))) {
      throw new Error(`--notes で指定されたファイルがありません: ${resolved}`);
    }
    return { notesPath: resolved, source: "手書き（--notes）" };
  }

  try {
    const prepared = await prepareReleaseNotes(repositoryRoot);
    return {
      notesPath: prepared.generatedNotesPath,
      source: "docs/releases（prepareReleaseNotes.mjs）",
    };
  } catch (error) {
    console.log(
      `  prepareReleaseNotes.mjs は使えませんでした（${error.message}）。CHANGELOG.md から作ります。`
    );
  }

  const changelog = await readFile(path.join(repositoryRoot, "CHANGELOG.md"), "utf8");
  const body = extractChangelogSection(changelog, version);
  // 配布物と同じ検査を通す。**手元のパスや鍵が公開ページへ出るのを防ぐ**
  validatePublicText(body, "Release notes");
  const notesPath = path.join(repositoryRoot, "release", `${tag}-notes.md`);
  if (options.dryRun) {
    console.log(`  （--dry-run のため書き出しません: ${notesPath}）`);
    return { notesPath, source: "CHANGELOG.md" };
  }
  await writeFile(
    notesPath,
    sha256 ? `${body}\n\nSHA-256: ${sha256}\n` : `${body}\n`,
    "utf8"
  );
  return { notesPath, source: "CHANGELOG.md" };
}

async function main() {
  const options = parseReleaseArguments(process.argv.slice(2));
  const { rootManifest, vsixPath, assetName } =
    await deriveReleaseMetadata(repositoryRoot);
  const version = rootManifest.version;
  const tag = `v${version}`;

  console.log(`GitHub Release ${tag} を用意します（${assetName}）。`);
  if (options.dryRun) console.log("--dry-run：実行するコマンドを表示するだけです。\n");

  // --- 1. 前提の確認 -------------------------------------------------------
  const ghAuth = run("gh", ["auth", "status"], {
    capture: true,
    allowFailure: true,
  });
  const evaluation = evaluatePrerequisites({
    workingTreeStatus: gitOutput(["status", "--porcelain"]),
    currentBranch: gitOutput(["rev-parse", "--abbrev-ref", "HEAD"]),
    headCommit: gitOutput(["rev-parse", "HEAD"]),
    remoteCommit: gitOutput(["rev-parse", "origin/main"]),
    tagCommit: gitOutput(["rev-list", "-n", "1", tag]),
    ghAuthenticated: ghAuth.ok,
    ghAuthMessage: GH_LOGIN_HINT,
    version,
    dryRun: options.dryRun,
  });

  for (const warning of evaluation.warnings) console.warn(`⚠ ${warning}\n`);
  if (evaluation.problems.length > 0) {
    console.error("\nGitHub Release を作れません。\n");
    for (const problem of evaluation.problems) console.error(`- ${problem}\n`);
    process.exitCode = 1;
    return;
  }

  // --- 2. VSIX の用意と検証 ------------------------------------------------
  const hasVsix = await exists(vsixPath);
  if (!hasVsix) {
    const command = { command: "npm", args: ["run", "package:vsix"] };
    console.log(`\nVSIXがありません: ${vsixPath}`);
    console.log(`  ${formatCommand(command)}`);
    if (!options.dryRun) runNpm(command.args);
  } else {
    console.log(`\nVSIX: ${vsixPath}`);
  }
  if (options.skipVerify) {
    console.log("  --skip-verify のため verify:vsix は省きます。");
  } else {
    const command = { command: "npm", args: ["run", "verify:vsix"] };
    console.log(`  ${formatCommand(command)}`);
    if (!options.dryRun) runNpm(command.args);
  }

  // VSIXのバイト列から直に取る。**verify:vsix が表示するものと同じ値**で、
  // 標準出力を読み取るより取り違えが起きない
  const sha256 = (await exists(vsixPath))
    ? createHash("sha256").update(await readFile(vsixPath)).digest("hex")
    : undefined;

  // --- 3. リリースノート ---------------------------------------------------
  console.log("\nリリースノート:");
  const notes = await resolveReleaseNotes({
    version,
    tag,
    vsixPath,
    options,
    sha256,
  });
  console.log(`  ${notes.notesPath}（出どころ: ${notes.source}）`);

  // --- 4. タグ -------------------------------------------------------------
  console.log("\nタグ:");
  if (evaluation.tagExists) {
    console.log(`  ${tag} は既にあり、いまのコミットを指しています。作り直しません。`);
  } else {
    for (const command of buildTagCommands(tag, `${rootManifest.displayName ?? rootManifest.name} ${tag}`)) {
      console.log(`  ${formatCommand(command)}`);
      if (!options.dryRun) run(command.command, command.args);
    }
  }

  // --- 5. リリース ---------------------------------------------------------
  const releaseExists = options.dryRun
    ? false
    : run("gh", ["release", "view", tag, "--json", "tagName"], {
        capture: true,
        allowFailure: true,
      }).ok;
  console.log("\nリリース:");
  if (options.dryRun) {
    console.log("  （--dry-run のため既存リリースの有無は調べていません。無い前提の表示です）");
    console.log(`  ${formatCommand({ command: "gh", args: ["release", "view", tag, "--json", "tagName"] })}`);
  }
  for (const command of buildGithubReleaseCommands({
    tag,
    vsixPath,
    notesPath: notes.notesPath,
    releaseExists,
  })) {
    console.log(`  ${formatCommand(command)}`);
    if (!options.dryRun) run(command.command, command.args);
  }

  // --- 6. 控えるべき値 -----------------------------------------------------
  console.log("\n--- 引継ぎ書へ控える値 ---");
  console.log(`URL: ${buildReleaseUrl(rootManifest.repository?.url, tag)}`);
  console.log(`VSIX: ${assetName}`);
  console.log(`SHA-256: ${sha256 ?? "（VSIXが未作成のため未算出）"}`);
}

// テストからは純粋関数だけを読む。**読み込んだだけで gh や git が動かない**ようにする
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    console.error(`\n${error.message}\n`);
    process.exitCode = 1;
  }
}
