'use strict';

const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    PermissionsBitField,
} = require('discord.js');
const { sendCommandLog, sendLog, checkBotPermissionsOrReply } = require('../utils/permissions');

/**
 * モデレーション系コマンドを処理する
 * /log /verify /delete /ticket /give-role /remove-role /role-confirmation
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('firebase-admin').firestore.Firestore} db
 * @param {Map<string, string|null>} ticketMessages
 * @returns {Promise<boolean>}
 */
async function handleModerationCommand(interaction, db, ticketMessages) {
    const { commandName, options } = interaction;

    // ── /log ──────────────────────────────────────────────────
    if (commandName === 'log') {
        const channel = options.getChannel('channel');
        try {
            const logDoc = await db.collection('log_settings').doc(interaction.guild.id).get();

            if (channel) {
                await db.collection('log_settings').doc(interaction.guild.id).set({
                    channelId: channel.id,
                    guildName: interaction.guild.name
                });
                const isUpdate = logDoc.exists && logDoc.data().channelId !== channel.id;
                const replyMsg = isUpdate
                    ? `🔄 以前の設定を解除し、ログ送信先を ${channel} に更新しました。`
                    : `✅ ログ送信先を ${channel} に設定しました。`;
                await interaction.editReply(replyMsg);
                sendCommandLog(interaction, commandName, db);
            } else {
                if (!logDoc.exists) return void await interaction.editReply('❌ 現在、ログ設定は登録されていません。');
                await db.collection('log_settings').doc(interaction.guild.id).delete();
                await interaction.editReply('🗑️ ログの設定を解除しました。');
            }
        } catch {
            await interaction.editReply('エラーが発生しました。');
        }
        return true;
    }

    // ── /verify ───────────────────────────────────────────────
    // パネルはチャンネル全体に表示する（ephemeral不可）ため、
    // deferReply 済みの場合は followUp で公開送信し、自分への返信はその旨だけにする
    if (commandName === 'verify') {
        if (await checkBotPermissionsOrReply(interaction, [
            PermissionsBitField.Flags.ManageRoles,
            PermissionsBitField.Flags.SendMessages,
        ])) return true;

        const role  = options.getRole('role');
        const title = options.getString('title') ?? '認証パネル';
        const desc  = options.getString('description') ?? '以下のボタンを押して認証を完了してください。';

        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(desc)
            .setColor(0x3498DB);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`v_role_${role.id}`)
                .setLabel('✅ 認証')
                .setStyle(ButtonStyle.Success)
        );

        // 公開メッセージとしてチャンネルに送信
        await interaction.channel.send({ embeds: [embed], components: [row] });
        // コマンド実行者への確認（ephemeral）
        await interaction.editReply({ content: '✅ 認証パネルを設置しました。' });
        sendCommandLog(interaction, commandName, db);
        return true;
    }

    // ── /delete ───────────────────────────────────────────────
    if (commandName === 'delete') {
        if (await checkBotPermissionsOrReply(interaction, [
            PermissionsBitField.Flags.ManageMessages,
        ])) return true;

        const amount = options.getInteger('amount');
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`bulk_yes_${amount}`).setLabel('削除').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('bulk_no').setLabel('中止').setStyle(ButtonStyle.Secondary)
        );
        await interaction.editReply({ content: `${amount}件のメッセージを削除しますか？`, components: [row] });
        sendCommandLog(interaction, commandName, db);
        return true;
    }

    // ── /ticket ───────────────────────────────────────────────
    // パネルはチャンネル全体に表示する（ephemeral不可）
    if (commandName === 'ticket') {
        if (await checkBotPermissionsOrReply(interaction, [
            PermissionsBitField.Flags.ManageChannels,
            PermissionsBitField.Flags.SendMessages,
        ])) return true;

        const adminRole = options.getRole('admin-role');
        const key = `t_${Date.now()}`;
        ticketMessages.set(key, options.getString('panel-desc') ?? null);

        const embed = new EmbedBuilder()
            .setTitle(options.getString('title') ?? 'サポートチケット')
            .setDescription(options.getString('description') ?? 'チケットを作成するには下のボタンを押してください。')
            .setColor(0x9B59B6);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`tkt_${adminRole.id}_${key}`)
                .setLabel('🎫 チケットを作成')
                .setStyle(ButtonStyle.Primary)
        );

        // 公開メッセージとしてチャンネルに送信
        await interaction.channel.send({ embeds: [embed], components: [row] });
        // コマンド実行者への確認（ephemeral）
        await interaction.editReply({ content: '✅ チケットパネルを設置しました。' });
        sendCommandLog(interaction, commandName, db);
        return true;
    }

    // ── /give-role / /remove-role ─────────────────────────────
    if (['give-role', 'remove-role'].includes(commandName)) {
        if (await checkBotPermissionsOrReply(interaction, [
            PermissionsBitField.Flags.ManageRoles,
        ])) return true;

        const member = options.getMember('target');
        const role   = options.getRole('role');
        try {
            if (commandName === 'give-role') {
                await member.roles.add(role);
                await interaction.editReply({ content: `✅ ${member} にロール **${role.name}** を付与しました。` });
            } else {
                await member.roles.remove(role);
                await interaction.editReply({ content: `✅ ${member} からロール **${role.name}** を剥奪しました。` });
            }
            sendCommandLog(interaction, commandName, db);
        } catch {
            await interaction.editReply({ content: '❌ 権限不足などの理由により操作に失敗しました。' });
        }
        return true;
    }

    // ── /role-confirmation ────────────────────────────────────
    if (commandName === 'role-confirmation') {
        const member = options.getMember('target');
        if (!member) return void await interaction.editReply({ content: '❌ ユーザーが見つかりませんでした。' });

        const roles = member.roles.cache
            .filter(r => r.name !== '@everyone')
            .map(r => r.toString())
            .join(', ') || 'なし';

        const embed = new EmbedBuilder()
            .setTitle(`👤 ${member.user.username} のロール確認`)
            .setDescription(`所持しているロール一覧:\n${roles}`)
            .setColor(0x00AE86);

        await interaction.editReply({ embeds: [embed] });
        sendCommandLog(interaction, commandName, db);
        return true;
    }

    return false;
}

module.exports = { handleModerationCommand };
