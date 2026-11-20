// GitHub Release に添える「更新の札」update.json を作る（設計書5.11）。
//
//   node scripts/buildUpdateManifest.mjs --notes <Release ノート>
//   node scripts/buildUpdateManifest.mjs --notes <ノート> --versions 1.0.31,1.0.32
//
// 札の形は全製品の共通の決まり（docs/更新の仕組み_共通.md の2章）。
// 統合は Marketplace・Open VSX が自分で更新するので、この札は**ほかの製品
// （Discord のボットなど）が統合の新しい版を知る口**として置く。拡張機能の
// 本体は札を読まない。
//
// 札の SHA-256 は Release ノートの末尾の `SHA-256：…` と同じ値にする決まり
// （共通の決まり2）。**VSIX の実バイトから算出し、ノートと照らして違えば止める**
// ——ノートの写し間違いのまま札を出すと、札を読む側が正しい VSIX を
// 「照合に失敗した」と捨てることになるため。
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveReleaseMetadata, validatePublicText } from "./releaseSupport.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

/** 札を読む側が製品を見分ける英字の名前（共通の決まり2章） */
export const PRODUCT_ID = "novel-ai-assistant";

/**
 * 添付の platform。VSIX は OS を問わず1つなので、OS の名前ではなく
 * 「VS Code の拡張機能」を表す値にする（Open VSX を読むエディターでも同じ VSIX）。
 */
export const VSIX_PLATFORM = "vscode";

/** Release に添える名前。固定にして `releases/latest/download/update.json` を口にする */
export const MANIFEST_FILE_NAME = "update.json";

// ---------------------------------------------------------------------------
// 純粋関数（外のコマンドもファイルも触らない。単体テストはここだけを見る）
// ---------------------------------------------------------------------------

export function parseManifestArguments(argv) {
  const options = { notesPath: undefined, versions: [], vsixPath: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [name, inlineValue] = argument.includes("=")
      ? [argument.slice(0, argument.indexOf("=")), argument.slice(argument.indexOf("=") + 1)]
      : [argument, undefined];
    if (!["--notes", "--versions", "--vsix"].includes(name)) {
      throw new Error(
        `知らない引数です: ${argument}\n` +
          "  使える引数: --notes <ファイル> / --versions <版,版> / --vsix <ファイル>"
      );
    }
    let value = inlineValue;
    if (value === undefined) {
      value = argv[index + 1];
      index += 1;
    }
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} の値がありません。`);
    }
    if (name === "--notes") options.notesPath = value;
    if (name === "--vsix") options.vsixPath = value;
    if (name === "--versions") {
      options.versions = value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    }
  }
  return options;
}

function escapeVersion(version) {
  return version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * CHANGELOG のその版の節から、日付と、要約に使う箇条書きを取り出す。
 *
 * 節は「- 直したこと」の下に字下げした「  - 文」を並べる形。**分類の行
 * （直したこと・足したこと）は要約に入れず、下の文だけを取る**。字下げの
 * 無い古い形（「- 文」だけ）では、その行をそのまま取る。
 *
 * 文は**一字も変えない**。CHANGELOG の新しい版の項目は yomiyasu を通して
 * あるので、ここで縮めたり言い換えたりすると、通したことにならなくなる。
 */
export function extractChangelogEntry(changelogText, version) {
  const lines = changelogText.split(/\r?\n/);
  // `1.0.3` が `1.0.33` に当たらないよう、後ろに数字と点が続かないことを見る
  const headingPattern = new RegExp(
    `^##\\s+\\[?v?${escapeVersion(version)}\\]?(?![0-9.])(?:\\s*-\\s*(\\d{4}-\\d{2}-\\d{2}))?`
  );
  const start = lines.findIndex((line) => headingPattern.test(line));
  if (start < 0) {
    throw new Error(`CHANGELOG.md に ${version} の節がありません。`);
  }
  const date = lines[start].match(headingPattern)?.[1];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s/.test(lines[index])) {
      end = index;
      break;
    }
  }

  const bullets = [];
  for (const line of lines.slice(start + 1, end)) {
    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) {
      bullets.push({ indent: bullet[1].length, text: bullet[2].trim() });
    } else if (line.trim() !== "" && bullets.length > 0) {
      // 箇条書きの折り返し。前の行の続きとしてつなぐ
      bullets[bullets.length - 1].text += line.trim();
    }
  }
  // 次の行のほうが深く字下げされていれば、その行は分類の見出し
  const items = bullets
    .filter((bullet, index) => !(bullets[index + 1]?.indent > bullet.indent))
    .map((bullet) => bullet.text)
    .filter(Boolean);
  if (items.length === 0) {
    throw new Error(`CHANGELOG.md の ${version} の節に箇条書きがありません。`);
  }
  return { date, items };
}

