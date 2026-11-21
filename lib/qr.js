'use strict';
/**
 * Lily MD — Zero-dependency QR Code Generator
 *
 * Encodes text (e.g. Baileys WhatsApp authentication strings) into high-contrast,
 * scalable SVGs and Data URLs without native bindings or external npm packages.
 *
 * If the optional `qrcode` package is installed in production, it will be used
 * when preferred; otherwise this robust pure-JS implementation renders the QR.
 */

// QR Code specification constants and Galois Field tables
const GF256_EXP = new Uint8Array(512);
const GF256_LOG = new Uint8Array(256);

(function initGaloisField() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
        GF256_EXP[i] = x;
        GF256_LOG[x] = i;
        x <<= 1;
        if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) {
        GF256_EXP[i] = GF256_EXP[i - 255];
    }
})();

function gfMul(x, y) {
    if (x === 0 || y === 0) return 0;
    return GF256_EXP[GF256_LOG[x] + GF256_LOG[y]];
}

// Version table: [version, totalCodewords, ecCodewordsPerBlock, numBlocks]
// Suitable for Baileys pairing strings (typically 120-180 bytes)
const VERSION_SPECS = [
    null,
    { version: 1, size: 21, totalData: 19, ecPerBlock: 7, blocks: 1 },
    { version: 2, size: 25, totalData: 34, ecPerBlock: 10, blocks: 1 },
    { version: 3, size: 29, totalData: 55, ecPerBlock: 15, blocks: 1 },
    { version: 4, size: 33, totalData: 80, ecPerBlock: 20, blocks: 1 },
    { version: 5, size: 37, totalData: 108, ecPerBlock: 26, blocks: 1 },
    { version: 6, size: 41, totalData: 136, ecPerBlock: 18, blocks: 2 },
    { version: 7, size: 45, totalData: 156, ecPerBlock: 20, blocks: 2 },
    { version: 8, size: 49, totalData: 194, ecPerBlock: 24, blocks: 2 },
    { version: 9, size: 53, totalData: 232, ecPerBlock: 30, blocks: 2 },
    { version: 10, size: 57, totalData: 274, ecPerBlock: 18, blocks: 4 },
    { version: 11, size: 61, totalData: 324, ecPerBlock: 20, blocks: 4 },
    { version: 12, size: 65, totalData: 370, ecPerBlock: 24, blocks: 4 },
    { version: 13, size: 69, totalData: 428, ecPerBlock: 26, blocks: 4 },
    { version: 14, size: 73, totalData: 461, ecPerBlock: 30, blocks: 4 }
];

// Error-correction polynomial generator
function calcEcPoly(numEc) {
    let poly = [1];
    for (let i = 0; i < numEc; i++) {
        const next = [0].concat(poly);
        const factor = GF256_EXP[i];
        for (let j = 0; j < poly.length; j++) {
            next[j] ^= gfMul(poly[j], factor);
        }
        poly = next;
    }
    return poly;
}

// Compute Reed-Solomon error correction codewords
function computeEcCodewords(data, numEc) {
    const genPoly = calcEcPoly(numEc);
    const msg = new Uint8Array(data.length + numEc);
    msg.set(data);

    for (let i = 0; i < data.length; i++) {
        const coef = msg[i];
        if (coef !== 0) {
            for (let j = 0; j < genPoly.length; j++) {
                msg[i + j] ^= gfMul(genPoly[j], coef);
            }
        }
    }
    return Array.from(msg.slice(data.length));
}

// Bit stream helper
class BitStream {
    constructor() {
        this.bits = [];
    }
    append(val, length) {
        for (let i = length - 1; i >= 0; i--) {
            this.bits.push((val >>> i) & 1);
        }
    }
    getBytes() {
        const bytes = [];
        for (let i = 0; i < this.bits.length; i += 8) {
            let b = 0;
            for (let j = 0; j < 8; j++) {
                b = (b << 1) | (this.bits[i + j] || 0);
            }
            bytes.push(b);
        }
        return bytes;
    }
}

// Determine smallest version capable of holding the payload in 8-bit byte mode
function pickVersion(payloadLength) {
    for (let v = 1; v < VERSION_SPECS.length; v++) {
        const spec = VERSION_SPECS[v];
        // 4 bits mode + (8 or 16) bits char count indicator
        const charCountBits = v < 10 ? 8 : 16;
        const totalHeaderBits = 4 + charCountBits;
        const maxCapacityBytes = Math.floor((spec.totalData * 8 - totalHeaderBits) / 8);
        if (payloadLength <= maxCapacityBytes) {
            return spec;
        }
    }
    return VERSION_SPECS[VERSION_SPECS.length - 1];
}

