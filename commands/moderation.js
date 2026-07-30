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
const { parseRoleEmojiPairs, saveVerifyPanel } = require('../utils/verifyPanel');

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
    //
    // ・role のみ指定        → 従来通り、ボタン形式（1ロール）の認証パネル
    // ・roles に2つ以上指定  → リアクション形式（無制限ロール）の認証パネル
    //   roles の書式: "😀:@Role1, 😆:@Role2, <:custom:1234...>:@Role3"
    if (commandName === 'verify') {
        if (await checkBotPermissionsOrReply(interaction, [
            PermissionsBitField.Flags.ManageRoles,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.AddReactions,
        ])) return true;

        const role       = options.getRole('role');
        const rolesInput = options.getString('roles');
        const title      = options.getString('title') ?? '認証パネル';

        // ── 複数ロール（リアクション形式）────────────────────
        if (rolesInput) {
            const pairs = parseRoleEmojiPairs(rolesInput);

            if (pairs.length < 2) {
                await interaction.editReply({
                    content:
                        '❌ `roles` には2つ以上の「絵文字:ロール」のペアを指定してください。\n' +
                        '例: `😀:@Role1, 😆:@Role2`\n' +
                        '（1つだけ付与したい場合は `role` オプションを使用してください）'
                });
                return true;
            }

            const desc = options.getString('description') ?? '取得したいロールに対応する絵文字を押してください。';
            const roleList = pairs.map(p => `${p.emoji} → <@&${p.roleId}>`).join('\n');

            const embed = new EmbedBuilder()
                .setTitle(title)
                .setDescription(`${desc}\n\n${roleList}`)
                .setColor(0x3498DB);

            // 公開メッセージとしてチャンネルに送信
            const sentMessage = await interaction.channel.send({ embeds: [embed] });

            // 絵文字リアクションを順番に付与（レート制限回避のため少し間隔を空ける）
            const mapping = {};
            for (const pair of pairs) {
                try {
                    await sentMessage.react(pair.emoji);
                    mapping[pair.key] = pair.roleId;
                    await new Promise(r => setTimeout(r, 300));
                } catch (e) {
                    console.error('[verify] リアクション付与失敗:', pair.emoji, e);
                }
            }

            if (Object.keys(mapping).length === 0) {
                await sentMessage.delete().catch(() => {});
                await interaction.editReply({ content: '❌ 絵文字の付与にすべて失敗したため、パネルの設置を中止しました。絵文字の指定が正しいか確認してください。' });
                return true;
            }

            await saveVerifyPanel(db, sentMessage.id, interaction.guild.id, interaction.channel.id, mapping);

            await interaction.editReply({ content: `✅ 複数ロール対応の認証パネル（リアクション形式・${Object.keys(mapping).length}ロール）を設置しました。` });
            sendCommandLog(interaction, commandName, db);
            return true;
        }

        // ── 単一ロール（ボタン形式）─────────────────────────
        if (!role) {
            await interaction.editReply({ content: '❌ `role`（1つのロール）または `roles`（2つ以上のロール）のいずれかを指定してください。' });
            return true;
        }

        const desc = options.getString('description') ?? '以下のボタンを押して認証を完了してください。';

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
