require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const multer = require('multer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET || 'development-only-change-this-secret-32chars';
const SIGNUP_CREDITS = Math.max(0, Number(process.env.SIGNUP_CREDITS || 1000));
const REFERRAL_REWARD = Math.max(0, Number(process.env.REFERRAL_REWARD || 250));
const DEMO_OTP = String(process.env.DEMO_OTP || 'true').toLowerCase() === 'true';
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'private_uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'arena.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE,
 phone TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, credits INTEGER NOT NULL DEFAULT 0,
 referral_code TEXT NOT NULL UNIQUE, referred_by INTEGER REFERENCES users(id), is_admin INTEGER NOT NULL DEFAULT 0,
 phone_verified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS wallet_requests (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), kind TEXT NOT NULL CHECK(kind IN ('deposit','withdrawal')),
 method TEXT NOT NULL CHECK(method IN ('upi','bank')), amount INTEGER NOT NULL, reference TEXT, details TEXT,
 upload_name TEXT, upload_mime TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 admin_note TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reviewed_at TEXT
);
CREATE TABLE IF NOT EXISTS transactions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), type TEXT NOT NULL,
 amount INTEGER NOT NULL, balance_after INTEGER NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS otp_codes (target TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER, action TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS game_bets (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), round_id INTEGER NOT NULL, pick_type TEXT NOT NULL, pick_value TEXT NOT NULL, stake INTEGER NOT NULL, result TEXT NOT NULL DEFAULT 'pending', payout INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, round_id));
`);

const adminEmail = String(process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
const adminPassword = String(process.env.ADMIN_PASSWORD || 'ChangeThisAdminPassword123!');
if (adminPassword.length < 12) {
  console.error('ADMIN_PASSWORD must be at least 12 characters. Set it in .env.');
  process.exit(1);
}
const existingAdmin = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
if (!existingAdmin) {
  const adminHash = bcrypt.hashSync(adminPassword, 12);
  db.prepare(`INSERT INTO users(username,email,phone,password_hash,credits,referral_code,is_admin,phone_verified) VALUES(?,?,?,?,?,?,1,1)`)
    .run('ArenaAdmin', adminEmail, '0000000000', adminHash, 0, 'ADMIN' + crypto.randomBytes(3).toString('hex').toUpperCase());
  console.log(`Admin account initialized for ${adminEmail}. Change credentials before deployment.`);
}

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(path.join(__dirname, 'public')));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false }));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => cb(null, crypto.randomBytes(20).toString('hex') + path.extname(file.originalname).toLowerCase())
  }),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.mimetype)) return cb(new Error('Upload a JPG, PNG, or WEBP image (max 4 MB).'));
    cb(null, true);
  }
});

function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function makeReferral() { return crypto.randomBytes(5).toString('hex').toUpperCase(); }
function audit(actorId, action, detail = '') { db.prepare('INSERT INTO audit_log(actor_id,action,detail) VALUES(?,?,?)').run(actorId || null, action, String(detail).slice(0, 500)); }
function currentUser(req) {
  const raw = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : req.headers['x-session-token'];
  if (!raw) return null;
  const row = db.prepare(`SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(hashToken(raw));
  if (!row || row.expires_at < Date.now()) { if (row) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(raw)); return null; }
  return row;
}
function auth(req, res, next) { const u = currentUser(req); if (!u) return res.status(401).json({ error: 'Please sign in to continue.' }); req.user = u; next(); }
function admin(req, res, next) { if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin access required.' }); next(); }
function safeUser(u) { return { id: u.id, username: u.username, email: u.email, phone: u.phone, credits: u.credits, referralCode: u.referral_code, isAdmin: !!u.is_admin, phoneVerified: !!u.phone_verified, createdAt: u.created_at }; }
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hashToken(token), userId, Date.now() + 7 * 24 * 60 * 60 * 1000);
  return token;
}
function transaction(userId, type, amount, note) {
  const user = db.prepare('SELECT credits FROM users WHERE id=?').get(userId);
  const next = user.credits + amount;
  if (next < 0) throw new Error('Insufficient wallet balance.');
  db.prepare('UPDATE users SET credits=? WHERE id=?').run(next, userId);
  db.prepare('INSERT INTO transactions(user_id,type,amount,balance_after,note) VALUES(?,?,?,?,?)').run(userId, type, amount, next, note);
  return next;
}
function cleanString(v, max = 120) { return String(v || '').trim().slice(0, max); }

