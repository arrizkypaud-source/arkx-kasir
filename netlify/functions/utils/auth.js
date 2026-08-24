const crypto = require('crypto');
const JWT_SECRET = process.env.JWT_SECRET || 'arkx-kasir-dev-secret-change-in-production';

const b64url = o => Buffer.from(JSON.stringify(o)).toString('base64url');

function signToken(payload) {
  const h = b64url({ alg: 'HS256', typ: 'JWT' });
  const b = b64url({ ...payload, exp: Date.now() + 7 * 24 * 3600 * 1000 });
  const s = crypto.createHmac('sha256', JWT_SECRET).update(h + '.' + b).digest('base64url');
  return `${h}.${b}.${s}`;
}

function verifyToken(token) {
  try {
    const [h, b, s] = token.split('.');
    if (s !== crypto.createHmac('sha256', JWT_SECRET).update(h + '.' + b).digest('base64url')) return null;
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    return p.exp < Date.now() ? null : p;
  } catch { return null; }
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}

function verifyPassword(pw, stored) {
  try {
    const [salt, hash] = stored.split(':');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(crypto.scryptSync(pw, salt, 64).toString('hex'), 'hex'));
  } catch { return false; }
}

module.exports = { signToken, verifyToken, hashPassword, verifyPassword };
