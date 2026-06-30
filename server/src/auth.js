// Passwordless magic-link auth. Owner provisions reps in the `reps` table.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { cfg } from './config.js';
import { q } from './db.js';

export function signSession(rep) {
  return jwt.sign({ sub: rep.id, email: rep.email, name: rep.name }, cfg.jwtSecret, {
    expiresIn: '30d',
  });
}

export function verifySession(token) {
  try {
    return jwt.verify(token, cfg.jwtSecret);
  } catch {
    return null;
  }
}

// Interim email+password login against cfg.repLogins (from the REP_LOGINS env var).
export function passwordLogin(email, password) {
  const e = String(email || '').toLowerCase().trim();
  const rep = cfg.repLogins.find((u) => u.email === e);
  if (!rep) return null;
  const a = Buffer.from(rep.password);
  const b = Buffer.from(String(password || ''));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { id: `env:${e}`, email: e, name: rep.name };
}

export async function requestMagicLink(email) {
  // Always return ok (don't reveal whether an email is a registered rep).
  const { rows } = await q(
    'SELECT id, email, name, active FROM reps WHERE lower(email) = lower($1)',
    [email]
  );
  const rep = rows[0];
  if (!rep || !rep.active) return { ok: true };

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expires = new Date(Date.now() + 15 * 60 * 1000);
  await q('INSERT INTO magic_links (token_hash, rep_id, expires_at) VALUES ($1, $2, $3)', [
    tokenHash,
    rep.id,
    expires,
  ]);
  await sendMagicEmail(rep.email, `${cfg.appUrl}/auth/callback?token=${token}`);
  return { ok: true };
}

export async function consumeMagicLink(token) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const { rows } = await q(
    `SELECT ml.id, ml.rep_id, ml.expires_at, ml.used_at, r.email, r.name, r.active
       FROM magic_links ml JOIN reps r ON r.id = ml.rep_id
      WHERE ml.token_hash = $1`,
    [tokenHash]
  );
  const row = rows[0];
  if (!row || row.used_at || new Date(row.expires_at) < new Date() || !row.active) return null;
  await q('UPDATE magic_links SET used_at = now() WHERE id = $1', [row.id]);
  return { id: row.rep_id, email: row.email, name: row.name };
}

async function sendMagicEmail(to, link) {
  if (!cfg.resendApiKey) {
    console.log(`[auth] No RESEND_API_KEY — magic link for ${to}:\n  ${link}`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: cfg.magicLinkFrom,
      to,
      subject: 'Your Baci Reps sign-in link',
      html: `<p>Tap to sign in to the Baci Reps app:</p>
             <p><a href="${link}">${link}</a></p>
             <p>This link expires in 15 minutes.</p>`,
    }),
  });
  if (!res.ok) console.error('[auth] Resend error', res.status, await res.text());
}