app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'Chromatic Arena' }));
app.post('/api/auth/otp/send', rateLimit({ windowMs: 10 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false }), (req, res) => {
  const target = cleanString(req.body.target, 160).toLowerCase();
  if (!target || target.length < 5) return res.status(400).json({ error: 'Enter a valid email address or phone number.' });
  const code = String(crypto.randomInt(100000, 1000000));
  db.prepare(`INSERT INTO otp_codes(target,code_hash,expires_at,attempts) VALUES(?,?,?,0) ON CONFLICT(target) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0`)
    .run(target, hashToken(code), Date.now() + 5 * 60 * 1000);
  if (DEMO_OTP) console.log(`[DEMO OTP] ${target}: ${code} (expires in 5 minutes)`);
  res.json({ ok: true, message: DEMO_OTP ? 'Demo OTP generated. Check the server console.' : 'OTP request accepted. Connect an email/SMS provider to deliver it.' });
});
app.post('/api/auth/otp/verify', (req, res) => {
  const target = cleanString(req.body.target, 160).toLowerCase(); const code = cleanString(req.body.code, 6);
  const row = db.prepare('SELECT * FROM otp_codes WHERE target=?').get(target);
  if (!row || row.expires_at < Date.now() || row.attempts >= 5 || row.code_hash !== hashToken(code)) {
    if (row) db.prepare('UPDATE otp_codes SET attempts=attempts+1 WHERE target=?').run(target);
    return res.status(400).json({ error: 'Invalid or expired OTP.' });
  }
  db.prepare('DELETE FROM otp_codes WHERE target=?').run(target);
  res.json({ ok: true, verified: true, message: 'OTP verified for this session.' });
});
app.post('/api/auth/signup', rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false }), (req, res) => {
  const username = cleanString(req.body.username, 24); const email = cleanString(req.body.email, 160).toLowerCase();
  const phone = cleanString(req.body.phone, 20).replace(/[\s()-]/g, ''); const password = String(req.body.password || '');
  const confirmPassword = String(req.body.confirmPassword || ''); const referral = cleanString(req.body.referralCode, 40).toUpperCase();
  if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: 'Username must be 3–24 letters, numbers, or underscores.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!/^\+?[0-9]{10,15}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid phone number including country code if needed.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (password !== confirmPassword) return res.status(400).json({ error: 'Passwords do not match.' });
  const exists = db.prepare('SELECT id FROM users WHERE username=? OR email=? OR phone=?').get(username, email, phone);
  if (exists) return res.status(409).json({ error: 'That username, email, or phone number is already registered.' });
  let inviter = null;
  if (referral) inviter = db.prepare('SELECT id FROM users WHERE referral_code=?').get(referral);
  if (referral && !inviter) return res.status(400).json({ error: 'That referral code was not found.' });
  const referralCode = makeReferral(); const passHash = bcrypt.hashSync(password, 12);
  const create = db.transaction(() => {
    const info = db.prepare('INSERT INTO users(username,email,phone,password_hash,credits,referral_code,referred_by,phone_verified) VALUES(?,?,?,?,?,?,?,0)')
      .run(username, email, phone, passHash, SIGNUP_CREDITS, referralCode, inviter?.id || null);
    const id = Number(info.lastInsertRowid);
    db.prepare('INSERT INTO transactions(user_id,type,amount,balance_after,note) VALUES(?,?,?,?,?)').run(id, 'signup_bonus', SIGNUP_CREDITS, SIGNUP_CREDITS, 'Welcome credits');
    if (inviter && REFERRAL_REWARD > 0) {
      const inviterRow = db.prepare('SELECT credits FROM users WHERE id=?').get(inviter.id);
      db.prepare('UPDATE users SET credits=credits+? WHERE id=?').run(REFERRAL_REWARD, inviter.id);
      db.prepare('INSERT INTO transactions(user_id,type,amount,balance_after,note) VALUES(?,?,?,?,?)').run(inviter.id, 'referral_bonus', REFERRAL_REWARD, inviterRow.credits + REFERRAL_REWARD, `Referral reward for ${username}`);
      const balance = SIGNUP_CREDITS + REFERRAL_REWARD;
      db.prepare('UPDATE users SET credits=? WHERE id=?').run(balance, id);
      db.prepare('INSERT INTO transactions(user_id,type,amount,balance_after,note) VALUES(?,?,?,?,?)').run(id, 'referral_bonus', REFERRAL_REWARD, balance, 'Referral welcome bonus');
    }
    return id;
  });
  try {
    const id = create(); const token = createSession(id); audit(id, 'signup', `username=${username}; referral=${referral || 'none'}`);
    res.status(201).json({ ok: true, token, user: safeUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)) });
  } catch (e) { res.status(500).json({ error: 'Could not create account. Please try again.' }); }
});
app.post('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: true, legacyHeaders: false }), (req, res) => {
  const identifier = cleanString(req.body.identifier, 160).toLowerCase(); const password = String(req.body.password || '');
  const u = db.prepare('SELECT * FROM users WHERE lower(email)=? OR phone=? OR lower(username)=?').get(identifier, identifier, identifier);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) { audit(null, 'login_failed', `identifier=${identifier.slice(0, 80)}`); return res.status(401).json({ error: 'Incorrect login details.' }); }
  const token = createSession(u.id); audit(u.id, 'login', 'successful'); res.json({ ok: true, token, user: safeUser(u) });
});
app.post('/api/auth/logout', auth, (req, res) => { const raw = req.headers.authorization?.slice(7) || req.headers['x-session-token']; if (raw) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(raw)); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => res.json({ user: safeUser(req.user) }));
app.get('/api/dashboard', auth, (req, res) => {
  const transactions = db.prepare('SELECT id,type,amount,balance_after,note,created_at AS createdAt FROM transactions WHERE user_id=? ORDER BY id DESC LIMIT 12').all(req.user.id);
  const requests = db.prepare('SELECT id,kind,method,amount,status,admin_note AS adminNote,created_at AS createdAt FROM wallet_requests WHERE user_id=? ORDER BY id DESC LIMIT 8').all(req.user.id);
  const referrals = db.prepare('SELECT COUNT(*) AS count FROM users WHERE referred_by=?').get(req.user.id).count;
  res.json({ user: safeUser(req.user), transactions, requests, referrals, referralReward: REFERRAL_REWARD, signupCredits: SIGNUP_CREDITS });
});
app.get('/api/wallet/transactions', auth, (req, res) => res.json({ transactions: db.prepare('SELECT id,type,amount,balance_after AS balanceAfter,note,created_at AS createdAt FROM transactions WHERE user_id=? ORDER BY id DESC LIMIT 100').all(req.user.id) }));
app.post('/api/wallet/request', auth, upload.single('proof'), (req, res) => {
  const kind = cleanString(req.body.kind, 20); const method = cleanString(req.body.method, 20); const amount = Number(req.body.amount);
  const reference = cleanString(req.body.reference, 120); const details = cleanString(req.body.details, 800);
  if (!['deposit', 'withdrawal'].includes(kind) || !['upi', 'bank'].includes(method)) return res.status(400).json({ error: 'Choose a valid request type and method.' });
  if (!Number.isInteger(amount) || amount < 100 || amount > 100000) return res.status(400).json({ error: 'Enter an amount between ₹100 and ₹1,00,000.' });
  if (kind === 'withdrawal' && req.user.credits < amount) return res.status(400).json({ error: 'Not enough wallet balance for this withdrawal request.' });
  if (kind === 'deposit' && !reference) return res.status(400).json({ error: 'Enter your payment reference / UTR.' });
  if (kind === 'withdrawal' && method === 'upi' && !details) return res.status(400).json({ error: 'Enter your UPI ID and a note for the reviewer.' });
  if (kind === 'withdrawal' && method === 'bank' && !details) return res.status(400).json({ error: 'Enter account holder name and bank details for review.' });
  if (kind === 'withdrawal' && !req.file) return res.status(400).json({ error: method === 'bank' ? 'Upload a passbook image for bank transfer withdrawal.' : 'Upload your UPI QR image for UPI withdrawal.' });
  const insert = db.transaction(() => {
    if (kind === 'withdrawal') transaction(req.user.id, 'withdrawal_pending', -amount, 'Withdrawal request submitted (held for admin review)');
    const info = db.prepare('INSERT INTO wallet_requests(user_id,kind,method,amount,reference,details,upload_name,upload_mime) VALUES(?,?,?,?,?,?,?,?)')
      .run(req.user.id, kind, method, amount, reference || null, details || null, req.file?.filename || null, req.file?.mimetype || null);
    audit(req.user.id, `${kind}_request`, `id=${info.lastInsertRowid}; method=${method}; amount=${amount}`);
    return Number(info.lastInsertRowid);
  });
  try { const id = insert(); res.status(201).json({ ok: true, id, message: 'Request submitted. It will appear as pending until reviewed.' }); }
  catch (e) { if (req.file) fs.unlink(req.file.path, () => {}); res.status(400).json({ error: e.message || 'Could not submit request.' }); }
});
function gameRound() {
  const roundId = Math.floor(Date.now() / 60000);
  const seed = crypto.createHash('sha256').update(`${roundId}:${SESSION_SECRET}`).digest('hex');
  const number = parseInt(seed.slice(0, 8), 16) % 10;
  return { roundId, closesAt: (roundId + 1) * 60000, number, color: number === 0 || number === 5 ? 'violet' : (number % 2 === 0 ? 'red' : 'green'), size: number >= 5 ? 'big' : 'small' };
}
app.get('/api/game', auth, (req, res) => {
  const r = gameRound();
  db.prepare("SELECT id FROM game_bets WHERE result='pending' AND round_id < ?").all(r.roundId).forEach(b => { try { settleBet(b.id); } catch (_) {} });
  const previous = db.prepare('SELECT id,round_id AS roundId,pick_type AS pickType,pick_value AS pickValue,stake,result,payout,created_at AS createdAt FROM game_bets WHERE user_id=? ORDER BY id DESC LIMIT 12').all(req.user.id);
  res.json({ round: { id: r.roundId, closesAt: r.closesAt }, previous });
});
app.post('/api/game/bet', auth, (req, res) => {
  const type = cleanString(req.body.type, 20); const value = cleanString(req.body.value, 20).toLowerCase(); const stake = Number(req.body.stake); const r = gameRound();
  const valid = (type === 'color' && ['red','green','violet'].includes(value)) || (type === 'number' && /^[0-9]$/.test(value)) || (type === 'size' && ['big','small'].includes(value));
  if (!valid) return res.status(400).json({ error: 'Choose a valid pick.' });
  if (!Number.isInteger(stake) || stake < 10 || stake > 5000) return res.status(400).json({ error: 'Stake must be between 10 and 5,000 credits.' });
  const existing = db.prepare('SELECT id FROM game_bets WHERE user_id=? AND round_id=?').get(req.user.id, r.roundId);
  if (existing) return res.status(409).json({ error: 'You already placed a pick this round. Try the next round.' });
  try {
    const place = db.transaction(() => {
      transaction(req.user.id, 'game_stake', -stake, `Round ${r.roundId} stake`);
      const info = db.prepare('INSERT INTO game_bets(user_id,round_id,pick_type,pick_value,stake) VALUES(?,?,?,?,?)').run(req.user.id, r.roundId, type, value, stake);
      return Number(info.lastInsertRowid);
    });
    const betId = place();
    // Outcome is computed server-side and the bet is settled only after the round closes.
    setTimeout(() => {
      try {
        const bet = db.prepare("SELECT * FROM game_bets WHERE id=? AND result='pending'").get(betId); if (!bet) return;
        const rr = gameRound();
        if (rr.roundId <= bet.round_id) { setTimeout(() => settleBet(betId), Math.max(500, (bet.round_id + 1) * 60000 - Date.now() + 250)); return; }
        settleBet(betId);
      } catch (_) {}
    }, Math.max(1000, r.closesAt - Date.now() + 300));
    res.status(201).json({ ok: true, betId, message: 'Pick placed for this round.', balance: db.prepare('SELECT credits FROM users WHERE id=?').get(req.user.id).credits });
  } catch (e) { res.status(400).json({ error: e.message || 'Could not place pick.' }); }
});
function settleBet(betId) {
  const bet = db.prepare("SELECT * FROM game_bets WHERE id=? AND result='pending'").get(betId); if (!bet) return;
  const seed = crypto.createHash('sha256').update(`${bet.round_id}:${SESSION_SECRET}`).digest('hex');
  const number = parseInt(seed.slice(0, 8), 16) % 10;
  const color = number === 0 || number === 5 ? 'violet' : (number % 2 === 0 ? 'red' : 'green');
  const size = number >= 5 ? 'big' : 'small';
  const won = (bet.pick_type === 'number' && bet.pick_value === String(number)) || (bet.pick_type === 'color' && bet.pick_value === color) || (bet.pick_type === 'size' && bet.pick_value === size);
  const multiplier = bet.pick_type === 'number' ? 9 : (bet.pick_type === 'color' && bet.pick_value === 'violet' ? 4.5 : 2);
  const payout = won ? Math.floor(bet.stake * multiplier) : 0;
  const settle = db.transaction(() => {
    db.prepare("UPDATE game_bets SET result=?,payout=? WHERE id=? AND result='pending'").run(won ? 'won' : 'lost', payout, betId);
    if (payout > 0) transaction(bet.user_id, 'game_payout', payout, `Round ${bet.round_id} payout`);
  });
  settle();
}
app.get('/api/referrals', auth, (req, res) => {
  const users = db.prepare('SELECT username,created_at AS joinedAt FROM users WHERE referred_by=? ORDER BY id DESC LIMIT 100').all(req.user.id);
  res.json({ code: req.user.referral_code, reward: REFERRAL_REWARD, signupCredits: SIGNUP_CREDITS, count: users.length, users });
});

