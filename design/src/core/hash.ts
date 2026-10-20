/** A short fingerprint of a text (FNV-1a, 32 bit), to tell whether the job on the machine is the one on screen. Not a security hash. */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0') + ':' + text.length;
}
