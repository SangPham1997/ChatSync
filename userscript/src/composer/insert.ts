// Insert text into composer.
// textarea → text-field-edit (preserves undo stack)
// contenteditable → ClipboardEvent paste (works with ProseMirror/Lexical/Quill)

import insertText from 'text-field-edit'

export function insertIntoTextarea(el: HTMLTextAreaElement, text: string, replace = false): void {
  if (replace) {
    el.value = text
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return
  }
  insertText.insert(el, text)
}

export function insertIntoContentEditable(el: HTMLElement, text: string, replace = false): void {
  el.focus()
  if (replace) {
    // Select all then delete
    const sel = window.getSelection()
    if (sel) {
      const range = document.createRange()
      range.selectNodeContents(el)
      sel.removeAllRanges()
      sel.addRange(range)
    }
    document.execCommand('delete', false)
  }
  // Paste event — ProseMirror/Lexical/Quill all handle this correctly
  const dt = new DataTransfer()
  dt.setData('text/plain', text)
  const event = new ClipboardEvent('paste', {
    clipboardData: dt,
    bubbles: true,
    cancelable: true,
  })
  const handled = !el.dispatchEvent(event)
  if (!handled) {
    // Fallback: execCommand insertText
    document.execCommand('insertText', false, text)
  }
}

export function insertIntoComposer(el: HTMLElement, text: string, replace = false): void {
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    insertIntoTextarea(el as HTMLTextAreaElement, text, replace)
  } else {
    insertIntoContentEditable(el, text, replace)
  }
}