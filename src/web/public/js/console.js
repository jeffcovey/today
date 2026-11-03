// The console page: xterm.js in the browser, a PTY on the server, JSON frames
// over a WebSocket. The protocol is described in src/web-console.js.
(() => {
  const container = document.getElementById('terminal');
  const statusEl = document.getElementById('consoleStatus');
  const reconnectBtn = document.getElementById('consoleReconnect');
  if (!container || !statusEl || !reconnectBtn || typeof Terminal === 'undefined') return;

  const socketPath = (document.currentScript && document.currentScript.dataset.socketPath) || '/_console/socket';
  const socketUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + socketPath;

  // xterm.js has one set of these for both modes, and it can't read well on both.
  // minimumContrastRatio would be simpler, but it greys out reverse-video text.
  const ANSI_COLORS = {
    light: {
      black: '#24292f', red: '#b42318', green: '#116329', yellow: '#6f4e00',
      blue: '#0550ae', magenta: '#6639ba', cyan: '#0b6b73', white: '#57606a',
      brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#17703a', brightYellow: '#7d4e00',
      brightBlue: '#0860ca', brightMagenta: '#7443d0', brightCyan: '#17727a', brightWhite: '#424a53'
    },
    dark: {
      black: '#7d8590', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
      blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
      brightBlack: '#8b949e', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341',
      brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc'
    }
  };

  // The terminal takes its colours from the page's code-block tokens, so it
  // follows the palette and the light/dark switch like everything else.
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const themeFromPage = () => ({
    ...(document.documentElement.dataset.theme === 'dark' ? ANSI_COLORS.dark : ANSI_COLORS.light),
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
