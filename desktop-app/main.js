// desktop-app/main.js
const { app, BrowserWindow, ipcMain, safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const https = require('https');
const lcuHistory = require('./lcu-history');
const riotHistory = require('./riot-history');
const lolalytics = require('./lolalytics-scraper');
const coachless = require('./coachless-scraper');
const { createRunner: createCoachlessRunner } = require('./coachless-runner');
const diagnostics = require('./diagnostics-main');

// Recent log lines for Settings > Diagnostics > Export: this process's console plus the window's (see createWindow).
const logRing = diagnostics.createLogRing();
for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => { logRing.add(level, args); original(...args); };
}

// Define paths for storing user data. Pinned to the original 'draftdiff' folder so the DravenGap rename (and an installed
// build, whose name would otherwise pick a new folder) keeps the saved key, caches, downloaded patches and settings.
// DG_USER_DATA: start on another data folder (checking a build without touching the real one)
app.setPath('userData', process.env.DG_USER_DATA || path.join(app.getPath('appData'), 'draftdiff'));
const userDataPath = app.getPath('userData');
const favoritesFilePath = path.join(userDataPath, 'favorites.json');
const settingsFilePath = path.join(userDataPath, 'settings.json');
const windowStateFilePath = path.join(userDataPath, 'window-state.json'); // Added for saving window size/position

// --- START: LCU Credential & Champ Select Logic ---
async function getLeagueCredentials() {
    return new Promise((resolve, reject) => {
        const extractCredentials = (stdout) => {
            const portMatch = stdout.match(/--app-port=([0-9]+)/);
            const passwordMatch = stdout.match(/--remoting-auth-token=([\w-]+)/);

            if (portMatch && passwordMatch) {
                resolve({ port: portMatch[1], password: passwordMatch[1] });
            } else {
                reject(new Error("Could not find port or password. Please ensure you are logged into the client."));
            }
        };

        // Attempt 1: WMIC (Standard for Windows 10 / Older Windows 11)
        exec('wmic PROCESS WHERE name="LeagueClientUx.exe" GET commandline', (error, stdout) => {
            if (!error && stdout && !stdout.includes('No Instance(s) Available.') && stdout.includes('--app-port')) {
                return extractCredentials(stdout);
            }

            // Attempt 2: PowerShell (Required for Windows 11 24H2+ where WMIC is removed)
            const psCommand = 'powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'LeagueClientUx.exe\'\\" | Select-Object -ExpandProperty CommandLine"';
            exec(psCommand, (psError, psStdout) => {
                if (!psError && psStdout && psStdout.includes('--app-port')) {
                    return extractCredentials(psStdout);
                }

                reject(new Error("League client process not found or credentials missing. Is the client running?"));
            });
        });
    });
}

const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
});

async function lcuRequest(path, creds) {
    try {
        const credentials = creds || await getLeagueCredentials();
        const { port, password } = credentials;
        const auth = Buffer.from(`riot:${password}`).toString('base64');

        return new Promise((resolve, reject) => {
            const req = https.get({
                hostname: '127.0.0.1',
                port: port,
                path: path,
                headers: { 'Authorization': `Basic ${auth}` },
                agent: httpsAgent
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
                    } else {
                        resolve(null); // Resolve with null for non-200 responses
                    }
                });
            });
            req.setTimeout(8000, () => req.destroy(new Error('LCU request timed out')));
            req.on('error', (err) => reject(err));
        });
    } catch (error) {
        return null;
    }
}

// --- Personal stats (1.10): Summoner's Rift history (ranked + normals) + mastery from the local client ---
// Returns null whenever the client isn't running / not logged in / data unavailable.
// Credentials are looked up once per call (each lookup spawns a process) and reused for all requests.
//
// The client only returns its recently loaded games (seen 21 to 101; begIndex/endIndex are ignored), so every fetch is
// merged into a local per-account store and the history builds up over time.
const personalHistoryFilePath = path.join(userDataPath, 'personal-history.json');

function readPersonalHistory() {
    try {
        if (fs.existsSync(personalHistoryFilePath)) {
            return JSON.parse(fs.readFileSync(personalHistoryFilePath, 'utf-8')) || {};
        }
    } catch (error) {
        console.error('Failed to read personal history:', error);
    }
    return {};
}

function writePersonalHistory(store) {
    try {
        fs.writeFileSync(personalHistoryFilePath, JSON.stringify(store));
    } catch (error) {
        console.error('Failed to save personal history:', error);
    }
}

