// Sets the link from the ?to= parameter (http and https addresses only).
(() => {
  const to = new URLSearchParams(location.search).get('to') || '';
  if (to.startsWith('http://') || to.startsWith('https://')) document.getElementById('go').href = to;
})();
