// The form never submits anywhere.
document.getElementById('form').addEventListener('submit', (e) => {
  e.preventDefault();
  document.getElementById('status').textContent = 'Test page: nothing was sent.';
});