/** ノートの末尾の `SHA-256：<64桁>`（全角・半角のコロンとも）を読む。無ければ undefined */
export function readNotesSha256(notesText) {
  const matches = [...notesText.matchAll(/SHA-256\s*[：:]\s*([0-9a-fA-F]{64})(?![0-9a-fA-F])/g)];
  return matches.length > 0 ? matches[matches.length - 1][1].toLowerCase() : undefined;
}

export function buildDownloadUrl(repositoryUrl, tag, assetName) {
  const base = String(repositoryUrl ?? "")
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(base)) {
    throw new Error(`package.json の repository.url が GitHub のリポジトリではありません: ${repositoryUrl}`);
  }
  return `${base}/releases/download/${tag}/${encodeURIComponent(assetName)}`;
}

/**
 * 札を組み立てる。
 *
 * `versions` は要約に入れる版。Release が前の版の分も含むとき
 * （1.0.32 が 1.0.31 の分も含んだように）に、新しい版から順に並べる。
 */
export function buildUpdateManifest({
  changelogText,
  version,
  versions = [],
  repositoryUrl,
  assetName,
  sha256,
  bytes,
  notesSha256,
}) {
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error("VSIX の SHA-256 が64桁の16進数ではありません。");
  }
  if (notesSha256 !== undefined && notesSha256 !== sha256) {
    throw new Error(
      "Release ノートの SHA-256 が VSIX と合いません。\n" +
        `  ノート: ${notesSha256}\n  VSIX:   ${sha256}\n` +
        "  ノートの末尾を VSIX の値に直してから、もう一度実行してください。"
    );
  }
  const ordered = [version, ...versions.filter((entry) => entry !== version)];
  const entries = ordered.map((entry) => extractChangelogEntry(changelogText, entry));
  const summary = entries.flatMap((entry) => entry.items);
  for (const line of summary) {
    // 配布物と同じ検査。手元のパスや鍵が公開の札へ出るのを防ぐ
    validatePublicText(line, "Update summary");
  }
  const date = entries[0].date;
  if (!date) {
    throw new Error(`CHANGELOG.md の ${version} の見出しに日付がありません（「## ${version} - 2026-11-20」の形）。`);
  }
  const tag = `v${version}`;
  return {
    product: PRODUCT_ID,
    version,
    date,
    summary,
    assets: [
      {
        platform: VSIX_PLATFORM,
        name: assetName,
        url: buildDownloadUrl(repositoryUrl, tag, assetName),
        sha256,
        bytes,
      },
    ],
    minimumFrom: null,
  };
}

export function formatUpdateManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// ここから下はファイルを読む・書く側
// ---------------------------------------------------------------------------

async function main() {
  const options = parseManifestArguments(process.argv.slice(2));
  const { rootManifest, vsixPath: defaultVsixPath, assetName } =
    await deriveReleaseMetadata(repositoryRoot);
  const version = rootManifest.version;
  const vsixPath = options.vsixPath
    ? path.resolve(repositoryRoot, options.vsixPath)
    : defaultVsixPath;
  if (path.basename(vsixPath) !== assetName) {
    // 公開の手順（publish-marketplace.yml）は名前で VSIX を取り寄せる。名前がずれた
    // VSIX を指す札を出すと、札と Release の添付が食い違う
    throw new Error(`VSIX の名前が ${assetName} ではありません: ${vsixPath}`);
  }
  const vsixBytes = await readFile(vsixPath);
  const sha256 = createHash("sha256").update(vsixBytes).digest("hex");

  let notesSha256;
  if (options.notesPath) {
    const notesText = await readFile(path.resolve(repositoryRoot, options.notesPath), "utf8");
    notesSha256 = readNotesSha256(notesText);
    if (notesSha256 === undefined) {
      throw new Error(`Release ノートに「SHA-256：<64桁>」の行がありません: ${options.notesPath}`);
    }
  } else {
    console.warn("⚠ --notes が無いので、ノートの SHA-256 とは照らしていません。");
  }

  const manifest = buildUpdateManifest({
    changelogText: await readFile(path.join(repositoryRoot, "CHANGELOG.md"), "utf8"),
    version,
    versions: options.versions,
    repositoryUrl: rootManifest.repository?.url,
    assetName,
    sha256,
    bytes: vsixBytes.length,
    notesSha256,
  });

  const outPath = path.join(repositoryRoot, "release", MANIFEST_FILE_NAME);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, formatUpdateManifest(manifest), "utf8");
  console.log(`更新の札を書きました: ${outPath}`);
  console.log(`  版 ${manifest.version}（${manifest.date}）・要約 ${manifest.summary.length} 行・SHA-256 ${sha256}`);
  // Release は出したあとで添付を足せない設定（2026-11-20、v1.0.33 で HTTP 422）。
  // 作るときに一緒に添える道だけを示す
  console.log("Release を作るときに、gh release create の添付に足してください:");
  console.log(`  release/${MANIFEST_FILE_NAME}`);
}

// テストからは純粋関数だけを読む。読み込んだだけでファイルを書かないようにする
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`\n${error.message}\n`);
    process.exitCode = 1;
  }
}
