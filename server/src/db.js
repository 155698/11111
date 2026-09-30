import initSqlJs from 'sql.js';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const hashPassword = (pwd) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pwd, salt, 64).toString('hex');
  return `${salt}:${hash}`;
};

const verifyPassword = (pwd, stored) => {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(pwd, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
};

// Find the .wasm file next to the compiled bundle, or in node_modules fallback.
function locateWasm() {
  // When bundled, sql.js wasm is copied by electron-builder to extraResources or resolved here.
  const candidates = [
    path.join(__dirname, 'sql-wasm.wasm'),
    path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
  ];
  const found = candidates.find((c) => fs.existsSync(c));
  if (found) return found;
  // last resort: search upward
  return path.join(__dirname, 'sql-wasm.wasm');
}

export async function createDatabase(dataDir) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const dbFile = path.join(dataDir, 'db.sqlite');

  const wasmPath = locateWasm();
  const SQL = await initSqlJs({
    locateFile: (file) => (file === 'sql-wasm.wasm' ? wasmPath : file),
  });

  let db;
  if (fs.existsSync(dbFile)) {
    const buf = fs.readFileSync(dbFile);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  // helpers for our coding style (this. bound to db)
  function run(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params);
      stmt.step();
      const lastInsertRowid = db.exec('SELECT last_insert_rowid() as id')[0]?.values?.[0]?.[0];
      return { lastInsertRowid };
    } finally {
      stmt.free();
    }
  }

  function get(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params);
      if (stmt.step()) {
        const cols = stmt.getColumnNames();
        const row = stmt.getAsObject();
        return Object.fromEntries(cols.map((c) => [c, row[c] ?? null]));
      }
      return undefined;
    } finally {
      stmt.free();
    }
  }

  function all(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params);
      const cols = stmt.getColumnNames();
      const out = [];
      while (stmt.step()) {
        const row = stmt.getAsObject();
        out.push(Object.fromEntries(cols.map((c) => [c, row[c] ?? null])));
      }
      return out;
    } finally {
      stmt.free();
    }
  }

  const exec = (sql) => db.exec(sql);

  exec(`
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  avatar      TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS guilds (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  owner_id    INTEGER NOT NULL,
  host_id     INTEGER,
  icon        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS guild_members (
  guild_id  INTEGER NOT NULL,
  user_id   INTEGER NOT NULL,
  role      TEXT NOT NULL DEFAULT 'member',
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
CREATE TABLE IF NOT EXISTS channels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    INTEGER NOT NULL,
  parent_id   INTEGER,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'text',
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dm_channels (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  user_a INTEGER NOT NULL,
  user_b INTEGER NOT NULL,
  UNIQUE (user_a, user_b)
);
CREATE TABLE IF NOT EXISTS friends (
  user_id   INTEGER NOT NULL,
  friend_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);
CREATE TABLE IF NOT EXISTS friend_requests (
  from_id   INTEGER NOT NULL,
  to_id     INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
`);

  // migration: add host_id to existing guilds table if missing
  const guildCols = all('PRAGMA table_info(guilds)').map((c) => c.name);
  if (!guildCols.includes('host_id')) {
    db.exec('ALTER TABLE guilds ADD COLUMN host_id INTEGER');
  }

  // migration: add edited/deleted flags to messages
  const msgCols = all('PRAGMA table_info(messages)').map((c) => c.name);
  if (!msgCols.includes('edited')) db.exec('ALTER TABLE messages ADD COLUMN edited INTEGER NOT NULL DEFAULT 0');
  if (!msgCols.includes('deleted')) db.exec('ALTER TABLE messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0');

  const now = () => Date.now();

  const userCache = new Map();

  const api = {
    _db: db,
    _file: dbFile,
    _persist() {
      const data = db.export();
      fs.writeFileSync(dbFile, Buffer.from(data));
    },
    findUserByToken: (token) => userCache.get(token) || null,
    register(username, displayName, password) {
      const uname = String(username).trim().replace(/^@/, '');
      const existing = get('SELECT id FROM users WHERE username = ?', [uname]);
      if (existing) return { ok: false, error: 'Имя пользователя занято' };
      if (password.length < 4) return { ok: false, error: 'Пароль слишком короткий' };
      const info = run('INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?)',
        [uname, displayName || uname, hashPassword(password), now()]);
      const token = crypto.randomBytes(24).toString('hex');
      const user = get('SELECT id, username, display_name, avatar, created_at FROM users WHERE id = ?', [info.lastInsertRowid]);
      userCache.set(token, user);
      this._persist();
      return { ok: true, token, user };
    },
    login(username, password) {
      const uname = String(username).trim().replace(/^@/, '');
      const row = get('SELECT * FROM users WHERE username = ?', [uname]);
      if (!row || !verifyPassword(password, row.password_hash)) {
        return { ok: false, error: 'Неверное имя или пароль' };
      }
      const token = crypto.randomBytes(24).toString('hex');
      const user = { id: row.id, username: row.username, display_name: row.display_name, avatar: row.avatar, created_at: row.created_at };
      userCache.set(token, user);
      return { ok: true, token, user };
    },
    logout(token) { userCache.delete(token); },
    getUserById(id) {
      return get('SELECT id, username, display_name, avatar, created_at FROM users WHERE id = ?', [id]);
    },
    createGuild(ownerId, name) {
      const info = run('INSERT INTO guilds (name, owner_id, host_id, created_at) VALUES (?, ?, ?, ?)', [name, ownerId, ownerId, now()]);
      const guildId = info.lastInsertRowid;
      run('INSERT INTO guild_members (guild_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', [guildId, ownerId, 'owner', now()]);
      run('INSERT INTO channels (guild_id, name, type, position, created_at) VALUES (?, ?, ?, ?, ?)', [guildId, 'общий', 'text', 0, now()]);
      run('INSERT INTO channels (guild_id, name, type, position, created_at) VALUES (?, ?, ?, ?, ?)', [guildId, 'Голосовая 1', 'voice', 1, now()]);
      this._persist();
      return api.getGuild(guildId);
    },
    getGuild(guildId) { return get('SELECT * FROM guilds WHERE id = ?', [guildId]) || null; },
    listGuildsForUser(userId) {
      return all(`SELECT g.* FROM guilds g JOIN guild_members gm ON gm.guild_id = g.id WHERE gm.user_id = ? ORDER BY g.created_at`, [userId]);
    },
    isMember(guildId, userId) { return !!get('SELECT 1 FROM guild_members WHERE guild_id = ? AND user_id = ?', [guildId, userId]); },
    joinGuild(guildId, userId) {
      if (api.isMember(guildId, userId)) return api.getGuild(guildId);
      run('INSERT INTO guild_members (guild_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', [guildId, userId, 'member', now()]);
      this._persist();
      return api.getGuild(guildId);
    },
    leaveGuild(guildId, userId) {
      run('DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
      this._persist();
    },
    listChannels(guildId) { return all('SELECT * FROM channels WHERE guild_id = ? ORDER BY position, id', [guildId]); },
    getChannel(channelId) { return get('SELECT * FROM channels WHERE id = ?', [channelId]) || null; },
    addChannel(guildId, name, type, creatorId = null) {
      const row = get('SELECT COALESCE(MAX(position), -1) + 1 as p FROM channels WHERE guild_id = ?', [guildId]);
      const position = row ? row.p : 0;
      const info = run('INSERT INTO channels (guild_id, name, type, position, created_at) VALUES (?, ?, ?, ?, ?)',
        [guildId, name, type, position, now()]);
      // if this is the FIRST voice channel on the guild, its creator becomes the host
      if ((type === 'voice' || !type) && creatorId) {
        const guild = api.getGuild(guildId);
        if (guild && !guild.host_id) {
          run('UPDATE guilds SET host_id = ? WHERE id = ?', [creatorId, guildId]);
        }
      }
      this._persist();
      return api.getChannel(info.lastInsertRowid);
    },
    addMessage(userId, channelId, content) {
      const info = run('INSERT INTO messages (user_id, channel_id, content, created_at) VALUES (?, ?, ?, ?)',
        [userId, channelId, content, now()]);
      this._persist();
      return api.getMessage(info.lastInsertRowid);
    },
    updateMessage(messageId, userId, content) {
      const msg = get('SELECT * FROM messages WHERE id = ?', [messageId]);
      if (!msg || msg.user_id !== userId) return null;
      run('UPDATE messages SET content = ?, edited = 1 WHERE id = ?', [String(content).slice(0, 2000), messageId]);
      this._persist();
      return api.getMessage(messageId);
    },
    deleteMessage(messageId, userId) {
      const msg = get('SELECT * FROM messages WHERE id = ?', [messageId]);
      if (!msg || msg.user_id !== userId) return null;
      run('UPDATE messages SET deleted = 1, content = "" WHERE id = ?', [messageId]);
      this._persist();
      return api.getMessage(messageId);
    },
    getMessage(messageId) {
      const m = get('SELECT * FROM messages WHERE id = ?', [messageId]);
      if (!m) return null;
      return { ...m, user: api.getUserById(m.user_id) };
    },
    listMessages(channelId, limit = 50) {
      const rows = all('SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?', [channelId, limit]).reverse();
      return rows.map((m) => ({ ...m, user: api.getUserById(m.user_id) }));
    },
    getUserByUsername(username) {
      return get('SELECT id, username, display_name, avatar, created_at FROM users WHERE username = ?', [username.replace(/^@/, '')]);
    },
    ensureDm(userA, userB) {
      const a = Math.min(userA, userB);
      const b = Math.max(userA, userB);
      let row = get('SELECT * FROM dm_channels WHERE user_a = ? AND user_b = ?', [a, b]);
      if (!row) {
        const info = run('INSERT INTO dm_channels (user_a, user_b) VALUES (?, ?)', [a, b]);
        row = { id: info.lastInsertRowid, user_a: a, user_b: b };
        this._persist();
      }
      return row;
    },
    listDmChannelsForUser(userId) {
      const rows = all('SELECT * FROM dm_channels WHERE user_a = ? OR user_b = ? ORDER BY id DESC', [userId, userId]);
      return rows.map((r) => {
        const otherId = r.user_a === userId ? r.user_b : r.user_a;
        const other = api.getUserById(otherId);
        return { id: r.id, other_user: other, dm_channel: r };
      });
    },
    dmChannelHasUser(channelId, userId) {
      const r = get('SELECT * FROM dm_channels WHERE id = ?', [channelId]);
      return r && (r.user_a === userId || r.user_b === userId);
    },
    searchGuilds(query, userId = null) {
      const q = String(query || '').trim();
      let rows;
      if (!q) {
        rows = all('SELECT * FROM guilds ORDER BY created_at DESC LIMIT 50');
      } else {
        const like = `%${q}%`;
        // prefer name match, then host/owner name match
        rows = all('SELECT * FROM guilds WHERE name LIKE ? COLLATE NOCASE ORDER BY created_at DESC LIMIT 50', [like]);
        if (rows.length < 20) {
          const hostRows = all(`
            SELECT g.* FROM guilds g
            LEFT JOIN users u ON u.id = g.host_id
            WHERE u.username LIKE ? COLLATE NOCASE OR u.display_name LIKE ? COLLATE NOCASE
            ORDER BY g.created_at DESC LIMIT 50`, [like, like]);
          for (const r of hostRows) if (!rows.some((x) => x.id === r.id)) rows.push(r);
        }
      }
      return rows.map((g) => ({
        ...g,
        member_count: get('SELECT COUNT(*) as c FROM guild_members WHERE guild_id = ?', [g.id]).c,
        is_member: userId ? api.isMember(g.id, userId) : false,
      }));
    },
    isFriend(a, b) { return !!get('SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?', [a, b]); },
    addFriend(a, b) {
      if (a === b) return null;
      if (api.isFriend(a, b)) return null;
      run('INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)', [a, b, now()]);
      run('INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)', [b, a, now()]);
      this._persist();
      return api.getUserById(b);
    },
    listFriends(userId) {
      const rows = all('SELECT friend_id FROM friends WHERE user_id = ? ORDER BY created_at DESC', [userId]);
      return rows.map((r) => api.getUserById(r.friend_id)).filter(Boolean);
    },
    // ---- friend requests ----
    hasRequest(a, b) { return !!get('SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?', [a, b]); },
    sendRequest(fromId, toId) {
      if (fromId === toId) return null;
      if (api.isFriend(fromId, toId)) return null; // already friends
      if (api.hasRequest(fromId, toId)) return null; // already sent
      run('INSERT OR IGNORE INTO friend_requests (from_id, to_id, created_at) VALUES (?, ?, ?)', [fromId, toId, now()]);
      this._persist();
      return api.getUserById(toId);
    },
    listIncomingRequests(userId) {
      const rows = all('SELECT from_id FROM friend_requests WHERE to_id = ? ORDER BY created_at DESC', [userId]);
      return rows.map((r) => api.getUserById(r.from_id)).filter(Boolean);
    },
    listPendingRequests(userId) {
      const rows = all('SELECT to_id FROM friend_requests WHERE from_id = ? ORDER BY created_at DESC', [userId]);
      return rows.map((r) => api.getUserById(r.to_id)).filter(Boolean);
    },
    acceptRequest(userId, fromId) {
      // userId accepts friendship initiated by fromId
      run('DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?', [fromId, userId]);
      run('INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)', [fromId, userId, now()]);
      run('INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)', [userId, fromId, now()]);
      this._persist();
      return api.getUserById(fromId);
    },
    declineRequest(userId, fromId) {
      run('DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?', [fromId, userId]);
      this._persist();
    },
  };

  return api;
}