// Encode payload into final interleaved codewords
function encodePayload(text, spec) {
    const bytes = Buffer.from(text, 'utf8');
    const bs = new BitStream();

    // Mode: Byte (0100)
    bs.append(0b0100, 4);
    // Character count indicator
    const charCountBits = spec.version < 10 ? 8 : 16;
    bs.append(bytes.length, charCountBits);

    // Data bits
    for (let i = 0; i < bytes.length; i++) {
        bs.append(bytes[i], 8);
    }

    // Terminator (up to 4 zeroes)
    const totalDataBits = spec.totalData * 8;
    const termBits = Math.min(4, totalDataBits - bs.bits.length);
    if (termBits > 0) bs.append(0, termBits);

    // Byte align
    const remainder = bs.bits.length % 8;
    if (remainder > 0) bs.append(0, 8 - remainder);

    // Pad bytes 0xEC, 0x11
    let dataCodewords = bs.getBytes();
    const pad = [0xec, 0x11];
    let padIdx = 0;
    while (dataCodewords.length < spec.totalData) {
        dataCodewords.push(pad[padIdx % 2]);
        padIdx++;
    }

    // Divide into blocks and calculate EC
    const numBlocks = spec.blocks;
    const baseBlockSize = Math.floor(spec.totalData / numBlocks);
    const extraBlocks = spec.totalData % numBlocks;

    const dataBlocks = [];
    const ecBlocks = [];
    let offset = 0;

    for (let b = 0; b < numBlocks; b++) {
        const blockSize = baseBlockSize + (b >= numBlocks - extraBlocks ? 1 : 0);
        const blockData = dataCodewords.slice(offset, offset + blockSize);
        offset += blockSize;
        dataBlocks.push(blockData);
        ecBlocks.push(computeEcCodewords(blockData, spec.ecPerBlock));
    }

    // Interleave data codewords
    const finalCodewords = [];
    const maxDataLen = Math.max(...dataBlocks.map((b) => b.length));
    for (let i = 0; i < maxDataLen; i++) {
        for (let b = 0; b < numBlocks; b++) {
            if (i < dataBlocks[b].length) finalCodewords.push(dataBlocks[b][i]);
        }
    }

    // Interleave EC codewords
    for (let i = 0; i < spec.ecPerBlock; i++) {
        for (let b = 0; b < numBlocks; b++) {
            finalCodewords.push(ecBlocks[b][i]);
        }
    }

    return finalCodewords;
}

