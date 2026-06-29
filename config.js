'use strict';

const { PermissionsBitField } = require('discord.js');

// ─── コマンド分類 ──────────────────────────────────────────────

/** 誰でも使えるコマンド（権限チェック不要） */
const PUBLIC_COMMANDS = ['receive-notifications', 'request', 'help'];

/** モーダルを表示するコマンド（deferReply不可） */
const MODAL_COMMANDS = ['notice', 'broadcast', 'request'];

/** オーナー専用コマンド */
const OWNER_COMMANDS = ['grant-access', 'revoke-access', 'list-access'];

// ─── コマンドごとに必要な権限 ─────────────────────────────────

const COMMAND_REQUIRED_PERMISSIONS = {
    'log':               PermissionsBitField.Flags.Administrator,
    'verify':            PermissionsBitField.Flags.ManageRoles,
    'delete':            PermissionsBitField.Flags.ManageMessages,
    'ticket':            PermissionsBitField.Flags.ManageChannels,
    'give-role':         PermissionsBitField.Flags.ManageRoles,
    'remove-role':       PermissionsBitField.Flags.ManageRoles,
    'role-confirmation': PermissionsBitField.Flags.ModerateMembers,
    'notice':            PermissionsBitField.Flags.ManageRoles,
    'broadcast':         PermissionsBitField.Flags.ManageRoles,
    'export':            PermissionsBitField.Flags.ManageMessages,
    'earthquake-setup':  PermissionsBitField.Flags.ManageChannels,
    'earthquake-test':   PermissionsBitField.Flags.ManageChannels,
    'weather-setup':     PermissionsBitField.Flags.ManageChannels,
};

// ─── Bot アクティビティリスト ──────────────────────────────────

const ACTIVITIES = [
    "JYRAC公式Instは'2024nsfproject'で検索！",
    "JYRAC公式Instは'Jyrac_official'で検索！",
    "お問い合わせはDiscordID: pitayakun7 まで",
    "広告募集中",
];

module.exports = {
    PUBLIC_COMMANDS,
    MODAL_COMMANDS,
    OWNER_COMMANDS,
    COMMAND_REQUIRED_PERMISSIONS,
    ACTIVITIES,
};
