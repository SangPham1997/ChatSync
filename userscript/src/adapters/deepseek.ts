// DeepSeek DOM adapter -- selector registry, kept small & testable.
// NOTE: real selectors must be verified against live DeepSeek; fixtures are in
// test/fixtures/deepseek-composer.html for the offline test loop.
export const selectors = {
  composer: 'textarea, div[contenteditable="true"]',
  sendButton: 'button[data-testid="send-button"]',
  stopButton: 'button[data-testid="stop-button"]',
  codeBlock: 'pre > code',
}