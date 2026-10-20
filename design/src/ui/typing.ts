/**
 * Is the keyboard focus somewhere you type text or pick from a list? Then the tool shortcuts (R, C, P, V...) and Ctrl+Z
 * must leave the key alone. A focused checkbox, radio button, colour box or button is not typing, so after you click
 * "Grid" the shortcuts still work.
 */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable) return true;
  if (target.tagName !== 'INPUT') return false;
  return !['checkbox', 'radio', 'button', 'submit', 'color', 'range', 'file'].includes((target as HTMLInputElement).type);
}