// --- Riot API key (optional, for backfilling history via match-v5) ---
// Stored encrypted with the OS keychain (DPAPI on Windows) and never sent back to the renderer.
const riotKeyFilePath = path.join(userDataPath, 'riot-api-key.bin');
let riotApiKey = null; // decrypted, in memory
// Personal builds (scripts/build-personal.js) carry the owner's key inside the exe (resources/app-data.bin, encoded only so it
// is not plain text). Then the key is fixed: Settings hides the key section and set-riot-key is refused.
const builtinKeyPath = process.resourcesPath ? path.join(process.resourcesPath, 'app-data.bin') : null;
const builtinRiotKey = (() => {
    try {
        if (!builtinKeyPath || !fs.existsSync(builtinKeyPath)) return null;
        const k = require('./builtin-key').decode(fs.readFileSync(builtinKeyPath));
        return riotHistory.RIOT_KEY_PATTERN.test(k) ? k : null;
    } catch (error) { return null; }
})();

function loadRiotApiKey() {
    if (builtinRiotKey) { riotApiKey = builtinRiotKey; return; }
    try {
        if (fs.existsSync(riotKeyFilePath) && safeStorage.isEncryptionAvailable()) {
            riotApiKey = safeStorage.decryptString(fs.readFileSync(riotKeyFilePath));
        }
    } catch (error) {
        console.error('Failed to read Riot API key:', error);
        riotApiKey = null;
    }
}

function riotKeyStatus() {
    if (builtinRiotKey) return { set: true, builtin: true, hint: null };
    return { set: !!riotApiKey, hint: riotApiKey ? riotApiKey.slice(-4) : null };
}

function setRiotApiKey(key) {
    if (builtinRiotKey) return { ok: false, error: 'Not available in this build.', ...riotKeyStatus() };
    const trimmed = String(key || '').trim();
    if (trimmed === '') {
        riotApiKey = null;
        try { fs.rmSync(riotKeyFilePath, { force: true }); } catch (error) { /* already gone */ }
        return { ok: true, ...riotKeyStatus() };
    }
    if (!riotHistory.RIOT_KEY_PATTERN.test(trimmed)) {
        return { ok: false, error: "That doesn't look like a Riot API key (RGAPI-xxxxxxxx-...).", ...riotKeyStatus() };
    }
    riotApiKey = trimmed;
    if (safeStorage.isEncryptionAvailable()) {
        try {
            fs.writeFileSync(riotKeyFilePath, safeStorage.encryptString(trimmed));
        } catch (error) {
            console.error('Failed to save Riot API key:', error);
        }
    } // otherwise keep it for this session only rather than writing it in plain text
    return { ok: true, ...riotKeyStatus() };
}

// Backfill the personal history from match-v5. Long-running (a dev key allows 100 requests
// per 2 minutes), so progress is pushed to the window as 'riot-sync-progress' events.
let riotSyncRunning = false;
async function syncRiotHistory(sender) {
    if (!riotApiKey) return { ok: false, error: 'No Riot API key saved.' };
    if (riotSyncRunning) return { ok: false, error: 'A sync is already running.' };
    riotSyncRunning = true;
    try {
        const creds = await getLeagueCredentials();
        const summoner = await lcuRequest('/lol-summoner/v1/current-summoner', creds);
        const page = await lcuRequest('/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=1', creds);
        if (!summoner || !page) return { ok: false, error: 'League client not reachable.' };

        const accountKey = summoner.puuid || String(summoner.summonerId);
        const store = readPersonalHistory();
        store._riotChecked = store._riotChecked || {};
        const checked = store._riotChecked[accountKey] || [];
        const knownIds = new Set(checked);
        for (const g of store[accountKey] || []) if (g.source === 'riot') knownIds.add(g.gameId);

        const result = await riotHistory.fetchRiotGames({
            apiKey: riotApiKey,
            gameName: summoner.gameName,
            tagLine: summoner.tagLine,
            platformId: page.platformId,
            knownIds,
            onProgress: p => { if (!sender.isDestroyed()) sender.send('riot-sync-progress', p); }
        });

        // Re-read before writing: the fetch above can take minutes, and the profile auto-refresh (profile-main.js) appends
        // finished games to the same file in the meantime.
        const latest = readPersonalHistory();
        latest._riotChecked = latest._riotChecked || {};
        const games = lcuHistory.mergeGameHistory(latest[accountKey], result.games);
        latest[accountKey] = games;
        latest._riotChecked[accountKey] = [...new Set([...(latest._riotChecked[accountKey] || []), ...checked, ...result.checkedIds])];
        writePersonalHistory(latest);

        const err = result.error;
        return {
            ok: !err,
            added: result.games.length,
            games,
            error: err ? describeRiotError(err) : null
        };
    } catch (error) {
        return { ok: false, error: describeRiotError(error) };
    } finally {
        riotSyncRunning = false;
    }
}

