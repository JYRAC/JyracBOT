'use strict';

const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    StringSelectMenuBuilder,
    MessageFlags,
} = require('discord.js');
const { sendCommandLog } = require('../utils/permissions');

/**
 * メッセージング系コマンドを処理する
 * /receive-notifications /notice /broadcast /request /help
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('firebase-admin').firestore.Firestore} db
 * @param {Map<string, string>} broadcastRoleMap
 * @returns {Promise<boolean>}
 */
async function handleMessagingCommand(interaction, db, broadcastRoleMap) {
    const { commandName, options } = interaction;

    // ── /receive-notifications ────────────────────────────────
    if (commandName === 'receive-notifications') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const doc = await db.collection('subscribers').doc(interaction.user.id).get();

        if (doc.exists) {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('n_rem').setLabel('解除する').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('bulk_no').setLabel('キャンセル').setStyle(ButtonStyle.Secondary)
            );
            return void await interaction.editReply({ content: '既に通知登録されています。解除しますか？', components: [row] });
        }

        await db.collection('subscribers').doc(interaction.user.id).set({ date: new Date() });
        await interaction.editReply('✅ 重要なお知らせの通知登録が完了しました！');
        sendCommandLog(interaction, commandName, db);
        return true;
    }

    // ── /notice / /broadcast ──────────────────────────────────
    if (commandName === 'notice' || commandName === 'broadcast') {
        if (options.getString('password') !== process.env.BROADCAST_PASSWORD) {
            await interaction.reply({ content: '❌ パスワードが一致しません。', flags: MessageFlags.Ephemeral });
            return true;
        }

        if (commandName === 'broadcast') {
            broadcastRoleMap.set(interaction.user.id, options.getRole('target-role').id);

            const modal = new ModalBuilder()
                .setCustomId('broadcast_modal')
                .setTitle('ロール宛て一斉DM');

            modal.addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('dm_speaker')
                        .setLabel('発言者')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('dm_text')
                        .setLabel('送信するメッセージ内容')
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('dm_url')
                        .setLabel('URL（任意）')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                )
            );

            await interaction.showModal(modal);
            sendCommandLog(interaction, commandName, db);
            return true;
        }

        // /notice
        const modal = new ModalBuilder()
            .setCustomId('notice_modal')
            .setTitle('お知らせ一斉DM');

        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('dm_text')
                    .setLabel('送信するメッセージ内容')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true)
            )
        );

        await interaction.showModal(modal);
        sendCommandLog(interaction, commandName, db);
        return true;
    }

    // ── /request ──────────────────────────────────────────────
    if (commandName === 'request') {
        const modal = new ModalBuilder()
            .setCustomId('req_modal')
            .setTitle('新規コマンド作成依頼');

        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('r_name').setLabel('あなたのお名前').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('r_cmd').setLabel('希望するコマンド名 (例: /test)').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('r_desc').setLabel('詳しい機能・説明').setStyle(TextInputStyle.Paragraph).setRequired(true))
        );

        await interaction.showModal(modal);
        sendCommandLog(interaction, commandName, db);
        return true;
    }

    // ── /help ─────────────────────────────────────────────────
    if (commandName === 'help') {
        const select = new StringSelectMenuBuilder()
            .setCustomId('help_select')
            .setPlaceholder('詳細を見たいコマンドを選択')
            .addOptions([
                { label: '/verify (認証)',                     value: 'h_verify' },
                { label: '/ticket (サポート)',                 value: 'h_ticket' },
                { label: '/log (管理ログ)',                    value: 'h_log' },
                { label: '/role-confirmation (確認)',          value: 'h_role' },
                { label: '/export (チャンネルエクスポート)',   value: 'h_export' },
                { label: '/earthquake-setup (地震通知設定)',   value: 'h_earthquake' },
                { label: '/earthquake-test (疑似地震テスト)', value: 'h_eqtest' },
                { label: '/weather-nerv (NERV気象情報)',       value: 'h_nerv' },
            ]);

        await interaction.reply({
            content: '📜 **コマンドヘルプ**\n詳細を確認したい機能を選択してください。',
            components: [new ActionRowBuilder().addComponents(select)],
            flags: MessageFlags.Ephemeral
        });
        sendCommandLog(interaction, commandName, db);
        return true;
    }

    return false;
}

module.exports = { handleMessagingCommand };
