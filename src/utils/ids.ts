export function slugify(value: string, maxLength = 48): string {
  const result = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return result || "investigation";
}

export function ticketBranch(issueKey: string, summary: string): string {
  return `bugfix/codex-${issueKey}-${slugify(summary)}`;
}
