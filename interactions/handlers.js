'use strict';

const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    PermissionsBitField,
    MessageFlags,
} = require('discord.js');
const { sendLog } = require('../utils/permissions');

// ─── ボタン操作 ────────────────────────────────────────────────

/**
 * ボタンインタラクションを処理する
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {import('firebase-admin').firestore.Firestore} db
 * @param {Map<string, string|null>} ticketMessages
 */
async function handleButton(interaction, db, ticketMessages) {
    const { customId } = interaction;

    // 認証ボタン
    if (customId.startsWith('v_role_')) {
        const roleId = customId.split('_')[2];
        await interaction.reply({ content: '認証を処理しています...', flags: MessageFlags.Ephemeral });
        try {
            await interaction.member.roles.add(roleId);
            await interaction.editReply({ content: '✅ 認証が完了しました！ロールを付与しました。' });

            sendLog(interaction.guild, new EmbedBuilder()
                .setTitle('🔐 認証ログ')
                .addFields(
                    { name: '使用者',     value: `${interaction.user}`, inline: true },
                    { name: '使用コマンド', value: '認証ボタン',        inline: true },
                    { name: '日時',       value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
                    { name: '取得ロール', value: `<@&${roleId}>`,       inline: false }
                )
                .setColor(0x2ECC71)
                .setTimestamp(),
                db
            );
        } catch {
            await interaction.editReply({ content: '❌ ロールの付与に失敗しました。Botのロール順位を確認してください。' });
        }
        return;
    }

    // 一括削除確認
    if (customId.startsWith('bulk_yes_')) {
        const amount = parseInt(customId.split('_')[2]);
        const chName = interaction.channel.name;
        await interaction.update({ content: 'メッセージを削除しています...', components: [] });
        try {
            await interaction.channel.bulkDelete(amount, true);
            sendLog(interaction.guild, new EmbedBuilder()
                .setTitle('🗑️ メッセージ削除ログ')
                .addFields(
                    { name: '使用者',     value: `${interaction.user}`, inline: true },
                    { name: '使用コマンド', value: '/delete',           inline: true },
                    { name: '日時',       value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
                    { name: 'チャンネル', value: `**#${chName}**`,      inline: true },
                    { name: '削除件数',   value: `${amount}件`,         inline: true }
                )
                .setColor(0xE74C3C)
                .setTimestamp(),
                db
            );
        } catch (e) {
            console.error(e);
        }
        return;
    }

    // チケット作成ボタン
    if (customId.startsWith('tkt_')) {
        const parts       = customId.split('_');
        const adminRoleId = parts[1];
        const key         = parts.slice(2).join('_');
        await interaction.reply({ content: 'チケットチャンネルを作成しています...', flags: MessageFlags.Ephemeral });
        try {
            const channel = await interaction.guild.channels.create({
                name: `🎫｜${interaction.user.username}`,
                type: ChannelType.GuildText,
                permissionOverwrites: [
                    { id: interaction.guild.id,  deny:  [PermissionsBitField.Flags.ViewChannel] },
                    { id: interaction.user.id,   allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
                    { id: adminRoleId,            allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
                ]
            });

            const customDesc = ticketMessages.get(key);
            const panelDesc  = customDesc != null ? customDesc : '発行ありがとうございます。担当者が来るのを今しばらくお待ちください。';

            const ticketEmbed = new EmbedBuilder()
                .setTitle('📋 パネルでチケット発行')
                .addFields(
                    { name: '発行者',     value: `${interaction.user}` },
                    { name: 'メッセージ', value: panelDesc }
                )
                .setColor(0x9B59B6)
                .setTimestamp();

            await channel.send({
                content: `<@&${adminRoleId}>`,
                embeds: [ticketEmbed],
                components: [
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('t_close').setLabel('チケットを閉じる').setStyle(ButtonStyle.Danger)
                    )
                ]
            });

            await interaction.editReply({ content: `✅ チケットを作成しました: ${channel}` });

            sendLog(interaction.guild, new EmbedBuilder()
                .setTitle('🎫 チケット作成ログ')
                .addFields(
                    { name: '使用者',     value: `${interaction.user}`, inline: true },
                    { name: '使用コマンド', value: 'チケット作成ボタン', inline: true },
                    { name: '日時',       value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
                    { name: 'チャンネル', value: `${channel}`,          inline: false }
                )
                .setColor(0x3498DB)
                .setTimestamp(),
                db
            );
        } catch {
            await interaction.editReply({ content: '❌ チャンネルの作成に失敗しました。' });
        }
        return;
    }

    // チケットを閉じる
    if (customId === 't_close') {
        await interaction.reply({ content: 'チケットを2秒後に削除します...', flags: MessageFlags.Ephemeral });
        sendLog(interaction.guild, new EmbedBuilder()
            .setTitle('🔒 チケット終了ログ')
            .addFields(
                { name: '使用者',     value: `${interaction.user}`,               inline: true },
                { name: '使用コマンド', value: 'チケットを閉じるボタン',          inline: true },
                { name: '日時',       value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
                { name: 'チャンネル', value: `**#${interaction.channel.name}**`, inline: false }
            )
            .setColor(0x607D8B)
            .setTimestamp(),
            db
        );
        setTimeout(() => { interaction.channel.delete().catch(() => {}); }, 2000);
        return;
    }

    // 通知解除
    if (customId === 'n_rem') {
        await db.collection('subscribers').doc(interaction.user.id).delete();
        await interaction.update({ content: '🗑️ 通知登録を解除しました。', components: [] });
        return;
    }

    // キャンセル
    if (customId === 'bulk_no') {
        await interaction.update({ content: '操作をキャンセルしました。', components: [] });
        return;
    }
}

// ─── モーダル送信 ──────────────────────────────────────────────

/**
 * モーダルサブミットインタラクションを処理する
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 * @param {import('discord.js').Client} client
 * @param {import('firebase-admin').firestore.Firestore} db
 * @param {Map<string, string>} broadcastRoleMap
 */
async function handleModal(interaction, client, db, broadcastRoleMap) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // /request モーダル
    if (interaction.customId === 'req_modal') {
        const embed = new EmbedBuilder()
            .setTitle('📩 新規コマンド作成依頼')
            .addFields(
                { name: '依頼者',     value: interaction.fields.getTextInputValue('r_name') },
                { name: '希望コマンド', value: interaction.fields.getTextInputValue('r_cmd') },
                { name: '機能詳細',   value: interaction.fields.getTextInputValue('r_desc') }
            )
            .setColor(0xFFA500);
        try {
            const adminUser = await client.users.fetch(process.env.ADMIN_USER_ID);
            await adminUser.send({ embeds: [embed] });
            await interaction.editReply('✅ 開発者宛てに依頼を送信しました！');
        } catch {
            await interaction.editReply('❌ 送信に失敗しました。環境変数を確認してください。');
        }
        return;
    }

    // /notice モーダル
    if (interaction.customId === 'notice_modal') {
        const textContent = interaction.fields.getTextInputValue('dm_text');
        const subs = await db.collection('subscribers').get();
        let count = 0;
        for (const doc of subs.docs) {
            try {
                const u = await client.users.fetch(doc.id);
                await u.send(`📢 **重要なお知らせ**\n\n${textContent}`);
                count++;
            } catch {}
        }
        await interaction.editReply(`✅ 登録ユーザー ${count} 名にお知らせを送信しました。`);
        return;
    }

    // /broadcast モーダル
    if (interaction.customId === 'broadcast_modal') {
        const roleId = broadcastRoleMap.get(interaction.user.id);
        if (!roleId) {
            await interaction.editReply('❌ セッションが切れました。もう一度コマンドからやり直してください。');
            return;
        }
        broadcastRoleMap.delete(interaction.user.id);

        const speaker     = interaction.fields.getTextInputValue('dm_speaker');
        const textContent = interaction.fields.getTextInputValue('dm_text');
        const url         = interaction.fields.getTextInputValue('dm_url').trim();

        const dmEmbed = new EmbedBuilder()
            .setTitle('📢 お知らせ')
            .addFields(
                { name: '発言者', value: speaker },
                { name: '内容',   value: textContent }
            )
            .setColor(0xE67E22)
            .setTimestamp();

        if (url) dmEmbed.addFields({ name: 'URL', value: url });

        const members = (await interaction.guild.members.fetch())
            .filter(m => m.roles.cache.has(roleId) && !m.user.bot);
        let count = 0;
        for (const [, m] of members) {
            try {
                await m.send({ embeds: [dmEmbed] });
                count++;
                await new Promise(r => setTimeout(r, 800));
            } catch {}
        }
        await interaction.editReply(`✅ 指定ロールのメンバー ${count} 名にDMを送信しました。`);
        return;
    }
}

// ─── セレクトメニュー ──────────────────────────────────────────

/**
 * セレクトメニューインタラクションを処理する
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
async function handleSelectMenu(interaction) {
    if (interaction.customId !== 'help_select') return;

    const value = interaction.values[0];
    const helpTexts = {
        h_verify:    '**/verify**\nロール管理権限が必要です。ボタン付きの認証パネルを設置し、ユーザーが手軽にロールを獲得できるようにします。',
        h_ticket:    '**/ticket**\nチャンネル管理権限が必要です。ユーザー個別の問い合わせ用プライベートチャンネルを開設するパネルを設置します。',
        h_log:       '**/log**\n管理者権限が必要です。認証や一括削除のアクションが行われた際に送信されるログチャンネルの指定・解除を行います。',
        h_role:      '**/role-confirmation**\nモデレーター権限が必要です。対象のユーザーが現在持っている全ロールの一覧を表示します。',
        h_export:    '**/export**\nメッセージ管理権限が必要です。指定したチャンネルのメッセージを.txtファイルにエクスポートします。\nオプション: `channel` `limit(1〜10000)` `before` `after`',
        h_earthquake:'**/earthquake-setup**\nチャンネル管理権限が必要です。地震情報をリアルタイムで通知するチャンネルを設定します。\n`channel` を省略すると設定を解除します。\nデータ元: 気象庁非公式JSON API\n通知される情報: 震度速報（震度3以上）・震源に関する情報・震源・震度情報（確定報）',
        h_eqtest:    '**/earthquake-test**\nチャンネル管理権限が必要です。設定済みの通知チャンネルに疑似地震通知を送信して表示を確認できます。\ntype:\n　・震源・震度情報（確定報）\n　・EEW形式\n　・震度速報→震源情報→確定報 の連続テスト\n　・津波警報・注意報\nlocation: 震源地プリセット（省略時はランダム）',
        h_nerv:      '**/weather-nerv**\n特務機関NERVの気象警報・注意報・地震情報などを都道府県名で検索し、最新の1件を表示します。\nprefecture: 都道府県名（例: 東京都、大阪府、福岡県、北海道）\nデータ元: 特務機関NERV (@UN_NERV) RSS',
    };

    const helpText = helpTexts[value] ?? '詳細情報が見つかりません。';
    await interaction.update({ content: `📜 **ヘルプ詳細**\n\n${helpText}`, components: [interaction.message.components[0]] });
}

module.exports = { handleButton, handleModal, handleSelectMenu };
