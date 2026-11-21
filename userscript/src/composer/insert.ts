// Insert text into textarea / contenteditable.
// Strategy: text-field-edit for textarea (keeps undo stack);
// ClipboardEvent('paste') + DataTransfer for contenteditable (ProseMirror/Lexical/Quill).
export function insertIntoTextarea(el: HTMLTextAreaElement, text: string): void {
  // import { insert } from 'text-field-edit' -- TODO(M1)
  void el; void text
}

export function insertIntoContentEditable(el: HTMLElement, text: string): void {
  const dt = new DataTransfer()
  dt.setData('text/plain', text)
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
}