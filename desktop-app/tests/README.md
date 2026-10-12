# DravenGap tests

```
cd desktop-app
npm test                    # everything (about 2 min)
npm test -- --unit          # main-process modules only (fast)
npm test -- --renderer      # the real index.html in a hidden Electron window
npm test -- profile         # only files whose name contains "profile"
npm test -- --verbose       # print every test's output, not just failures
```

| Folder | What runs there |
|---|---|
| `unit/` | Node scripts run with Electron's Node (`ELECTRON_RUN_AS_NODE=1`). They `require` the app modules directly and talk to stub servers. |
| `renderer/` | Electron main scripts that boot `index.html` + `preload.js` in a hidden window through `lib/renderer-harness.js`. |
| `lib/` | Stubs and helpers: Riot API (`riot-stub.js`, `live-stub.js`), synthetic op.gg pages (`opgg-fixture.js`), a match timeline, the renderer harness. |
| `fixtures/` | Public pages and data saved once (arammayhem.com, LoLalytics ARAM, an R2 stats file, Data Dragon `champion.json`), gzipped, plus a self-signed certificate for the stub LCU. |

Rules the tests keep:
- **No real user data.** Each test uses a fresh folder under the OS temp dir. The renderer harness calls `app.setPath('userData', …)` before the window opens, so `%APPDATA%\draftdiff` is never touched.
- **No real network.** Stub servers listen on `127.0.0.1` only. The renderer harness redirects R2 and Data Dragon to a stub and cancels every other request.
- **No personal data in fixtures.** Players are made up (`TestOwner#META`, `Alpha`, `Bravo` …); the op.gg pages are generated.

Adding a test: drop a `*.test.js` file into `unit/` or `renderer/`. It passes when it exits with code 0 and prints no `FAIL` line. Renderer tests can use `H.results()` for `PASS | name` / `FAIL | name` lines.
