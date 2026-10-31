/**
 * Local file access. Uses the File System Access API (Chromium) so "Save" writes
 * back to the same file; other browsers fall back to upload/download.
 */

import { ensurePermission } from "./fileStore";

type Picker = (
  opts: object,
) => Promise<FileSystemFileHandle | FileSystemFileHandle[]>;
const w = window as unknown as {
  showOpenFilePicker?: Picker;
  showSaveFilePicker?: Picker;
};

export const canWriteFiles = typeof w.showSaveFilePicker === "function";

const types = [
  {
    description: "Mermaid diagram",
    accept: { "text/plain": [".mmd", ".mermaid", ".txt"] },
  },
];

export interface OpenedFile {
  text: string;
  name: string;
  handle?: FileSystemFileHandle;
}

function isAbort(e: unknown) {
  return e instanceof DOMException && e.name === "AbortError";
}

export async function openFile(): Promise<OpenedFile | null> {
  if (w.showOpenFilePicker) {
    try {
      const [handle] = (await w.showOpenFilePicker({
        types,
        multiple: false,
        // Ask for write access right away, so autosave works without another prompt.
        mode: "readwrite",
      })) as FileSystemFileHandle[];
      const file = await handle.getFile();
      return { text: await file.text(), name: file.name, handle };
    } catch (e) {
      if (isAbort(e)) return null;
      throw e;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".mmd,.mermaid,.txt";
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? { text: await file.text(), name: file.name } : null);
    };
    input.click();
  });
}

/** The browser refused to write (no permission, or file editing blocked). */
export class WriteNotAllowedError extends Error {
  constructor(public fileName: string) {
    super(`The browser did not allow writing to ${fileName}`);
  }
}

/**
 * Writes the file. With `request`, asks for write permission first, which only
 * works inside a click. Without it (autosave), a missing permission throws
 * WriteNotAllowedError instead of prompting.
 */
export async function writeFile(
  handle: FileSystemFileHandle,
  text: string,
  request = false,
) {
  if (!(await ensurePermission(handle, request))) {
    throw new WriteNotAllowedError(handle.name);
  }
  try {
    const writable = await (
      handle as FileSystemFileHandle & {
        createWritable(): Promise<{
          write(t: string): Promise<void>;
          close(): Promise<void>;
        }>;
      }
    ).createWritable();
    await writable.write(text);
    await writable.close();
  } catch (e) {
    console.warn("[mirrormaid] createWritable failed", e);
    if (e instanceof DOMException && e.name === "NotAllowedError") {
      throw new WriteNotAllowedError(handle.name);
    }
    throw e;
  }
}

export function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Asks where to save and writes the file. Returns null if the user cancelled.
 *
 * The save dialog uses up the click's user activation, so the browser may not
 * be able to ask for write permission right after it. In that case the handle
 * is still returned with `written: false`; the caller links it and lets the
 * user grant access with a fresh click.
 */
export async function saveFileAs(
  text: string,
  suggestedName: string,
): Promise<(OpenedFile & { written: boolean }) | null> {
  if (w.showSaveFilePicker) {
    let handle: FileSystemFileHandle;
    try {
      handle = (await w.showSaveFilePicker({
        types,
        suggestedName,
      })) as FileSystemFileHandle;
    } catch (e) {
      if (isAbort(e)) return null;
      throw e;
    }
    try {
      await writeFile(handle, text, true);
      return { text, name: handle.name, handle, written: true };
    } catch (e) {
      if (!(e instanceof WriteNotAllowedError)) throw e;
      return { text, name: handle.name, handle, written: false };
    }
  }
  download(text, suggestedName);
  return { text, name: suggestedName, written: true };
}
