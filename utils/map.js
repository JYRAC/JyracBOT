'use strict';

const sharp = require('sharp');

/**
 * 緯度経度をタイル座標とピクセル座標に変換する
 */
function latLonToTileAndPixel(lat, lon, zoom) {
    const n = Math.pow(2, zoom);
    const latRad = lat * Math.PI / 180;
    const tileX = Math.floor((lon + 180) / 360 * n);
    const tileY = Math.floor(
        (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n
    );
    const pixX = Math.floor(((lon + 180) / 360 * n - tileX) * 256);
    const pixY = Math.floor(
        ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n - tileY) * 256
    );
    return { tileX, tileY, pixX, pixY };
}

/**
 * 国土地理院タイルを取得する
 */
async function fetchGSITile(zoom, x, y) {
    const url = `https://cyberjapandata.gsi.go.jp/xyz/blank/${zoom}/${x}/${y}.png`;
    const res = await fetch(url, {
        headers: { 'User-Agent': 'JYRACDiscordBot/1.0 (earthquake-notify)' }
    });
    if (!res.ok) throw new Error(`GSI Tile ${res.status}: ${url}`);
    return Buffer.from(await res.arrayBuffer());
}

/**
 * 震度スタンプSVGを生成する
 * 日本語文字を使わず記号表記（文字化け対策）
 */
