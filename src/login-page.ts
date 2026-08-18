/**
 * Standalone login page rendered by the auth gate. Styling mirrors the
 * harness web UI design language (design-platform.css tokens): deepseek-blue
 * brand, bluish neutrals, 12px card radius, dark mode via
 * `prefers-color-scheme`. Zero external dependencies — the page works with a
 * plain form POST (progressive enhancement, no JS required).
 */

/** Render the login page HTML. */
export function renderLoginPage(
  title: string,
  authPath: string,
  cookieName: string,
  error?: string,
): string {
  const errorBlock = error === undefined
    ? ''
    : `      <p class="error" role="alert">${escapeHtml(error)}</p>\n`
  const escapedTitle = escapeHtml(title)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapedTitle} · Sign in</title>
<style>
  :root {
    --bg: rgb(245, 246, 247);
    --card: rgb(255, 255, 255);
    --text: rgb(27, 27, 28);
    --text-secondary: rgb(151, 157, 166);
    --border: rgba(0, 0, 0, 0.1);
    --brand: rgb(65, 118, 230);
    --brand-hover: rgb(103, 158, 254);
    --input-bg: rgb(249, 250, 251);
    --ring: rgba(65, 118, 230, 0.25);
    --error: rgb(236, 19, 19);
    --error-bg: rgb(254, 242, 242);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: rgb(21, 21, 23);
      --card: rgb(35, 35, 36);
      --text: rgb(235, 238, 242);
      --text-secondary: rgb(151, 157, 166);
      --border: rgba(255, 255, 255, 0.1);
      --input-bg: rgb(33, 33, 35);
      --ring: rgba(103, 158, 254, 0.3);
      --error: rgb(242, 90, 90);
      --error-bg: rgb(87, 12, 12);
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI",
      Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: min(92vw, 380px);
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 32px 28px 26px;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.08);
  }
  .brand { text-align: center; margin-bottom: 24px; }
  .brand svg { width: 44px; height: 44px; }
  .brand h1 {
    margin: 14px 0 6px;
    font-size: 18px;
    font-weight: 600;
    letter-spacing: 0.2px;
  }
  .brand p {
    margin: 0;
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.5;
  }
  label {
    display: block;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-secondary);
    margin-bottom: 6px;
  }
  input[type="password"] {
    width: 100%;
    height: 38px;
    padding: 0 12px;
    font-size: 14px;
    color: var(--text);
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    outline: none;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  input[type="password"]:focus {
    border-color: var(--brand);
    box-shadow: 0 0 0 3px var(--ring);
  }
  button {
    width: 100%;
    height: 38px;
    margin-top: 16px;
    font-size: 14px;
    font-weight: 500;
    color: rgb(255, 255, 255);
    background: var(--brand);
    border: none;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.15s ease;
  }
  button:hover { background: var(--brand-hover); }
  button:active { transform: translateY(1px); }
  .error {
    margin: 14px 0 0;
    padding: 8px 12px;
    font-size: 12px;
    color: var(--error);
    background: var(--error-bg);
    border-radius: 8px;
  }
  .hint {
    margin: 22px 0 0;
    text-align: center;
    font-size: 11px;
    color: var(--text-secondary);
  }
  .logout {
    margin-top: 10px;
    text-align: center;
    font-size: 12px;
  }
  .logout a {
    color: var(--text-secondary);
    text-decoration: none;
    border-bottom: 1px solid var(--border);
  }
</style>
</head>
<body>
  <main class="card">
    <div class="brand">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 3a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1V8a5 5 0 0 0-5-5Zm-3 8V8a3 3 0 1 1 6 0v3H9Z" fill="var(--brand)"/>
      </svg>
      <h1>${escapedTitle}</h1>
      <p>Enter your access key to continue.</p>
    </div>
    <form id="login" method="post" action="${escapeAttr(authPath)}">
      <label for="key">Access key</label>
      <input id="key" name="key" type="password" autocomplete="current-password" required autofocus>
      <button type="submit">Sign in</button>
${errorBlock}    </form>
    <p class="hint">Unauthorized access is prohibited.</p>
    <p class="logout"><a href="${escapeAttr(authPath)}" data-logout>Sign out</a></p>
  </main>
  <script>
    // POST / DELETE without a form: sign out clears the session cookie.
    document.querySelector('[data-logout]')?.addEventListener('click', (event) => {
      event.preventDefault()
      fetch('${escapeJs(authPath)}', { method: 'DELETE', credentials: 'same-origin' })
        .then(() => { location.href = '${escapeJs(authPath)}' })
    })
    // Avoid re-POST on refresh after a successful login redirect.
    if (window.history.replaceState) window.history.replaceState(null, '', '${escapeJs(authPath)}')
  </script>
</body>
</html>
`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function escapeAttr(value: string): string {
  return escapeHtml(value)
}

function escapeJs(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('\n', '\\n')
}

/** Cookie name is surfaced for the page's own controls and diagnostics. */
export function cookieNameFor(config: { cookieName: string }): string {
  return config.cookieName
}