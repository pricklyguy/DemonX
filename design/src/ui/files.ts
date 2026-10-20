// Saving and opening files from the browser. Chrome and Edge can open and save real files (the File System Access API),
// so Save writes back to the same file. Other browsers get a download for Save and a file chooser for Open.

export interface WritableLike { write(data: string): Promise<void>; close(): Promise<void> }
export interface HandleLike { name: string; getFile(): Promise<File>; createWritable(): Promise<WritableLike> }

const w = () => window as unknown as {
  showSaveFilePicker?: (o: unknown) => Promise<HandleLike>;
  showOpenFilePicker?: (o: unknown) => Promise<HandleLike[]>;
};
const TYPES = [{ description: 'DemonX Design', accept: { 'application/json': ['.dxd'] } }];

export const canPick = () => typeof w().showSaveFilePicker === 'function' && typeof w().showOpenFilePicker === 'function';

const cancelled = (e: unknown) => (e as Error)?.name === 'AbortError';

/** Ask where to save. null when the person cancelled. */
export async function pickSaveHandle(suggestedName: string): Promise<HandleLike | null> {
  try { return await w().showSaveFilePicker!({ suggestedName, types: TYPES }); } catch (e) { if (cancelled(e)) return null; throw e; }
}

/** Ask which file to open. null when the person cancelled. */
export async function pickOpenHandle(): Promise<HandleLike | null> {
  try { const [h] = await w().showOpenFilePicker!({ types: TYPES, multiple: false }); return h ?? null; } catch (e) { if (cancelled(e)) return null; throw e; }
}

export async function writeHandle(h: HandleLike, text: string): Promise<void> {
  const wr = await h.createWritable();
  await wr.write(text);
  await wr.close();
}

export function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