// --- Local LoLalytics scraper (past patches, 7/14 day windows) ---
// Runs jobs one at a time; each finished dataset is pushed to the window as gzip buffers
// ('scrape-dataset') and stored there in the patch archive / local store.
let scrapeAbort = null;
// opts.background (automatic freshness refresh): half the usual concurrency, so it stays out of the way.
async function runScrapeJobs(sender, jobs, opts) {
    if (scrapeAbort) return { ok: false, error: 'A download is already running.' };
    if (coachlessRunner.isRunning()) return { ok: false, error: 'A Builds (Coachless) download is running. Stop it or wait for it to finish first.' };
    if (!Array.isArray(jobs) || jobs.length === 0) return { ok: false, error: 'Nothing selected.' };
    scrapeAbort = new AbortController();
    const signal = scrapeAbort.signal;
    const send = (channel, payload) => { if (!sender.isDestroyed()) sender.send(channel, payload); };
    (async () => {
        let completed = 0, failed = 0;
        try {
            const championList = await lolalytics.getChampionList();
            for (let i = 0; i < jobs.length && !signal.aborted; i++) {
                const { period, rank } = jobs[i];
                try {
                    const result = await lolalytics.scrapeDataset({
                        period, rank, signal, championList, concurrency: opts && opts.background ? 2 : undefined,
                        onProgress: p => send('scrape-progress', { jobIndex: i, jobCount: jobs.length, period, rank, ...p })
                    });
                    send('scrape-dataset', { period, rank, scrapedAt: new Date().toISOString(), ...result });
                    completed++;
                } catch (error) {
                    if (signal.aborted) break;
                    failed++;
                    send('scrape-error', { period, rank, error: error.message });
                }
            }
        } catch (error) {
            send('scrape-error', { error: `Could not start: ${error.message}` });
        } finally {
            send('scrape-finished', { completed, failed, cancelled: signal.aborted });
            scrapeAbort = null;
        }
    })();
    return { ok: true };
}

// --- Builds: Coachless download job runner (see coachless-runner.js) ---
// Both scrapers run in this process and rate-limit themselves, so only one of them may run at a time.
let coachlessSender = null;
const coachlessRunner = createCoachlessRunner({
    scraper: coachless,
    resumeDir: path.join(userDataPath, 'coachless-resume'),
    send: (channel, payload) => { if (coachlessSender && !coachlessSender.isDestroyed()) coachlessSender.send(channel, payload); },
    isBlocked: () => scrapeAbort ? 'A LoLalytics history download is running. Stop it or wait for it to finish first.' : null
});
ipcMain.handle('coachless-patches', async () => {
    try { return { ok: true, patches: await coachless.getPatches() }; }
    catch (error) { return { ok: false, error: error.message, patches: [] }; }
});
// Bulk downloads are disabled: Coachless's author asked for on-demand use only.
ipcMain.handle('coachless-start', () => ({ ok: false, error: 'Bulk downloads are disabled; builds are fetched on demand in the Builds tab.' }));
ipcMain.handle('coachless-cancel', () => coachlessRunner.cancel());
ipcMain.handle('coachless-stored', (event, patch) => coachlessRunner.confirmStored(String(patch)));
// A reloaded window asks whether a download is running; progress is then sent to it
ipcMain.handle('coachless-status', (event) => { if (coachlessRunner.isRunning()) coachlessSender = event.sender; return coachlessRunner.status(); });
ipcMain.handle('coachless-detail', (event, req) => coachlessRunner.fetchDetail(req || {}));
// Builds are fetched on demand only (as agreed with Coachless's author): one champion-role per request from the UI.
ipcMain.handle('coachless-champion', (event, req) => coachlessRunner.fetchChampion(req || {}));
ipcMain.handle('coachless-rate-status', () => coachlessRunner.rateLimitStatus());
// --- END: Builds ---

function describeRiotError(error) {
    if (error && (error.status === 401 || error.status === 403)) {
        return builtinRiotKey ? "Riot's servers refused the request. Try again later." : 'Riot API key rejected. Development keys expire after 24 hours; paste a new one.';
    }
    return (error && error.message) || 'Riot API request failed.';
}

