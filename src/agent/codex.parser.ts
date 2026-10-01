export function codexOutputToText(output: string): string {
  const messages: string[] = [];
  for (const line of output.split("\n")) {
    try {
      const value = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string }; delta?: string };
      if (typeof value.delta === "string") messages.push(value.delta);
      if (value.item?.type === "agent_message" && typeof value.item.text === "string") messages.push(value.item.text);
    } catch { /* retain non-JSON output below */ }
  }
  return messages.join("").trim() || output.trim();
}
