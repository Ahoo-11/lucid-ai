// Incremental transcript upload. Each file's progress (lines and bytes sent)
// is kept in ~/.lucid/cursors.json so a hook only reads what was appended
// since the last one. The server also tracks lines per file and skips repeats,
// so concurrent hooks or a lost cursor file never duplicate data.

import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { LUCID_HOME, postJson, readJson, writeJson } from "./config";

const CURSORS = join(LUCID_HOME, "cursors.json");
const MAX_LINES = 400;
const MAX_BYTES = 3 * 1024 * 1024;

type Cursor = { lines: number; bytes: number };
type Target = { endpoint: string; apiKey?: string };

export type TranscriptFile = {
  path: string;
  fileKey: string;
  file: { kind: "main" | "subagent"; agentId?: string; parentToolUseId?: string; agentType?: string; description?: string };
};

const loadCursors = () => readJson<Record<string, Cursor>>(CURSORS, {});

function saveCursor(fileKey: string, cursor: Cursor) {
  // Re-read before writing: another hook process may have advanced other files.
  const all = loadCursors();
  const existing = all[fileKey];
  if (!existing || existing.lines < cursor.lines) all[fileKey] = cursor;
  writeJson(CURSORS, all);
}

/** Complete lines appended after `fromByte` (a trailing partial line waits for the next sync). */
function readNewLines(path: string, fromByte: number) {
  const size = statSync(path).size;
  if (size <= fromByte) return { lines: [] as string[], bytes: fromByte };
  const length = size - fromByte;
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, length, fromByte);
  } finally {
    closeSync(fd);
  }
  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline === -1) return { lines: [], bytes: fromByte };
  const complete = buffer.subarray(0, lastNewline + 1);
  return { lines: complete.toString("utf8").split("\n").filter((line) => line.trim()), bytes: fromByte + complete.byteLength };
}

export async function syncTranscript(target: Target, transcript: TranscriptFile) {
  if (!existsSync(transcript.path)) return { sent: 0 };
  let cursor = loadCursors()[transcript.fileKey] ?? { lines: 0, bytes: 0 };
  // The file shrank (rewritten or rotated): start over; the server skips repeats.
  if (statSync(transcript.path).size < cursor.bytes) cursor = { lines: 0, bytes: 0 };
  const { lines, bytes } = readNewLines(transcript.path, cursor.bytes);
  let sent = 0;
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let size = 0;
    while (end < lines.length && end - start < MAX_LINES && size < MAX_BYTES) size += lines[end++]!.length;
    const parsed = lines.slice(start, end).map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return { type: "unparseable" };
      }
    });
    const result = await postJson(target, "/v1/transcripts", {
      harness: "claude-code",
      fileKey: transcript.fileKey,
      file: transcript.file,
      startLine: cursor.lines + start,
      lines: parsed,
    });
    if (result.status === 409 && typeof result.json.expectedStartLine === "number") {
      // The server is behind our cursor (a reset database): resend the whole
      // file. Starting at line 0 can never be a gap, so this recurses once.
      writeJson(CURSORS, { ...loadCursors(), [transcript.fileKey]: { lines: 0, bytes: 0 } });
      return syncTranscript(target, transcript);
    }
    if (result.status >= 300) throw new Error(`Upload failed (${result.status}): ${JSON.stringify(result.json)}`);
    sent += end - start;
    start = end;
  }
  saveCursor(transcript.fileKey, { lines: cursor.lines + lines.length, bytes });
  return { sent };
}

/** The main transcript plus every sub-agent transcript of one session. */
export function sessionTranscripts(mainPath: string): TranscriptFile[] {
  const sessionId = basename(mainPath, ".jsonl");
  const files: TranscriptFile[] = [{ path: mainPath, fileKey: sessionId, file: { kind: "main" } }];
  const subDir = join(dirname(mainPath), sessionId, "subagents");
  if (!existsSync(subDir)) return files;
  for (const name of readdirSync(subDir)) {
    const match = /^agent-(.+)\.jsonl$/.exec(name);
    if (!match) continue;
    const agentId = match[1]!;
    const meta = readJson<{ toolUseId?: string; agentType?: string; description?: string }>(join(subDir, `agent-${agentId}.meta.json`), {});
    files.push({
      path: join(subDir, name),
      fileKey: `${sessionId}/agent-${agentId}`,
      file: { kind: "subagent", agentId, parentToolUseId: meta.toolUseId, agentType: meta.agentType, description: meta.description },
    });
  }
  return files;
}
