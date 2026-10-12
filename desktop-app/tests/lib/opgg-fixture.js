// Synthetic op.gg pages in the shape profile-seasons.js reads (Next.js RSC flight chunks in self.__next_f.push calls).
// Made-up players and numbers only; no real account data.
const ACTION_ID = '4028494596c44675d8e9f617b8f659312f3b678072';
const ACTION_CHUNK = '1007-a1b2c3d4e5f60007';                       // the script file that holds the server-action id
const CHUNKS = Array.from({ length: 24 }, (_, i) => `${1000 + i}-a1b2c3d4e5f6${String(i).padStart(4, '0')}`);

const rank = (value, division, lp) => ({ value, division, lp });
const entry = (season, end, peak) => ({ season, rank_entries: { rank_info: end || { value: 'Unranked' }, high_rank_info: peak || { value: '' } } });

// Past seasons. Solo: 5 ranked seasons (S2024 unranked, dropped by the parser), peak Master. Flex: 4 seasons, peak Diamond.
const SOLO = [
    entry('S2025', rank('emerald', 1, 75), rank('diamond', 4, 91)),
    entry('S2024', null, null),
    entry('S2023 S2', rank('master', 1, 120), rank('master', 1, 180)),
    entry('S2023 S1', rank('diamond', 2, 40), rank('diamond', 1, 60)),
    entry('S2022', rank('platinum', 1, 10), rank('diamond', 4, 0)),
    entry('S2021', rank('gold', 2, 55), rank('platinum', 4, 12))
];
const FLEX = [
    entry('S2025', rank('platinum', 2, 30), rank('platinum', 1, 50)),
    entry('S2024 S3', rank('diamond', 3, 0), rank('diamond', 2, 20)),
    entry('S2024 S1', rank('gold', 1, 70), rank('platinum', 4, 0)),
    entry('S2023 S2', rank('silver', 1, 10), rank('gold', 4, 0))
];
// This season's role share (play-style card tooltips): bot-lane main.
const ROLES = [['Bottom', 80, 12], ['Support', 7, 1], ['Mid', 7, 1], ['Top', 6, 1], ['Jungle', 0, 0]];

function roleHtml() {
    return ROLES.map(([n, pct, g]) => `<div class="text-[#ffc659]">${n}</div><div><span>Pick share</span> <strong class="x">${pct}%</strong><span>Games</span> <strong class="x">${g}G</strong></div>`).join('');
}

// One player page. opuid = op.gg's own player id; chunkBase = where the <script src> files live (must end with "_next/").
function page({ opuid, chunkBase = 'https://c-lol-web.op.gg/app-router/releases/test/_next/' } = {}) {
    const rsc = [
        `0:["$","html",null,{"season":{"display_value":"S2026","season_id":33},"summoner":{"puuid":"${opuid}","game_name":"x"}}]\n`,
        `1:["$","div",null,{"puuid":"${opuid}","children":"${roleHtml().replace(/"/g, '\\"')}"}]\n`,
        `2:["$","section",null,{"children":"Ranked Solo/Duo","past_seasons":${JSON.stringify(SOLO)}}]\n`,
        `3:["$","section",null,{"children":"Ranked Flex","past_seasons":${JSON.stringify(FLEX)},"puuid":"${opuid}"}]\n`,
        `4:I["static/chunks/${CHUNKS[3]}.js"]\n`
    ];
    const scripts = CHUNKS.map(c => `<script src="${chunkBase}static/chunks/${c}.js" async=""></script>`).join('\n');
    const pushes = rsc.map(t => `<script>self.__next_f.push([1,${JSON.stringify(t)}])</script>`).join('\n');
    return `<!DOCTYPE html><html><head><title>op.gg test page</title>\n${scripts}\n</head><body><main>${'<div class="pad"></div>'.repeat(60)}</main>\n${pushes}\n</body></html>`;
}

// The script file that registers the champion-stats server action.
function chunk(name, actionId = ACTION_ID) {
    if (name !== ACTION_CHUNK) return '// nothing here';
    return `"use strict";(self.webpackChunk=self.webpackChunk||[]).push([[1007],{5:(e,t,a)=>{a.d(t,{x:()=>i});var r=a(1),i=(0,r.createServerReference)("${actionId}",r.callServer,void 0,r.findSourceMapURL,"getSummaryRankedMostChampions")}}]);`;
}

// Server-action answer for the account under test: 12 games, 7 wins, 7 champions (Caitlyn first).
const c = (name, key, play, win, kda, k, d, a, cs) => ({ is_all_champions: false, name, key, play, win, lose: play - win, win_rate: Math.round(win / play * 100), kda: { kda, avg_kill: k, avg_death: d, avg_assist: a }, cs: 200, cs_per_min: cs });
const OWNER_CHAMPS = [c('Caitlyn', 'caitlyn', 3, 2, 3.13, 9, 5, 6.7, 7.6), c('Ezreal', 'ezreal', 3, 0, 1.2, 5, 6.7, 3, 7.7), c('Lulu', 'lulu', 2, 2, 6.67, 1, 3, 19, 3.7),
    c('Xayah', 'xayah', 1, 1, 2, 9, 8, 7, 9.5), c('Varus', 'varus', 1, 1, 4, 6, 3, 6, 8), c('Sona', 'sona', 1, 1, 9, 2, 1, 7, 1.2), c('Draven', 'draven', 1, 0, 0.8, 3, 6, 2, 6.9)];
function actionBody(list = OWNER_CHAMPS, extraTotal = 0) {
    if (!list.length) return '0:{"a":"$@1","f":"","b":"1"}\n1:[]\n';
    const tot = list.reduce((s, x) => s + x.play, 0) + extraTotal, w = list.reduce((s, x) => s + x.win, 0);
    const all = { is_all_champions: true, name: '1', key: '$undefined', play: tot, win: w, lose: tot - w, win_rate: Math.round(w / tot * 100), kda: { kda: 2.92, avg_kill: 7, avg_death: 5.4, avg_assist: 8.8 }, cs: 204, cs_per_min: 7 };
    return '0:{"a":"$@1","f":"","b":"1"}\n1:' + JSON.stringify([all, ...list]) + '\n';
}

module.exports = { page, chunk, actionBody, champRow: c, ACTION_ID, ACTION_CHUNK, CHUNKS, OWNER_CHAMPS };