async function fetchPersonalStats() {
    try {
        const creds = await getLeagueCredentials();
        const summoner = await lcuRequest('/lol-summoner/v1/current-summoner', creds);
        if (!summoner) return null;

        const page = await lcuRequest('/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=100', creds);
        if (!page) return null;
        const fresh = lcuHistory.extractGames(page, summoner);

        // Keyed by puuid so several accounts on one PC keep separate histories
        const accountKey = summoner.puuid || String(summoner.summonerId);
        const store = readPersonalHistory();
        const games = lcuHistory.mergeGameHistory(store[accountKey], fresh);
        store[accountKey] = games;
        writePersonalHistory(store);

        const masteryRaw = await lcuRequest('/lol-champion-mastery/v1/local-player/champion-mastery', creds);
        return {
            summoner: { name: summoner.gameName || summoner.displayName || '', puuid: summoner.puuid || null },
            games,
            mastery: lcuHistory.extractMastery(masteryRaw),
            fetchedAt: Date.now()
        };
    } catch (e) {
        return null;
    }
}

// --- IPC Handlers ---
ipcMain.handle('get-personal-stats', () => fetchPersonalStats());
ipcMain.handle('get-riot-key-status', () => riotKeyStatus());
ipcMain.on('is-builtin-key', (event) => { event.returnValue = !!builtinRiotKey; });
ipcMain.handle('set-riot-key', (event, key) => {
    const result = setRiotApiKey(key);
    // A key from another Riot project encrypts puuids differently: drop cached account/summoner/league/mastery entries
    // (downloaded matches are kept). profileMain is defined below; this handler only runs after startup.
    if (result.ok && !builtinRiotKey) profileMain.onRiotKeyChanged();
    return result;
});
ipcMain.handle('sync-riot-history', (event) => syncRiotHistory(event.sender));
ipcMain.handle('scrape-start', (event, jobs, opts) => runScrapeJobs(event.sender, jobs, { background: !!(opts && opts.background) }));
ipcMain.handle('scrape-cancel', () => { if (scrapeAbort) scrapeAbort.abort(); return true; });
// Live Tracking polls these every second: go through the shared LCU connection (cached credentials, 8-60 s back-off while
// the client is closed) instead of spawning wmic/PowerShell on every poll. Shared with the Profile and ARAM views.
const sharedLcu = require('./profile-lcu').getSharedLcu({ getLeagueCredentials, lcuRequest });
ipcMain.handle("get-champ-select", () => sharedLcu.get('/lol-champ-select/v1/session'));
ipcMain.handle("get-pickable-champions", () => sharedLcu.get('/lol-champ-select/v1/pickable-champion-ids'));

ipcMain.handle('get-favorites', () => {
  try {
    if (fs.existsSync(favoritesFilePath)) {
      return JSON.parse(fs.readFileSync(favoritesFilePath, 'utf-8'));
    }
  } catch (error) {
    console.error('Failed to read favorites:', error);
  }
  return {};
});

ipcMain.handle('save-favorites', (event, favorites) => {
  try {
    fs.writeFileSync(favoritesFilePath, JSON.stringify(favorites, null, 2));
  } catch (error) {
    console.error('Failed to save favorites:', error);
  }
});

