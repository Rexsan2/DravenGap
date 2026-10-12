// Realistic match-v5 timeline (documented shape). Participant 1 has the interesting events: undo of a purchase, a sale, a sale undo.
function timeline(id, minutes = 30) {
    const frames = [];
    for (let m = 0; m <= minutes; m++) {
        const participantFrames = {};
        for (let p = 1; p <= 10; p++) {
            const blue = p <= 5, adv = blue ? 1 : 0.8;       // blue ahead
            participantFrames[p] = { participantId: p, totalGold: Math.round((500 + m * (380 + p * 12)) * adv), xp: Math.round(m * 520 * adv), level: Math.min(18, 1 + Math.floor(m / 1.8)),
                minionsKilled: Math.round(m * (5.5 + (p % 5) * 0.4)), jungleMinionsKilled: p % 5 === 1 ? m * 3 : 0, currentGold: 300, position: { x: 1, y: 2 } };
        }
        frames.push({ timestamp: m * 60000, participantFrames, events: [] });
    }
    const ev = (m, e) => frames[m].events.push(e);
    const P = (t, pid, itemId) => ({ type: 'ITEM_PURCHASED', timestamp: t, participantId: pid, itemId });
    ev(0, P(1000, 1, 1055)); ev(0, P(2500, 1, 2003));
    ev(3, P(190000, 1, 1036)); ev(3, P(195000, 1, 1038)); ev(3, { type: 'ITEM_UNDO', timestamp: 197000, participantId: 1, beforeId: 1038, afterId: 0, goldGain: 1300 });
    ev(3, P(199000, 1, 1037));
    ev(8, P(500000, 1, 3006)); ev(8, { type: 'ITEM_SOLD', timestamp: 510000, participantId: 1, itemId: 2003 });
    ev(8, { type: 'ITEM_UNDO', timestamp: 511000, participantId: 1, beforeId: 0, afterId: 2003, goldGain: -50 });
    ev(14, P(840000, 1, 3031)); ev(14, { type: 'ITEM_DESTROYED', timestamp: 841000, participantId: 1, itemId: 1036 });
    ev(2, P(130000, 2, 3340));
    const order = [1, 2, 3, 1, 1, 4, 1, 2, 1, 2, 4, 2, 2, 3, 3, 4, 3, 3];     // participant 1: Q W E Q Q R ...
    order.forEach((s, i) => ev(Math.min(minutes, 1 + i), { type: 'SKILL_LEVEL_UP', timestamp: (1 + i) * 60000 - 500, participantId: 1, skillSlot: s, levelUpType: 'NORMAL' }));
    ev(5, { type: 'SKILL_LEVEL_UP', timestamp: 300000, participantId: 1, skillSlot: 1, levelUpType: 'EVOLVE' });
    ev(9, { type: 'CHAMPION_KILL', timestamp: 540000, killerId: 1, victimId: 6 });
    return { metadata: { matchId: id, participants: [] }, info: { frameInterval: 60000, frames } };
}
module.exports = { timeline };
