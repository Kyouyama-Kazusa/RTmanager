/* 生成 PWA 图标 PNG（纯 Node，无外部依赖）
   设计：teal 底色 + 白色放疗定位十字准星（圆环 + 中心点 + 四向刻线）
   背景铺满整个方形，圆角交由 iOS / Android 系统裁切，避免"圆角套圆角" */
const zlib = require('zlib');
const fs = require('fs');

/* ---------- PNG 编码 ---------- */
const CT = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = CT[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- 绘制 ---------- */
function drawIcon(S) {
  const buf = Buffer.alloc(S * S * 4);
  const cx = S / 2, cy = S / 2;
  const BG = [15, 118, 110];
  const FG = [255, 255, 255];
  const R_OUT = 0.285 * S;      /* 准星圆环外半径 */
  const R_IN = 0.215 * S;       /* 圆环内半径 */
  const R_DOT = 0.075 * S;      /* 中心点 */
  const T_IN = 0.335 * S;       /* 刻线内端 */
  const T_OUT = 0.442 * S;      /* 刻线外端 */
  const T_HW = 0.026 * S;       /* 刻线半宽 */
  const SS = 4;                 /* 超采样倍数（抗锯齿） */
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const dx = (x + (sx + 0.5) / SS) - cx;
          const dy = (y + (sy + 0.5) / SS) - cy;
          const adx = dx < 0 ? -dx : dx, ady = dy < 0 ? -dy : dy;
          const d = Math.sqrt(dx * dx + dy * dy);
          let inside = (d <= R_OUT && d >= R_IN) || d <= R_DOT;
          if (!inside) {
            if (adx <= T_HW && ady >= T_IN && ady <= T_OUT) inside = true;
            else if (ady <= T_HW && adx >= T_IN && adx <= T_OUT) inside = true;
          }
          if (inside) hit++;
        }
      }
      const a = hit / (SS * SS);
      const i = (y * S + x) * 4;
      buf[i] = Math.round(BG[0] + (FG[0] - BG[0]) * a);
      buf[i + 1] = Math.round(BG[1] + (FG[1] - BG[1]) * a);
      buf[i + 2] = Math.round(BG[2] + (FG[2] - BG[2]) * a);
      buf[i + 3] = 255;
    }
  }
  return buf;
}

const targets = [
  ['apple-touch-icon.png', 180],
  ['icon-180.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512]
];
targets.forEach(([name, size]) => {
  const png = encodePNG(size, size, drawIcon(size));
  fs.writeFileSync(name, png);
  console.log('生成 ' + name + '  ' + size + 'x' + size + '  ' + (png.length / 1024).toFixed(1) + ' KB');
});
