package httpapi

import "net/http"

// landingPage is served at / so that opening the server URL in a browser
// shows something better than a bare 404.
const landingPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tabstow server</title>
<style>
  :root { color-scheme: light dark; --fg: #1f2328; --muted: #59636e; --bg: #ffffff; --code: #f0f2f4; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e6edf3; --muted: #9198a1; --bg: #0d1117; --code: #1f242c; } }
  body { margin: 0; background: var(--bg); color: var(--fg);
         font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 36rem; margin: 0 auto; padding: 4rem 1rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .5rem; }
  p { color: var(--muted); }
  code { background: var(--code); padding: .1rem .35rem; border-radius: 4px; }
</style>
</head>
<body>
<main>
  <h1>Tabstow sync server</h1>
  <p>This server syncs stowed tabs for the Tabstow browser extension. There is nothing to do here in a browser.</p>
  <p>To use it, open the extension's Settings, enter this page's address as the server URL, and sign in.</p>
  <p>Health check: <code><a href="/healthz">/healthz</a></code></p>
</main>
</body>
</html>
`

func handleLanding(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write([]byte(landingPage))
}
