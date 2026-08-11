'use strict';

/**
 * /ticket category-add / category-remove / category-list で使うカテゴリー管理ユーティリティ
 * サーバーごとに複数のチケットカテゴリー（例: 🐛バグ報告 / ❓質問 / その他）を登録し、
 * チケット作成時にユーザーへセレクトメニューで選ばせるために使用する。
 */

const COLLECTION = 'ticket_categories';

function docId(guildId, name) {
    return `${guildId}__${name}`;
}

/**
 * チケットカテゴリーを登録（新規 or 上書き）する
 * @param {import('firebase-admin').firestore.Firestore} db
 * @param {string} guildId
 * @param {{name: string, emoji: string, adminRoleId?: string|null, parentId?: string|null, panelDesc?: string|null}} data
 */
async function addTicketCategory(db, guildId, data) {
    await db.collection(COLLECTION).doc(docId(guildId, data.name)).set({
        guildId,
        name: data.name,
        emoji: data.emoji,
        adminRoleId: data.adminRoleId ?? null,
        parentId: data.parentId ?? null,
        panelDesc: data.panelDesc ?? null,
        updatedAt: Date.now(),
    });
}

/**
 * 指定サーバーのチケットカテゴリーを1件削除する
 * @returns {Promise<boolean>} 削除できた場合 true
 */
async function removeTicketCategory(db, guildId, name) {
    const ref = db.collection(COLLECTION).doc(docId(guildId, name));
    const doc = await ref.get();
    if (!doc.exists) return false;
    await ref.delete();
    return true;
}

/**
 * 指定サーバーに登録されているチケットカテゴリー一覧を取得する
 * @returns {Promise<Array<{name: string, emoji: string, adminRoleId: string|null, parentId: string|null, panelDesc: string|null}>>}
 */
async function listTicketCategories(db, guildId) {
    const snap = await db.collection(COLLECTION).where('guildId', '==', guildId).get();
    return snap.docs.map(d => d.data());
}

/**
 * 名前を指定して1件取得する
 */
async function getTicketCategory(db, guildId, name) {
    const doc = await db.collection(COLLECTION).doc(docId(guildId, name)).get();
    return doc.exists ? doc.data() : null;
}

module.exports = { addTicketCategory, removeTicketCategory, listTicketCategories, getTicketCategory };
