Requires Python 3 (stdlib only, no extra installs).

```bash
python3 server.py
# then open http://localhost:8000
```

This serves the app *and* a small `/api` backed directly by `data.sqlite`, so editing a person in the UI ("Kişi Detayları" → pencil icon → Kaydet) writes straight to that file on disk. Editing needs this server — a plain static file server (`npx serve`, `python3 -m http.server`, `php -S`, etc.) will load the tree fine but can't save changes.

Pass a different port if 8000 is taken: `python3 server.py 8080`.
