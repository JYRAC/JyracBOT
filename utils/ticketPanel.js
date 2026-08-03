'use strict';

/**
 * /ticket panel で設置したパネルの既定値（カテゴリー未選択時のフォールバック）をFirestoreに保存するユーティリティ
 * 再起動しても内容が消えないよう、以前の実装（メモリ上のMap）からFirestore保存に変更した。
 */

const COLLECTION = 'ticket_panels';

/**
 * パネル設定を保存する
 * @param {import('firebase-admin').firestore.Firestore} db
 * @param {string} key
 * @param {{guildId: string, adminRoleId: string, panelDesc: string|null}} data
 */
async function saveTicketPanel(db, key, data) {
    await db.collection(COLLECTION).doc(key).set({
        ...data,
        createdAt: Date.now(),
    });
}

/**
 * パネル設定を取得する
 * @param {import('firebase-admin').firestore.Firestore} db
 * @param {string} key
 */
async function getTicketPanel(db, key) {
    const doc = await db.collection(COLLECTION).doc(key).get();
    return doc.exists ? doc.data() : null;
}

module.exports = { saveTicketPanel, getTicketPanel };