// Matrix layout
function createMatrix(spec, codewords) {
    const size = spec.size;
    const matrix = Array.from({ length: size }, () => Array(size).fill(null));
    const reserved = Array.from({ length: size }, () => Array(size).fill(false));

    function setModule(r, c, val) {
        matrix[r][c] = val;
        reserved[r][c] = true;
    }

    // Finder patterns
    function addFinder(top, left) {
        for (let r = 0; r < 7; r++) {
            for (let c = 0; c < 7; c++) {
                const border = r === 0 || r === 6 || c === 0 || c === 6;
                const inner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
                setModule(top + r, left + c, border || inner);
            }
        }
        // Separators
        for (let r = -1; r <= 7; r++) {
            for (let c = -1; c <= 7; c++) {
                const row = top + r;
                const col = left + c;
                if (row >= 0 && row < size && col >= 0 && col < size && !reserved[row][col]) {
                    setModule(row, col, false);
                }
            }
        }
    }

    addFinder(0, 0);
    addFinder(0, size - 7);
    addFinder(size - 7, 0);

    // Alignment patterns (for Version >= 2)
    if (spec.version >= 2) {
        const alignPos = [6, size - 7];
        for (const r of alignPos) {
            for (const c of alignPos) {
                if (reserved[r][c]) continue;
                for (let dr = -2; dr <= 2; dr++) {
                    for (let dc = -2; dc <= 2; dc++) {
                        const border = Math.abs(dr) === 2 || Math.abs(dc) === 2;
                        const center = dr === 0 && dc === 0;
                        setModule(r + dr, c + dc, border || center);
                    }
                }
            }
        }
    }

    // Timing patterns
    for (let i = 8; i < size - 8; i++) {
        if (!reserved[6][i]) setModule(6, i, i % 2 === 0);
        if (!reserved[i][6]) setModule(i, 6, i % 2 === 0);
    }

    // Dark module
    setModule(size - 8, 8, true);

    // Reserve format information areas
    for (let i = 0; i < 9; i++) {
        if (!reserved[8][i]) reserved[8][i] = true;
        if (!reserved[i][8]) reserved[i][8] = true;
    }
    for (let i = size - 8; i < size; i++) {
        if (!reserved[8][i]) reserved[8][i] = true;
        if (!reserved[i][8]) reserved[i][8] = true;
    }

    // Place data bits with standard mask 0 ((row + col) % 2 === 0)
    let bitIndex = 0;
    const bits = [];
    for (const cw of codewords) {
        for (let b = 7; b >= 0; b--) {
            bits.push((cw >>> b) & 1);
        }
    }

    let upwards = true;
    for (let col = size - 1; col > 0; col -= 2) {
        if (col === 6) col--; // Skip vertical timing column
        const rows = upwards
            ? Array.from({ length: size }, (_, i) => size - 1 - i)
            : Array.from({ length: size }, (_, i) => i);

        for (const row of rows) {
            for (let c = 0; c < 2; c++) {
                const curCol = col - c;
                if (!reserved[row][curCol]) {
                    const dataBit = bitIndex < bits.length ? bits[bitIndex++] : 0;
                    // Apply mask 0: (row + col) % 2 === 0
                    const mask = (row + curCol) % 2 === 0;
                    matrix[row][curCol] = Boolean(dataBit ^ (mask ? 1 : 0));
                }
            }
        }
        upwards = !upwards;
    }

    // Format information: Mask 0, Level L -> format bits 0b111011111000100 ^ 0b101010000010010 = 0b010001111010110
    const formatBits = [0, 1, 0, 0, 0, 1, 1, 1, 1, 0, 1, 0, 1, 1, 0];
    for (let i = 0; i < 6; i++) matrix[8][i] = Boolean(formatBits[i]);
    matrix[8][7] = Boolean(formatBits[6]);
    matrix[8][8] = Boolean(formatBits[7]);
    matrix[7][8] = Boolean(formatBits[8]);
    for (let i = 9; i < 15; i++) matrix[14 - i][8] = Boolean(formatBits[i]);

    for (let i = 0; i < 8; i++) matrix[size - 1 - i][8] = Boolean(formatBits[i]);
    for (let i = 8; i < 15; i++) matrix[8][size - 15 + i] = Boolean(formatBits[i]);

    return matrix;
}

/**
 * Generate a clean, responsive SVG from input text.
 */
function toSvg(text, options = {}) {
    const safeText = String(text || '').trim();
    if (!safeText) return '';

    const spec = pickVersion(Buffer.byteLength(safeText, 'utf8'));
    const codewords = encodePayload(safeText, spec);
    const matrix = createMatrix(spec, codewords);

    const margin = options.margin !== undefined ? options.margin : 2;
    const fg = options.dark || '#ffffff';
    const bg = options.light || '#0f1117';
    const radius = options.moduleRadius || 0;
    const size = matrix.length;
    const totalSize = size + margin * 2;

    let paths = '';
    for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
            if (matrix[r][c]) {
                const x = c + margin;
                const y = r + margin;
                if (radius > 0) {
                    paths += `<rect x="${x}" y="${y}" width="1" height="1" rx="${radius}" fill="${fg}"/>`;
                } else {
                    paths += `M${x},${y}h1v1h-1z `;
                }
            }
        }
    }

    const pathElement = radius > 0 ? paths : `<path d="${paths}" fill="${fg}"/>`;

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalSize} ${totalSize}" shape-rendering="crispEdges" width="100%" height="100%">`,
        `<rect width="${totalSize}" height="${totalSize}" fill="${bg}"/>`,
        pathElement,
        `</svg>`
    ].join('');
}

/**
 * Convert QR text into an SVG Data URL suitable for `<img src="..." />`
 */
async function toDataUrl(text, options = {}) {
    // Attempt to use `qrcode` if installed in production
    try {
        const qrcode = require('qrcode');
        if (qrcode && typeof qrcode.toDataURL === 'function') {
            return await qrcode.toDataURL(text, {
                margin: options.margin || 2,
                color: {
                    dark: options.dark || '#000000',
                    light: options.light || '#ffffff'
                }
            });
        }
    } catch {}

    // Fall back to pure-JS SVG Data URL
    const svg = toSvg(text, {
        dark: options.dark || '#000000',
        light: options.light || '#ffffff',
        margin: options.margin || 2
    });
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

module.exports = {
    toSvg,
    toDataUrl
};
