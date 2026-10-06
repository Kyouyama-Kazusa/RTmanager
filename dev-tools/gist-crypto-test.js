const { webcrypto } = require('crypto');
const { subtle } = webcrypto;
const enc = new TextEncoder(), dec = new TextDecoder();

async function deriveKey(pass, saltB64, iterations) {
  const salt = Buffer.from(saltB64, 'base64');
  const base = await subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}
async function encrypt(pass, plain, iterations) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, Buffer.from(salt).toString('base64'), iterations);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plain));
  return JSON.stringify({
    v: 1, alg: 'PBKDF2-SHA256/AES-GCM-256', iter: iterations,
    salt: Buffer.from(salt).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
    data: Buffer.from(ct).toString('base64')
  });
}
async function decrypt(pass, blobStr) {
  const b = JSON.parse(blobStr);
  const key = await deriveKey(pass, b.salt, b.iter);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(b.iv, 'base64') }, key, Buffer.from(b.data, 'base64'));
  return dec.decode(pt);
}

(async () => {
  let pass = 0, fail = 0;
  const ok = (c, m) => { if (c) { pass++; console.log('  OK  ' + m); } else { fail++; console.log('  XX  ' + m); } };
  const pad = (s, n) => String(s).padEnd(n);
  console.log('========== 方案 B 加密方案验证（WebCrypto） ==========\n');

  console.log('--- 1. 加解密往返 ---');
  const plain = JSON.stringify({ version: 2, patients: [{ name: '张三', mrn: 'RT001', diagnosis: '鼻咽癌', note: '含中文与符号 quote/backslash/newline' }] });
  const blob = await encrypt('我的密码123', plain, 250000);
  ok(await decrypt('我的密码123', blob) === plain, '正确密码可解密，内容完全一致');

  console.log('\n--- 2. 安全强度 ---');
  let wrongRejected = false;
  try { await decrypt('错的密码', blob); } catch (e) { wrongRejected = true; }
  ok(wrongRejected, '★ 错误密码解密失败（AES-GCM 认证标签生效，不会得到乱码）');
  let tamperRejected = false;
  const t = JSON.parse(blob); const rawBuf = Buffer.from(t.data, 'base64'); rawBuf[0] ^= 0xff; t.data = rawBuf.toString('base64');
  try { await decrypt('我的密码123', JSON.stringify(t)); } catch (e) { tamperRejected = true; }
  ok(tamperRejected, '★ 密文被篡改会被检测到（完整性保护）');
  const b1 = await encrypt('same', 'x', 250000), b2 = await encrypt('same', 'x', 250000);
  ok(JSON.parse(b1).salt !== JSON.parse(b2).salt && JSON.parse(b1).data !== JSON.parse(b2).data,
    '★ 相同明文两次加密结果不同（随机 salt + IV，无痕迹可对比）');

  console.log('\n--- 3. 性能（关键：会不会卡住界面） ---');
  const sizes = [[100 + ' 位患者 ~45KB', 45 * 1024], [1000 + ' 位患者 ~450KB', 450 * 1024], ['极值 1MB', 1024 * 1024]];
  for (const item of sizes) {
    const label = item[0], size = item[1];
    const big = JSON.stringify({ patients: Array.from({ length: 10 }, () => 'x'.repeat(Math.floor(size / 10))) });
    const t0 = Date.now(); const eb = await encrypt('pw', big, 250000); const t1 = Date.now();
    await decrypt('pw', eb); const t2 = Date.now();
    console.log('  ' + pad(label, 22) + ' 加密 ' + pad(t1 - t0, 5) + 'ms  解密 ' + pad(t2 - t1, 5) + 'ms  密文 ' + (eb.length / 1024).toFixed(0) + 'KB');
  }

  console.log('\n--- 4. 迭代次数 vs 抗暴力破解 ---');
  for (const it of [100000, 250000, 600000]) {
    const t0 = Date.now(); await encrypt('pw', 'x', it); const dt = Date.now() - t0;
    console.log('  PBKDF2 ' + pad(it, 7) + ' 次 -> 派生耗时约 ' + pad(dt, 5) + 'ms（每次同步的固定开销）');
  }

  console.log('\n--- 5. 密文体积膨胀 ---');
  for (const size of [45, 450, 1024]) {
    const s = JSON.stringify({ p: 'x'.repeat(size * 1024) });
    const e = await encrypt('pw', s, 100000);
    console.log('  明文 ' + pad(size + 'KB', 8) + ' -> 密文 ' + pad((e.length / 1024).toFixed(1) + 'KB', 10) + ' 膨胀 ' + pad((e.length / s.length * 100 - 100).toFixed(1) + '%', 8) + '（base64 编码固有开销）');
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
})();