function getScaleSvg(intStr) {
    const scaleMap = {
        '1':  { text: '1',  bg: '#f2f2ff', c: '#000000' },
        '2':  { text: '2',  bg: '#00aaff', c: '#000000' },
        '3':  { text: '3',  bg: '#0041ff', c: '#ffffff' },
        '4':  { text: '4',  bg: '#fae696', c: '#000000' },
        '5-': { text: '5-', bg: '#ffe600', c: '#000000' },
        '5+': { text: '5+', bg: '#ff9900', c: '#000000' },
        '6-': { text: '6-', bg: '#ff2800', c: '#ffffff' },
        '6+': { text: '6+', bg: '#a50021', c: '#ffffff' },
        '7':  { text: '7',  bg: '#b40068', c: '#ffffff' },
    };
    const s = scaleMap[intStr];
    if (!s) return null;
    const fontSize = intStr.length > 1 ? 11 : 13;
    return Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<svg width="24" height="24" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="24" height="24" rx="4" fill="${s.bg}" stroke="#555" stroke-width="1"/>` +
        `<text x="12" y="17" font-family="sans-serif" font-size="${fontSize}" font-weight="bold" fill="${s.c}" text-anchor="middle">${s.text}</text>` +
        `</svg>`,
        'utf8'
    );
}

/**
 * ISO6709形式の座標文字列をパースする
 * @returns {{ lat: number, lon: number, depthKm: number } | null}
 */
function parseISO6709(coordinate) {
    if (!coordinate) return null;
    const parts = coordinate.replace('/', '').split(/(?=[+-])/).filter(s => s !== '');
    if (parts.length < 2) return null;
    const lat = parseFloat(parts[0]);
    const lon = parseFloat(parts[1]);
    let depthKm = 0;
    if (parts.length >= 3) {
        const depthRaw = parseFloat(parts[2]);
        depthKm = Math.abs(depthRaw / 1000);
    }
    if (isNaN(lat) || isNaN(lon)) return null;
    return { lat, lon, depthKm };
}

/**
 * 震源地と各観測点を重ねた地図画像バッファを生成する
 * @param {number} epicLat
 * @param {number} epicLon
 * @param {{ lat: number, lon: number, int: string }[]} stations
 * @returns {Promise<Buffer|null>}
 */
async function buildJMAMapAttachment(epicLat, epicLon, stations = []) {
    if (epicLat == null || epicLon == null) return null;

    const zoom = 8;
    const TILE = 256;
    const HALF = 1;
    const GRID = HALF * 2 + 1;

    const { tileX: cx, tileY: cy, pixX: markerPixX, pixY: markerPixY }
        = latLonToTileAndPixel(epicLat, epicLon, zoom);

    const fetches = [];
    for (let dy = -HALF; dy <= HALF; dy++) {
        for (let dx = -HALF; dx <= HALF; dx++) {
            const gx = dx + HALF;
            const gy = dy + HALF;
            fetches.push(
                fetchGSITile(zoom, cx + dx, cy + dy)
                    .then(buf => ({ gx, gy, buf }))
                    .catch(() => null)
            );
        }
    }
    const tiles = await Promise.all(fetches);
    const canvasSize = TILE * GRID;

    const composites = tiles
        .filter(t => t !== null)
        .map(({ gx, gy, buf }) => ({ input: buf, left: gx * TILE, top: gy * TILE }));

    const drawnCoords = new Set();
    for (const st of stations) {
        if (st.lat == null || st.lon == null) continue;
        const coordKey = `${st.lat.toFixed(2)}_${st.lon.toFixed(2)}`;
        if (drawnCoords.has(coordKey)) continue;

        const { tileX: px, tileY: py, pixX: pPixX, pixY: pPixY }
            = latLonToTileAndPixel(st.lat, st.lon, zoom);

        const diffX = px - (cx - HALF);
        const diffY = py - (cy - HALF);

        if (diffX >= 0 && diffX < GRID && diffY >= 0 && diffY < GRID) {
            const absX = diffX * TILE + pPixX;
            const absY = diffY * TILE + pPixY;
            const svgBuf = getScaleSvg(st.int);
            if (svgBuf) {
                composites.push({
                    input: svgBuf,
                    left: Math.max(0, Math.min(canvasSize - 24, Math.floor(absX - 12))),
                    top:  Math.max(0, Math.min(canvasSize - 24, Math.floor(absY - 12))),
                });
                drawnCoords.add(coordKey);
            }
        }
    }

    const markerAbsX = HALF * TILE + markerPixX;
    const markerAbsY = HALF * TILE + markerPixY;

    const ARM = 16, SW = 5, PAD = 12;
    const sz = (ARM + PAD) * 2;
    const h = sz / 2;
    const markerSvg = Buffer.from(
        `<svg width="${sz}" height="${sz}" xmlns="http://www.w3.org/2000/svg">` +
        `<line x1="${h-ARM}" y1="${h-ARM}" x2="${h+ARM}" y2="${h+ARM}" stroke="white" stroke-width="${SW+4}" stroke-linecap="round"/>` +
        `<line x1="${h+ARM}" y1="${h-ARM}" x2="${h-ARM}" y2="${h+ARM}" stroke="white" stroke-width="${SW+4}" stroke-linecap="round"/>` +
        `<line x1="${h-ARM}" y1="${h-ARM}" x2="${h+ARM}" y2="${h+ARM}" stroke="#EE0000" stroke-width="${SW}" stroke-linecap="round"/>` +
        `<line x1="${h+ARM}" y1="${h-ARM}" x2="${h-ARM}" y2="${h+ARM}" stroke="#EE0000" stroke-width="${SW}" stroke-linecap="round"/>` +
        `</svg>`
    );
    composites.push({
        input: markerSvg,
        left: Math.max(0, Math.min(canvasSize - sz, Math.floor(markerAbsX - h))),
        top:  Math.max(0, Math.min(canvasSize - sz, Math.floor(markerAbsY - h))),
    });

    const OUT_W = canvasSize, OUT_H = 500;
    const cropLeft = Math.max(0, Math.min(canvasSize - OUT_W, Math.floor(markerAbsX - OUT_W / 2)));
    const cropTop  = Math.max(0, Math.min(canvasSize - OUT_H, Math.floor(markerAbsY - OUT_H / 2)));

    const fullCanvas = await sharp({
        create: { width: canvasSize, height: canvasSize, channels: 4, background: { r: 220, g: 220, b: 220, alpha: 1 } }
    })
        .composite(composites)
        .png()
        .toBuffer();

    return await sharp(fullCanvas)
        .extract({ left: cropLeft, top: cropTop, width: OUT_W, height: OUT_H })
        .png()
        .toBuffer();
}

module.exports = { latLonToTileAndPixel, fetchGSITile, getScaleSvg, parseISO6709, buildJMAMapAttachment };
