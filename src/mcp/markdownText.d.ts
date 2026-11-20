/**
 * MCP の束が埋め込む Markdown（esbuild の text loader。`esbuild.js` の mcp の束）。
 * 読み込むと、ファイルの中身がそのまま文字列で入る。
 */
declare module "*.md" {
  const text: string;
  export default text;
}
