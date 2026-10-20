import { z } from "zod";

// Rescues a payload that was escaped twice ("Summary\\n\\nNext action"). Text that
// already contains a real line break was not, so its literal backslash escapes are
// content (shell blocks, Windows paths) and are left alone (MIK-743).
export function normalizeEscapedLineBreaks(value: string): string {
  if (/[\r\n]/.test(value)) return value;
  return value
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n");
}

export const multilineTextSchema = z.string().transform(normalizeEscapedLineBreaks);
