// Multi-file diff review -- diff2html (browser entry) + dompurify + marked.
// Chosen over vscode.changes (unofficial, flagged in review).
import { html as diff2htmlHtml } from 'diff2html'
import DOMPurify from 'dompurify'
import { marked } from 'marked'

export interface ReviewInput {
  unifiedDiff: string
  commentaryMarkdown?: string
}

export function renderReview(input: ReviewInput): string {
  const diffHtml = diff2htmlHtml(input.unifiedDiff, {
    drawFileList: true,
    matching: 'lines',
    outputFormat: 'side-by-side',
  })

  let mdHtml = ''
  if (input.commentaryMarkdown) {
    mdHtml = `<section class="commentary">${marked.parse(input.commentaryMarkdown) as string}</section>`
  }

  const raw = `
    <article class="chatsync-review">
      ${mdHtml}
      <section class="diff">${diffHtml}</section>
    </article>
  `
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } })
}