// Builds a moderately large page so the extension's per-page cost can be measured.
(() => {
  const grid = document.getElementById('grid');
  for (let i = 0; i < 1500; i++) {
    const p = document.createElement('p');
    p.textContent = 'Row ' + i + ': the quick brown fox jumps over the lazy dog.';
    grid.appendChild(p);
  }
})();
