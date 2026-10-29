// エラーから文言を取り出す方法を1か所にそろえる（vscode にも node にも依存しない葉の部品）。
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
