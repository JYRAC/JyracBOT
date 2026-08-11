'use strict';

const { EmbedBuilder } = require('discord.js');

/**
 * /adjustment （「調整さん」風の日程調整パネル）用のユーティリティ
 * Discord上で完結する簡易版として、候補日は最大5件までに対応する
 * （1メッセージに設置できるボタン行が最大5行のため、候補1件につき1行を使用する）
 */

const COLLECTION = 'adjustments';
// 1メッセージに設置できるボタン行は最大5行。候補用に4行、残り1行を「締め切る」ボタンに使うため4件が上限。
const MAX_CANDIDATES = 4;
const MARKS = { o: '⭕', s: '🔺', x: '❌' };
const MARK_LABEL = { o: '出席・参加できます', s: '未定・△', x: '不参加・×' };

/**
 * 候補日の複数行テキストをパースして配列にする（空行は除外、最大5件）
 * @param {string} raw
 * @returns {string[]}
 */
function parseCandidates(raw) {
    return raw
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .slice(0, MAX_CANDIDATES);
}

/**
 * 調整さんパネルをFirestoreに新規作成する
 */
async function createAdjustment(db, messageId, data) {
    await db.collection(COLLECTION).doc(messageId).set({
        guildId: data.guildId,
        channelId: data.channelId,
        creatorId: data.creatorId,
        title: data.title,
        deadline: data.deadline ?? null,
        candidates: data.candidates,
        responses: {},
        closed: false,
        createdAt: Date.now(),
    });
}

async function getAdjustment(db, messageId) {
    const doc = await db.collection(COLLECTION).doc(messageId).get();
    return doc.exists ? doc.data() : null;
}

/**
 * 1人分の1候補分の回答を記録する
 * @param {string} mark 'o' | 's' | 'x'
 */
async function setAdjustmentAnswer(db, messageId, userId, username, candidateIndex, mark) {
    const ref = db.collection(COLLECTION).doc(messageId);
    await db.runTransaction(async tx => {
        const doc = await tx.get(ref);
        if (!doc.exists) return;
        const data = doc.data();
        const responses = data.responses ?? {};
        const current = responses[userId]?.answers ?? new Array(data.candidates.length).fill(null);
        current[candidateIndex] = mark;
        responses[userId] = { username, answers: current };
        tx.update(ref, { responses });
    });
}

async function closeAdjustment(db, messageId) {
    await db.collection(COLLECTION).doc(messageId).update({ closed: true });
}

/**
 * 現在の回答状況からEmbedを組み立てる
 */
function buildAdjustmentEmbed(data) {
    const responses = data.responses ?? {};
    const userIds = Object.keys(responses);

    const lines = data.candidates.map((candidate, i) => {
        const counts = { o: 0, s: 0, x: 0 };
        const perUser = [];
        for (const uid of userIds) {
            const mark = responses[uid].answers[i];
            if (!mark) continue;
            counts[mark]++;
            perUser.push(`${responses[uid].username}${MARKS[mark]}`);
        }
        const tally = `⭕${counts.o} 🔺${counts.s} ❌${counts.x}`;
        const detail = perUser.length > 0 ? `\n　${perUser.join(' ')}` : '';
        return `**${i + 1}. ${candidate}**\n　${tally}${detail}`;
    });

    const embed = new EmbedBuilder()
        .setTitle(`🗓️ ${data.title}`)
        .setDescription(lines.join('\n\n'))
        .setColor(data.closed ? 0x95A5A6 : 0x1ABC9C)
        .setFooter({ text: data.closed ? '🔒 締め切り済み' : '各候補のボタンを押して回答してください（⭕参加 / 🔺未定 / ❌不可）' })
        .setTimestamp();

    if (data.deadline) embed.addFields({ name: '回答締切', value: data.deadline });

    return embed;
}

module.exports = {
    MAX_CANDIDATES,
    MARKS,
    MARK_LABEL,
    parseCandidates,
    createAdjustment,
    getAdjustment,
    setAdjustmentAnswer,
    closeAdjustment,
    buildAdjustmentEmbed,
};