// Admin routes: all uploaded proof images stay private and are only served to authorized admins.
app.get('/api/admin/summary', auth, admin, (_req, res) => {
  res.json({
    users: db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin=0').get().n,
    pending: db.prepare("SELECT COUNT(*) AS n FROM wallet_requests WHERE status='pending'").get().n,
    deposits: db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM wallet_requests WHERE kind='deposit' AND status='approved'").get().n,
    withdrawals: db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM wallet_requests WHERE kind='withdrawal' AND status='approved'").get().n,
    credits: db.prepare('SELECT COALESCE(SUM(credits),0) AS n FROM users WHERE is_admin=0').get().n
  });
});
app.get('/api/admin/requests', auth, admin, (req, res) => {
  const status = cleanString(req.query.status, 20);
  const sql = `SELECT r.id,r.kind,r.method,r.amount,r.reference,r.details,r.upload_name AS uploadName,r.status,r.admin_note AS adminNote,r.created_at AS createdAt,u.username,u.email,u.phone FROM wallet_requests r JOIN users u ON u.id=r.user_id ${['pending','approved','rejected'].includes(status) ? 'WHERE r.status=?' : ''} ORDER BY r.id DESC LIMIT 200`;
  res.json({ requests: ['pending','approved','rejected'].includes(status) ? db.prepare(sql).all(status) : db.prepare(sql).all() });
});
app.get('/api/admin/proof/:id', auth, admin, (req, res) => {
  const row = db.prepare('SELECT upload_name,upload_mime FROM wallet_requests WHERE id=?').get(Number(req.params.id));
  if (!row?.upload_name) return res.status(404).json({ error: 'No proof image attached.' });
  const p = path.join(UPLOAD_DIR, path.basename(row.upload_name));
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Proof image not found.' });
  res.setHeader('Content-Type', row.upload_mime || 'application/octet-stream'); res.setHeader('Cache-Control', 'no-store'); res.sendFile(p);
});
app.post('/api/admin/requests/:id/review', auth, admin, (req, res) => {
  const id = Number(req.params.id); const decision = cleanString(req.body.decision, 20); const note = cleanString(req.body.note, 300);
  if (!['approve','reject'].includes(decision)) return res.status(400).json({ error: 'Choose approve or reject.' });
  const row = db.prepare('SELECT * FROM wallet_requests WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: 'Request not found.' });
  if (row.status !== 'pending') return res.status(409).json({ error: 'This request has already been reviewed.' });
  const review = db.transaction(() => {
    if (decision === 'approve') {
      if (row.kind === 'deposit') transaction(row.user_id, 'deposit_approved', row.amount, `Deposit request #${id} approved`);
      else db.prepare('INSERT INTO transactions(user_id,type,amount,balance_after,note) SELECT id,?,?,credits,? FROM users WHERE id=?').run('withdrawal_approved', -row.amount, `Withdrawal request #${id} approved`, row.user_id);
      // Withdrawal amount was reserved at request time; on approval the held balance is not deducted again.
    } else if (row.kind === 'withdrawal') {
      transaction(row.user_id, 'withdrawal_refund', row.amount, `Withdrawal request #${id} rejected; credits returned`);
    }
    db.prepare('UPDATE wallet_requests SET status=?,admin_note=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?').run(decision === 'approve' ? 'approved' : 'rejected', note || null, id);
    audit(req.user.id, 'request_review', `id=${id}; decision=${decision}; note=${note}`);
  });
  try { review(); res.json({ ok: true, message: `Request #${id} ${decision === 'approve' ? 'approved' : 'rejected'}.` }); }
  catch (e) { res.status(400).json({ error: e.message || 'Could not review request.' }); }
});
app.get('/api/admin/users', auth, admin, (_req, res) => {
  res.json({ users: db.prepare('SELECT id,username,email,phone,credits,referral_code AS referralCode,is_admin AS isAdmin,created_at AS createdAt FROM users ORDER BY id DESC LIMIT 250').all() });
});
app.post('/api/admin/users/:id/credits', auth, admin, (req, res) => {
  const id = Number(req.params.id); const amount = Number(req.body.amount); const note = cleanString(req.body.note, 200) || 'Admin wallet adjustment';
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1000000) return res.status(400).json({ error: 'Enter a non-zero whole-number adjustment up to 1,000,000.' });
  try { const balance = transaction(id, 'admin_adjustment', amount, note); audit(req.user.id, 'credits_adjusted', `user=${id}; amount=${amount}`); res.json({ ok: true, balance }); }
  catch (e) { res.status(400).json({ error: e.message || 'Could not adjust credits.' }); }
});
app.get('/api/admin/audit', auth, admin, (_req, res) => res.json({ logs: db.prepare('SELECT a.id,a.action,a.detail,a.created_at AS createdAt,u.username FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 100').all() }));

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Image must be 4 MB or smaller.' : 'Could not upload image.' });
  if (err) return res.status(400).json({ error: err.message || 'Request failed.' });
  res.status(500).json({ error: 'Unexpected server error.' });
});
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API route not found.' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.listen(PORT, () => console.log(`Chromatic Arena running at http://localhost:${PORT}`));
