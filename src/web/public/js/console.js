// The console page: xterm.js in the browser, a PTY on the server, JSON frames
// over a WebSocket. The protocol is described in src/web-console.js.
(() => {
  const container = document.getElementById('terminal');
  const statusEl = document.getElementById('consoleStatus');
  const reconnectBtn = document.getElementById('consoleReconnect');
  if (!container || !statusEl || !reconnectBtn || typeof Terminal === 'undefined') return;

  const socketPath = (document.currentScript && document.currentScript.dataset.socketPath) || '/_console/socket';
  const socketUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + socketPath;

  // The terminal takes its colours from the page's code-block tokens, so it
  // follows the palette and the light/dark switch like everything else.
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const themeFromPage = () => ({
    background: cssVar('--today-code-block-bg') || '#0d1117',
    foreground: cssVar('--today-code-block-text') || '#e6edf3',
    cursor: cssVar('--today-accent') || '#60a5fa',
    cursorAccent: cssVar('--today-code-block-bg') || '#0d1117',
    selectionBackground: 'rgba(96, 165, 250, 0.35)'
  });

  // The pages set the root font size from the Text Size setting; the terminal
  // follows it, at the ratio that makes the default (17px) a 14px terminal.
  const fontSizeFromPage = () => {
    const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return root > 0 ? Math.max(10, Math.round(root * 14 / 17)) : 14;
  };

  const term = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: fontSizeFromPage(),
    scrollback: 5000,
    theme: themeFromPage()
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  if (typeof WebLinksAddon !== 'undefined') term.loadAddon(new WebLinksAddon.WebLinksAddon());
  term.open(container);

  let socket = null;
  let exited = false;

  const setStatus = (text, canReconnect) => {
    statusEl.textContent = text;
    reconnectBtn.classList.toggle('d-none', !canReconnect);
  };
  const isOpen = () => socket !== null && socket.readyState === WebSocket.OPEN;
  const sendJson = (message) => { if (isOpen()) socket.send(JSON.stringify(message)); };

  let fitTimer = null;
  const refit = () => {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      try { fit.fit(); } catch (error) { /* container not laid out yet */ }
    }, 50);
  };

  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.attributeName === 'data-theme') term.options.theme = themeFromPage();
      if (mutation.attributeName === 'style') {
        const size = fontSizeFromPage();
        if (size !== term.options.fontSize) {
          term.options.fontSize = size;
          refit();
        }
      }
    }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });

  const connect = () => {
    exited = false;
    setStatus('Connecting…', false);
    socket = new WebSocket(socketUrl);
    socket.addEventListener('open', () => {
      setStatus('Connected', false);
      refit();
      sendJson({ type: 'resize', cols: term.cols, rows: term.rows });
      term.focus();
    });
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch (error) { return; }
      if (message.type === 'output') {
        term.write(message.data);
      } else if (message.type === 'hello') {
        const idle = message.idleMinutes > 0 ? ' · closes after ' + message.idleMinutes + ' idle min' : '';
        setStatus(message.shell + ' in ' + message.cwd + idle, false);
      } else if (message.type === 'exit') {
        exited = true;
        const code = message.code === undefined || message.code === null ? '' : ' (' + message.code + ')';
        term.write('\r\n[console] shell exited' + code + '\r\n');
      }
    });
    socket.addEventListener('close', (event) => {
      socket = null;
      const why = event.code === 4000 ? 'Closed after being idle' : (exited ? 'Shell exited' : 'Disconnected');
      setStatus(why + ' — press Enter or Reconnect for a new shell', true);
    });
  };

  term.onData((data) => {
    if (isOpen()) {
      sendJson({ type: 'input', data });
    } else if (socket === null && data === '\r') {
      connect();
    }
  });
  term.onResize(({ cols, rows }) => sendJson({ type: 'resize', cols, rows }));
  reconnectBtn.addEventListener('click', () => {
    if (socket === null) connect();
    term.focus();
  });

  window.addEventListener('resize', refit);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', refit);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(refit).observe(container);
  window.addEventListener('beforeunload', () => { if (socket) socket.close(1000, 'page closed'); });

  connect();
})();
