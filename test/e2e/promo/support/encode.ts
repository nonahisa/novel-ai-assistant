/**
 * 録った動画（WebM）を、載せる先の形へ変える（設計書6.114）。
 *
 * - **GIF**：Marketplace の説明（README）に貼る。色の表（パレット）を先に作ってから
 *   変える2段にする——1段で変えると、白地に色の縞（ディザのむら）が出る
 * - **MP4**：X に載せる。H.264・yuv420p・1280×720・30fps（X が受け付ける形）
 *
 * ffmpeg は**道を台本に直書きしない。** 環境変数 `NOVELAI_FFMPEG` → PATH の
 * `ffmpeg` → winget の置き場（`%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*`）
 * の順に探す。winget で入れた直後は、開いているシェルの PATH にまだ載っていないため。
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** ffmpeg の道。見つからなければ undefined（変換を飛ばして WebM まで残す） */
export async function findFfmpeg(): Promise<string | undefined> {
  const fromEnv = process.env.NOVELAI_FFMPEG;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  try {
    const finder = process.platform === "win32" ? "where.exe" : "which";
    const { stdout } = await run(finder, ["ffmpeg"], { windowsHide: true });
    const first = stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
    if (first && existsSync(first)) return first;
  } catch {
    // PATH に無い
  }
  const local = process.env.LOCALAPPDATA;
  if (!local) return undefined;
  const packages = path.join(local, "Microsoft", "WinGet", "Packages");
  if (!existsSync(packages)) return undefined;
  for (const name of readdirSync(packages)) {
    if (!name.startsWith("Gyan.FFmpeg")) continue;
    const base = path.join(packages, name);
    // 中は `ffmpeg-<版>-full_build/bin/ffmpeg.exe` の形。版の名前は決め打ちしない
    for (const inner of readdirSync(base)) {
      const candidate = path.join(base, inner, "bin", "ffmpeg.exe");
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

async function ffmpeg(binary: string, args: readonly string[]): Promise<void> {
  await run(binary, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** 動画の長さ（秒）。ffprobe が隣に無ければ undefined */
export async function durationSeconds(ffmpegPath: string, file: string): Promise<number | undefined> {
  const probe = path.join(path.dirname(ffmpegPath), process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  if (!existsSync(probe)) return undefined;
  try {
    const { stdout } = await run(
      probe,
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file],
      { windowsHide: true }
    );
    const seconds = Number(stdout.trim());
    return Number.isFinite(seconds) ? seconds : undefined;
  } catch {
    return undefined;
  }
}

/**
 * WebM の頭 `startSeconds` 秒（起動と作品の登録が写っている所）を切って、MP4 にする。
 * GIF はこの MP4 から作る（切る位置を1か所で決めるため）
 */
export async function toMp4(
  binary: string,
  webm: string,
  mp4: string,
  startSeconds: number,
  lengthSeconds: number
): Promise<void> {
  await ffmpeg(binary, [
    "-ss",
    startSeconds.toFixed(2),
    "-t",
    lengthSeconds.toFixed(2),
    "-i",
    webm,
    "-vf",
    "fps=30,scale=1280:720:flags=lanczos,format=yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "20",
    "-movflags",
    "+faststart",
    "-an",
    mp4,
  ]);
}

/** GIF の目標の大きさ。Marketplace の説明で重くならないよう 5MB まで */
const GIF_BUDGET_BYTES = 5 * 1024 * 1024;

/**
 * MP4 から GIF を作る。**5MB を超えたら、こま数と幅を落として作り直す**
 * （15fps・800px から 8fps・720px まで、下の段の順）。最後の段でも超えたら、そのまま残す
 */
export async function toGif(
  binary: string,
  mp4: string,
  gif: string
): Promise<{ fps: number; width: number; bytes: number }> {
  const palette = gif.replace(/\.gif$/i, ".palette.png");
  // **幅よりこま数を先に守る。** 矢印のカーソルや星は動きが速く、こま数が少ないとカクつく。
  // 動かない画面の上で小さな物が動く絵なので、こま数を上げても大きさはあまり増えない
  const steps = [
    { fps: 15, width: 800 },
    { fps: 12, width: 800 },
    { fps: 12, width: 720 },
    { fps: 10, width: 800 },
    { fps: 10, width: 720 },
    { fps: 8, width: 720 },
  ];
  let last = { fps: 0, width: 0, bytes: 0 };
  for (const step of steps) {
    const scale = `fps=${step.fps},scale=${step.width}:-1:flags=lanczos`;
    await ffmpeg(binary, ["-i", mp4, "-vf", `${scale},palettegen=stats_mode=diff`, palette]);
    await ffmpeg(binary, [
      "-i",
      mp4,
      "-i",
      palette,
      "-lavfi",
      `${scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
      gif,
    ]);
    last = { ...step, bytes: statSync(gif).size };
    if (last.bytes <= GIF_BUDGET_BYTES) break;
  }
  await rm(palette, { force: true });
  return last;
}
