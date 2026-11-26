// SafetyCatch test page script for the AI-chat paste guard.
(() => {
  const status = document.getElementById('status');
  // A made-up token in the shape of a GitHub token, assembled at run time so
  // secret scanners do not flag this repository. It was never a real key.
  const fakeToken = () => 'gh' + 'p_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  window.fakeSecretText = () => 'Please debug this config: token = ' + fakeToken() + ' and tell me what is wrong.';
  window.cleanText = () => 'Please summarise the plot of a famous novel in three sentences.';

  // A minimal "rich editor": it cancels the browser's paste and inserts the text itself.
  const rich = document.getElementById('rich');
  rich.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    const selection = getSelection();
    if (!selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
    range.collapse(false);
  });

  document.getElementById('fake').addEventListener('click', async () => {
    await navigator.clipboard.writeText(window.fakeSecretText());
    status.textContent = 'text with a fake key copied';
  });
  document.getElementById('clean').addEventListener('click', async () => {
    await navigator.clipboard.writeText(window.cleanText());
    status.textContent = 'text without secrets copied';
  });
})();
