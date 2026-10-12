// desktop-app/coachless-runner.js
// Job runner for the Coachless (Builds) download: patches one after another, resume files, partial datasets.
// Kept separate from main.js (and free of Electron imports) so it can be unit-tested with a stub scraper.
//
// Resume files: <resumeDir>/<patch>.json holds the scraper's resume state. It is written after every champion-role
// (onCheckpoint) and on errors/cancel (err.resumeState), passed back as resumeState when the patch is started again,
// and deleted once the patch completes.
// Partial datasets: when a patch stops early (cancel / error) with at least one champion-role scraped, a dataset built from
// the resume state is sent with complete:false, so the UI can use it right away. Re-running the patch resumes and
// replaces it with the complete one.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function createRunner({ scraper, resumeDir, send, isBlocked }) {
    let abort = null;
    let current = null; // { jobs: [{ patch }], index } while running, for status()

    const resumePath = patch => path.join(resumeDir, `${String(patch).replace(/[^0-9A-Za-z._-]/g, '_')}.json`);
    function readResume(patch) {
        try {
            const s = JSON.parse(fs.readFileSync(resumePath(patch), 'utf-8'));
            return s && s.patch === patch && s.champions ? s : null;
        } catch (e) { return null; }
    }
    function writeResume(patch, state) {
        try {
            fs.mkdirSync(resumeDir, { recursive: true });
            const tmp = resumePath(patch) + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(state));
            fs.renameSync(tmp, resumePath(patch));
        } catch (e) { console.error('Could not write Coachless resume file:', e.message); }
    }
    function deleteResume(patch) { try { fs.rmSync(resumePath(patch), { force: true }); } catch (e) { /* already gone */ } }

    function start(jobs) {
        if (abort) return { ok: false, error: 'A Builds download is already running.' };
        const blocked = isBlocked && isBlocked();
        if (blocked) return { ok: false, error: blocked };
        if (!Array.isArray(jobs) || jobs.length === 0) return { ok: false, error: 'Nothing selected.' };
        abort = new AbortController();
        const signal = abort.signal;
        current = { jobs: jobs.map(j => ({ patch: j.patch })), index: 0 };
        (async () => {
            let completed = 0, failed = 0, partial = 0, authFailed = false;
            try {
                let patchInfo = new Map();
                try { patchInfo = new Map((await scraper.getPatches({ signal })).map(p => [p.label, p])); } catch (e) { /* match counts are optional */ }
                for (let i = 0; i < jobs.length && !signal.aborted && !authFailed; i++) {
                    const { patch, championRoles } = jobs[i];
                    current.index = i;
                    const info = patchInfo.get(patch);
                    const resumeState = readResume(patch);
                    try {
                        const result = await scraper.scrapePatch({
                            patch, championRoles, signal, resumeState,
                            patchMatchCount: info ? info.matchCount : undefined,
                            onCheckpoint: state => writeResume(patch, state),
                            onProgress: p => send('coachless-progress', { jobIndex: i, jobCount: jobs.length, patch, ...p })
                        });
                        // The resume file is kept until the renderer confirms it stored the dataset (confirmStored); if storing
                        // fails, the next run of this patch rebuilds the dataset from it without new requests.
                        writeResume(patch, result.state);
                        const failedRoles = (result.failed || []).length;
                        send('coachless-dataset', {
                            patch, scrapedAt: new Date().toISOString(), champions: result.champions, skipped: result.skipped,
                            complete: failedRoles === 0, failedRoles, gz: result.gz, bytes: result.bytes
                        });
                        if (failedRoles) {
                            partial++;
                            send('coachless-error', {
                                patch, code: 'ROLES_FAILED',
                                error: `${failedRoles} champion-role${failedRoles === 1 ? '' : 's'} failed (e.g. ${result.failed[0].id}: ${result.failed[0].error}); saved as partial, downloading the patch again retries only those.`
                            });
                        } else {
                            completed++;
                        }
                    } catch (error) {
                        const state = error.resumeState;
                        if (state) writeResume(patch, state);
                        if (state && Object.keys(state.champions).length) {
                            try {
                                const gz = zlib.gzipSync(Buffer.from(JSON.stringify(scraper.buildDataset(patch, state, info ? info.matchCount : undefined))));
                                send('coachless-dataset', {
                                    patch, scrapedAt: new Date().toISOString(), champions: Object.keys(state.champions).length,
                                    skipped: state.skipped.length, complete: false, gz, bytes: gz.length
                                });
                                partial++;
                            } catch (e) { console.error('Could not build partial Builds dataset:', e.message); }
                        }
                        if (signal.aborted || error.message === 'cancelled') break;
                        failed++;
                        if (error.code === 'AUTH') {
                            authFailed = true;
                            send('coachless-error', { patch, code: 'AUTH', error: `Coachless rejected the request (${error.message}). Stopped the whole run; progress is saved and will resume.` });
                        } else {
                            send('coachless-error', { patch, code: error.code || null, error: error.message });
                        }
                    }
                }
            } catch (error) {
                send('coachless-error', { error: `Could not start: ${error.message}` });
            } finally {
                send('coachless-finished', { completed, failed, partial, cancelled: signal.aborted, authFailed });
                abort = null;
                current = null;
            }
        })();
        return { ok: true };
    }

    // On-demand detail for one champion-role (components, boot slots, rune detail). Runs alongside a bulk download;
    // the scraper's process-wide limiter keeps the total load capped.
    async function fetchDetail({ patch, champion, championKey, role, keystones }) {
        const fn = scraper.scrapeDetailOnDemand || scraper.scrapeChampionRoleDetail;
        if (!fn) return { ok: false, error: 'Detail download is not available.' };
        try {
            const detail = await fn({ patch, champion, championKey, role, keystones });
            return { ok: true, detail };
        } catch (e) {
            return { ok: false, code: e.code || null, error: e.message, retryAt: e.retryAt || null };
        }
    }

    // On demand (the only mode the UI uses now): the overview of one champion-role in one patch, ~9 requests in one parallel
    // burst like the website; the detail tables follow via fetchDetail. Returns { ok, record } (record null = no games in that
    // patch) or { ok: false, code, error, retryAt? }.
    async function fetchChampion({ patch, champion, championKey, role, matchupKey }) {
        try {
            const vs = Number(matchupKey);
            const record = await (scraper.scrapeOverviewOnDemand || scraper.scrapeChampionRoleFull)({ patch, champion, championKey, role,
                matchupKey: Number.isInteger(vs) && vs > 0 ? vs : null });
            return { ok: true, record };
        } catch (e) {
            return { ok: false, code: e.code || null, error: e.message, retryAt: e.retryAt || null };
        }
    }

    return {
        start,
        fetchChampion,
        rateLimitStatus: () => (scraper.rateLimitStatus ? scraper.rateLimitStatus() : { blockedUntil: 0 }),
        cancel() { if (abort) abort.abort(); return true; },
        isRunning: () => !!abort,
        status: () => ({ running: !!abort, jobs: current ? current.jobs : [], index: current ? current.index : 0 }),
        // The renderer stored a COMPLETE dataset for this patch: its resume file is no longer needed.
        confirmStored(patch) { deleteResume(patch); return true; },
        fetchDetail,
        readResume, resumePath
    };
}

module.exports = { createRunner };
