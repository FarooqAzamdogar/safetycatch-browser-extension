// ActionGuard test page script. The copied string is put together at run time
// from small pieces, so no file in this repository contains a ready-made
// command line, and what it builds is harmless: a hidden window that prints
// one line of text and closes.
(() => {
  const via = new URLSearchParams(location.search).get('via') || 'writeText';
  const status = document.getElementById('status');
  const say = (text) => {
    status.textContent = text;
  };
  const pieces = ['pow', 'ersh', 'ell', ' -w hid', 'den', ' -c "Write-Out', "put 'ActionGuard test: nothing was run'", '"', ' # I am not a ro', 'bot - reCAPT', 'CHA Verification ID: 4821'];
  const command = () => pieces.join('');
  window.testCommand = command;

  const copyWithExec = (text) => {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  };

  document.getElementById('verify').addEventListener('click', async () => {
    document.getElementById('steps').hidden = false;
    const text = command();
    try {
      if (via === 'exec') {
        say(copyWithExec(text) ? 'copied with execCommand' : 'execCommand refused');
      } else if (via === 'event') {
        const onCopy = (e) => {
          e.clipboardData.setData('text/plain', text);
          e.preventDefault();
        };
        document.addEventListener('copy', onCopy, { once: true });
        say(document.execCommand('copy') ? 'copied with a copy-event handler' : 'execCommand refused');
      } else if (via === 'frame') {
        // Tries to borrow untouched clipboard functions from a brand new iframe.
        const frame = document.createElement('iframe');
        frame.style.display = 'none';
        document.body.appendChild(frame);
        await frame.contentWindow.navigator.clipboard.writeText.call(navigator.clipboard, text);
        say('copied through a fresh iframe');
      } else {
        await navigator.clipboard.writeText(text);
        say('copied with the clipboard API');
      }
    } catch (error) {
      say('copy failed: ' + error.name);
    }
  });

  document.getElementById('benign').addEventListener('click', async () => {
    await navigator.clipboard.writeText('Hello from the ActionGuard test page.');
    say('plain sentence copied');
  });
  document.getElementById('link').addEventListener('click', async () => {
    await navigator.clipboard.writeText('https://example.com/some/page?x=1');
    say('link copied');
  });
})();
