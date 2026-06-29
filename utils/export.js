'use strict';

/**
 * チャンネルのメッセージを全件（または指定件数）取得する
 * @param {import('discord.js').TextChannel} channel
 * @param {{ limit?: number|null, before?: string, after?: string }} options
 * @returns {Promise<import('discord.js').Message[]>}
 */
async function fetchAllMessages(channel, { limit = null, before, after } = {}) {
    const messages = [];
    let lastId = before || null;
    const unlimited = limit === null;

    while (unlimited || messages.length < limit) {
        const remaining = unlimited ? 100 : Math.min(limit - messages.length, 100);
        const options = { limit: remaining };
        if (lastId) options.before = lastId;
        if (after && messages.length === 0) options.after = after;

        const batch = await channel.messages.fetch(options);
        if (batch.size === 0) break;

        const sorted = [...batch.values()].sort(
            (a, b) => a.createdTimestamp - b.createdTimestamp
        );
        messages.unshift(...sorted);
        lastId = batch.last().id;
        if (batch.size < remaining) break;
    }

    if (after) {
        const afterMsg = messages.find((m) => m.id === after);
        const afterIndex = afterMsg ? messages.indexOf(afterMsg) + 1 : 0;
        const sliced = messages.slice(afterIndex);
        return unlimited ? sliced : sliced.slice(0, limit);
    }

    return unlimited ? messages : messages.slice(0, limit);
}

/**
 * メッセージ配列をテキスト形式にフォーマットする
 * @param {import('discord.js').Message[]} messages
 * @param {import('discord.js').TextChannel} channel
 * @param {import('discord.js').Guild} guild
 * @returns {string}
 */
function formatMessagesToText(messages, channel, guild) {
    const lines = [];
    const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

    lines.push('='.repeat(60));
    lines.push('Discord チャンネルエクスポート');
    lines.push('='.repeat(60));
    lines.push(`サーバー   : ${guild.name}`);
    lines.push(`チャンネル : #${channel.name}`);
    lines.push(`取得件数   : ${messages.length} 件`);
    lines.push(`エクスポート日時: ${now} (JST)`);
    lines.push('='.repeat(60));
    lines.push('');

    for (const msg of messages) {
        const ts = msg.createdAt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
        const author = msg.author.username;
        const tag = msg.author.discriminator && msg.author.discriminator !== '0'
            ? `#${msg.author.discriminator}` : '';

        lines.push(`[${ts}] ${author}${tag}`);
        if (msg.content) lines.push(msg.content);

        if (msg.attachments.size > 0) {
            msg.attachments.forEach((att) => {
                lines.push(`[添付ファイル] ${att.name}: ${att.url}`);
            });
        }

        if (msg.embeds.length > 0) {
            msg.embeds.forEach((embed) => {
                if (embed.title)       lines.push(`[Embed タイトル] ${embed.title}`);
                if (embed.description) lines.push(`[Embed 説明] ${embed.description}`);
                if (embed.url)         lines.push(`[Embed URL] ${embed.url}`);
            });
        }

        if (msg.reactions.cache.size > 0) {
            const reactions = msg.reactions.cache
                .map((r) => `${r.emoji.name}×${r.count}`)
                .join('  ');
            lines.push(`[リアクション] ${reactions}`);
        }

        if (msg.reference?.messageId) {
            lines.push(`[返信先 ID] ${msg.reference.messageId}`);
        }

        lines.push('');
    }

    lines.push('='.repeat(60));
    lines.push('エクスポート終了');
    lines.push('='.repeat(60));

    return lines.join('\n');
}

module.exports = { fetchAllMessages, formatMessagesToText };