// "Copy as image" (share a draft or a post-game card): a part of the calling window as a PNG on the clipboard. rect is in window
// pixels (preload scales CSS pixels by the UI zoom); clipped to the window. Nothing is written to disk.
ipcMain.handle('copy-region', async (event, r) => {
    try {
        const win = BrowserWindow.fromWebContents(event.sender);
        const [cw, ch] = win ? win.getContentSize() : [1e5, 1e5];
        const x = Math.max(0, Math.floor(Number(r && r.x) || 0)), y = Math.max(0, Math.floor(Number(r && r.y) || 0));
        const width = Math.min(cw - x, Math.ceil(Number(r && r.width) || 0)), height = Math.min(ch - y, Math.ceil(Number(r && r.height) || 0));
        if (!(width > 0 && height > 0)) return { ok: false, error: 'Nothing to copy.' };
        const img = await event.sender.capturePage({ x, y, width, height });
        if (img.isEmpty()) return { ok: false, error: 'The window could not be captured.' };
        require('electron').clipboard.writeImage(img);
        const sz = img.getSize();
        return { ok: true, width: sz.width, height: sz.height };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('get-settings', () => {
  try {
    if (fs.existsSync(settingsFilePath)) {
      return JSON.parse(fs.readFileSync(settingsFilePath, 'utf-8'));
    }
  } catch (error) {
    console.error('Failed to read settings:', error);
  }
  return {};
});

ipcMain.handle('save-settings', (event, settings) => {
  try {
    fs.writeFileSync(settingsFilePath, JSON.stringify(settings, null, 2));
  } catch (error) {
    console.error('Failed to save settings:', error);
  }
});

// Feature modules register their own IPC channels under a prefix ('profile:*', 'aram:*'); preload's `feature` bridge
// only forwards channels with those prefixes. Push events go to the window via sendToWindow(channel, payload).
const sendToWindow = (channel, payload) => {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload);
};
const featureDeps = { ipcMain, userDataPath, getRiotApiKey: () => riotApiKey, getLeagueCredentials, lcuRequest, sendToWindow };
const profileMain = require('./profile-main');
profileMain.register(featureDeps); // op.gg-style profiles + live game (Riot API, LCU)
require('./aram-main').register(featureDeps);    // ARAM Mayhem (arammayhem.com, LoLalytics ARAM builds)
require('./arena-main').register(featureDeps);   // Arena (LoLalytics Arena tier list and builds; arena:*)
require('./skills-main').register(featureDeps);  // skill order for Builds and the game plan (LoLalytics, on demand; build:*)
require('./seed-main').register(featureDeps);    // personal build: data packed in the exe, imported on first start (seed:*)
require('./lcu-apply').register(featureDeps);    // 'Apply to client': rune pages, summoner spells, item sets (lcu:*)
let mainWindowRef = null;
const miniWindow = require('./mini-main').register({ // the compact always-on-top champ-select window (mini:*)
    ipcMain, BrowserWindow, screen: () => require('electron').screen, appDir: __dirname, userDataPath,
    getMainWindow: () => mainWindowRef, sendToWindow
});
diagnostics.register({                            // Settings > Diagnostics: store sizes, back-off state, export (diag:*)
    ipcMain, userDataPath, getLogs: logRing.lines,
    coachless: { rateLimitStatus: () => coachlessRunner.rateLimitStatus(), isRunning: () => coachlessRunner.isRunning() },
    appInfo: () => ({ version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node }),
    exportDir: () => app.getPath('downloads'),
    reveal: file => shell.showItemInFolder(file)
});
// --- END: IPC Handlers ---


// --- Window State Logic ---
function getWindowState() {
  // Default values for first-time launch
  const defaultState = { width: 1280, height: 800, isMaximized: true };
  try {
    if (fs.existsSync(windowStateFilePath)) {
      const savedState = JSON.parse(fs.readFileSync(windowStateFilePath, 'utf-8'));
      return { ...defaultState, ...savedState };
    }
  } catch (error) {
    console.error('Failed to read window state:', error);
  }
  return defaultState;
}

function saveWindowState(window) {
  try {
    const isMaximized = window.isMaximized();
    // getNormalBounds saves the width/height the window falls back to when un-maximized
    const bounds = window.getNormalBounds(); 
    fs.writeFileSync(windowStateFilePath, JSON.stringify({ ...bounds, isMaximized }, null, 2));
  } catch (error) {
    console.error('Failed to save window state:', error);
  }
}
// --- END: Window State Logic ---


function createWindow() {
  const windowState = getWindowState();

  const mainWindow = new BrowserWindow({
    x: windowState.x,
    y: windowState.y,
    width: windowState.width,
    height: windowState.height,
    title: 'DravenGap',
    icon: path.join(__dirname, 'assets/dravengap.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenu(null);
  // the window's console goes into the diagnostics log too (warnings and errors only; info is too chatty)
  mainWindow.webContents.on('console-message', (e, ...a) => {
    const level = e && e.level != null ? e.level : a[0], message = e && e.message != null ? e.message : a[1];
    if (level === 'warning' || level === 'error' || level >= 2) logRing.add(level === 'error' || level === 3 ? 'window-error' : 'window-warn', [message]);
  });

  // Links (Builds / ARAM / Profile source links) open in the system browser. A child window would inherit preload.js and
  // give the remote page window.electronAPI, so no in-app windows and no navigating away from the app's own file.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  // If it was maximized when last closed (or if it's the first launch), maximize it now
  if (windowState.isMaximized) {
    mainWindow.maximize();
  }

  mainWindow.loadFile('index.html');

  // Set up listeners to save the window state when you move/resize/maximize it
  let saveTimeout;
  const debouncedSave = () => {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => saveWindowState(mainWindow), 500);
  };

  mainWindow.on('resize', debouncedSave);
  mainWindow.on('move', debouncedSave);
  mainWindow.on('maximize', debouncedSave);
  mainWindow.on('unmaximize', debouncedSave);
  
  // Also save reliably right before it closes
  mainWindow.on('close', () => saveWindowState(mainWindow));
  mainWindowRef = mainWindow;
  mainWindow.on('closed', () => { mainWindowRef = null; miniWindow.close(); }); // the mini window never outlives the app
}

app.whenReady().then(() => {
  loadRiotApiKey(); // safeStorage is only usable once the app is ready
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => profileMain.flush()); // write pending profile cache documents

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});