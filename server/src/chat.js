import { WebSocketServer } from 'ws';

export function startChatServer(httpServer, db) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  const clients = new Map();        // ws -> ctx
  const voiceRooms = new Map();     // channelId -> Map(ws -> userId)

  function send(ws, type, data = {}) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type, data }));
  }

  function guildMembers(guildId) {
    return Array.from(clients.values()).filter((c) => c && c.guildsSet.has(guildId));
  }

  function sendToVoiceRoom(channelId, type, data, exceptWs = null) {
    const room = voiceRooms.get(channelId);
    if (!room) return;
    for (const ws of room.keys()) {
      if (ws !== exceptWs) send(ws, type, data);
    }
  }

  function voiceState(channelId) {
    const room = voiceRooms.get(channelId);
    if (!room) return [];
    return Array.from(room.values()).map((uid) => {
      const c = findCtxByUserId(uid);
      return { id: uid, user: c ? c.user : { id: uid } };
    });
  }

  function findWsInVoiceRoom(channelId, userId) {
    const room = voiceRooms.get(channelId);
    if (!room) return null;
    for (const [ws, uid] of room) if (uid === userId) return ws;
    return null;
  }

  function findCtxByUserId(userId) {
    for (const [, c] of clients) if (c && c.user && c.user.id === userId) return c;
    return null;
  }

  function currentVoiceChannelOf(ws) {
    for (const [chid, room] of voiceRooms) {
      if (room.has(ws)) return chid;
    }
    return null;
  }

  function setVoice(ctx, channelId, userId) {
    if (!voiceRooms.has(channelId)) voiceRooms.set(channelId, new Map());
    voiceRooms.get(channelId).set(ctx.ws, userId);
    ctx.streams = ctx.streams || new Set();
    ctx.streams.add(channelId);
  }

  function leaveVoice(ws, channelId) {
    const room = voiceRooms.get(channelId);
    if (room && room.has(ws)) {
      const userId = room.get(ws);
      room.delete(ws);
      if (room.size === 0) voiceRooms.delete(channelId);
      const ctx = clients.get(ws);
      if (ctx && ctx.streams) ctx.streams.delete(channelId);
      sendToVoiceRoom(channelId, 'voice:member:leave', { userId, user: ctx?.user || null, channelId });
    }
  }

  function leaveAllVoice(ctx) {
    const chid = currentVoiceChannelOf(ctx.ws);
    if (chid) leaveVoice(ctx.ws, chid);
  }

  function handleMessage(ws, raw) {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const { type, data = {} } = msg;
    let ctx = clients.get(ws);

    if (!ctx) {
      if (type === 'auth') {
        const user = data.token ? db.findUserByToken(data.token) : null;
        if (user) {
          const guilds = db.listGuildsForUser(user.id);
          ctx = { ws, token: data.token, user, guilds, guildsSet: new Set(guilds.map((g) => g.id)) };
          clients.set(ws, ctx);
          send(ws, 'auth:ok', { user, token: data.token });
          send(ws, 'state', { guilds, dms: db.listDmChannelsForUser(user.id), friends: db.listFriends(user.id), friendReqIncoming: db.listIncomingRequests(user.id), friendReqPending: db.listPendingRequests(user.id) });
        } else {
          send(ws, 'auth:error', { error: 'Нет сессии' });
        }
      } else if (type === 'register' || type === 'login') {
        const isRegister = type === 'register';
        const r = isRegister ? db.register(data.username, data.displayName, data.password) : db.login(data.username, data.password);
        if (!r.ok) { send(ws, 'auth:error', { error: r.error }); return; }
        const guilds = db.listGuildsForUser(r.user.id);
        ctx = { ws, token: r.token, user: r.user, guilds, guildsSet: new Set(guilds.map((g) => g.id)) };
        clients.set(ws, ctx);
        send(ws, 'auth:ok', { user: r.user, token: r.token });
        send(ws, 'state', { guilds, dms: db.listDmChannelsForUser(r.user.id), friends: db.listFriends(r.user.id), friendReqIncoming: db.listIncomingRequests(r.user.id), friendReqPending: db.listPendingRequests(r.user.id) });
      }
      return;
    }

    const userId = ctx.user.id;

    const guildOfChannel = (channelId) => {
      const ch = db.getChannel(channelId);
      return ch ? ch.guild_id : null;
    };
    const isInGuild = (guildId) => ctx.guildsSet.has(guildId);

    switch (type) {
      case 'ping': send(ws, 'pong'); break;

      case 'fetch:guild': {
        const guild = db.getGuild(data.guildId);
        if (guild && isInGuild(guild.id)) {
          send(ws, 'guild', { guild, channels: db.listChannels(guild.id) });
        }
        break;
      }

      case 'guild:create': {
        const guild = db.createGuild(userId, data.name || 'Новый сервер');
        ctx.guilds.push(guild); ctx.guildsSet.add(guild.id);
        send(ws, 'guild:new', { guild });
        send(ws, 'guild:state', { guild, channels: db.listChannels(guild.id) });
        break;
      }

      case 'guild:join': {
        const guild = db.joinGuild(data.guildId, userId);
        if (guild) {
          ctx.guilds.push(guild); ctx.guildsSet.add(guild.id);
          send(ws, 'guild:new', { guild });
          send(ws, 'guild:state', { guild, channels: db.listChannels(guild.id) });
          for (const c of guildMembers(guild.id)) send(c.ws, 'guild:refresh', { guild });
        }
        break;
      }

      case 'guild:leave': {
        db.leaveGuild(data.guildId, userId);
        ctx.guildsSet.delete(data.guildId);
        ctx.guilds = ctx.guilds.filter((g) => g.id !== data.guildId);
        for (const ch of db.listChannels(data.guildId).filter((c) => c.type === 'voice')) {
          leaveVoice(ws, ch.id);
        }
        send(ws, 'guild:left', { guildId: data.guildId });
        break;
      }

      case 'channel:create': {
        const guildId = data.guildId;
        if (!isInGuild(guildId)) return;
        const before = db.getGuild(guildId);
        const channel = db.addChannel(guildId, data.name || 'канал', data.type || 'text', userId);
        const after = db.getGuild(guildId);
        for (const c of guildMembers(guildId)) send(c.ws, 'channel:new', { channel });
        if (before.host_id !== after.host_id) {
          for (const c of guildMembers(guildId)) send(c.ws, 'guild:refresh', { guild: after });
        }
        break;
      }

      case 'message:send': {
        const ch = db.getChannel(data.channelId);
        const isDm = !ch;
        if (isDm) {
          if (!db.dmChannelHasUser(data.channelId, userId)) return;
        } else {
          if (!isInGuild(guildOfChannel(data.channelId))) return;
          if (ch.type !== 'text') return;
        }
        const content = String(data.content || '').slice(0, 2000);
        if (!content.trim()) return;
        const message = db.addMessage(userId, data.channelId, content);
        if (isDm) {
          for (const [, c] of clients) {
            if (c && c.user && db.dmChannelHasUser(data.channelId, c.user.id)) send(c.ws, 'message:new', { message });
          }
        } else {
          for (const c of guildMembers(guildOfChannel(data.channelId))) {
            send(c.ws, 'message:new', { message });
          }
        }
        break;
      }

      case 'message:edit': {
        const message = db.updateMessage(Number(data.messageId), userId, data.content);
        if (!message) return send(ws, 'error', { error: 'Нельзя редактировать это сообщение' });
        broadcastMessageChange(message, message.channel_id, ws);
        break;
      }

      case 'message:delete': {
        const message = db.deleteMessage(Number(data.messageId), userId);
        if (!message) return send(ws, 'error', { error: 'Нельзя удалить это сообщение' });
        broadcastMessageChange(message, message.channel_id, ws);
        break;
      }

      case 'fetch:messages': {
        const ch = db.getChannel(data.channelId);
        const isDm = !ch;
        if (isDm) {
          if (!db.dmChannelHasUser(data.channelId, userId)) return;
        } else {
          if (!isInGuild(guildOfChannel(data.channelId)) || ch.type !== 'text') return;
        }
        send(ws, 'messages', { channelId: data.channelId, messages: db.listMessages(data.channelId, data.limit || 50), isDm });
        break;
      }

      case 'dm:open': {
        const other = db.getUserByUsername(data.username);
        if (!other) return send(ws, 'error', { error: 'Пользователь не найден' });
        if (other.id === userId) return send(ws, 'error', { error: 'Это вы' });
        const dm = db.ensureDm(userId, other.id);
        send(ws, 'dm:opened', { dmChannel: { id: dm.id, other_user: other }, messages: db.listMessages(dm.id, 50), isDm: true });
        break;
      }

      case 'search:guilds': {
        const results = db.searchGuilds(data.query || '', userId);
        send(ws, 'guilds:results', { results });
        break;
      }

      case 'friend:request': {
        const other = db.getUserByUsername(data.username);
        if (!other) return send(ws, 'error', { error: 'Пользователь не найден' });
        if (other.id === userId) return send(ws, 'error', { error: 'Нельзя добавить себя' });
        if (db.isFriend(userId, other.id)) return send(ws, 'error', { error: 'Уже друзья' });
        if (db.hasRequest(userId, other.id)) return send(ws, 'error', { error: 'Заявка уже отправлена' });
        db.sendRequest(userId, other.id);
        const me = ctx.user;
        send(ws, 'friend:req:sent', { to: other });
        // notify the other user (if online) about the incoming request
        const otherCtx = findCtxByUserId(other.id);
        if (otherCtx) send(otherCtx.ws, 'friend:req:incoming', { from: me });
        break;
      }

      case 'friend:requests': {
        send(ws, 'friend:req:list', {
          incoming: db.listIncomingRequests(userId),
          pending: db.listPendingRequests(userId),
        });
        break;
      }

      case 'friend:accept': {
        const fromId = Number(data.userId);
        if (!fromId) return;
        if (!db.hasRequest(fromId, userId)) return send(ws, 'error', { error: 'Заявка не найдена' });
        const accepted = db.acceptRequest(userId, fromId);
        send(ws, 'friend:added', { friend: accepted });
        // notify the requester (if online) that their request was accepted
        const fromCtx = findCtxByUserId(fromId);
        if (fromCtx) send(fromCtx.ws, 'friend:added', { friend: ctx.user });
        break;
      }

      case 'friend:decline': {
        const fromId = Number(data.userId);
        if (!fromId) return;
        db.declineRequest(userId, fromId);
        send(ws, 'friend:req:declined', { userId: fromId });
        break;
      }

      case 'friend:list': {
        send(ws, 'friends', { friends: db.listFriends(userId) });
        break;
      }

      // ---------- VOICE ----------
      case 'voice:join': {
        const ch = db.getChannel(data.channelId);
        if (!ch || ch.type !== 'voice' || !isInGuild(ch.guild_id)) return;
        leaveAllVoice(ctx);
        setVoice(ctx, ch.id, userId);
        sendToVoiceRoom(ch.id, 'voice:member:join', { userId, user: ctx.user, channelId: ch.id });
        send(ws, 'voice:state', { channelId: ch.id, users: voiceState(ch.id) });
        break;
      }

      case 'voice:leave': {
        leaveAllVoice(ctx);
        break;
      }

      case 'rtc:offer': {
        const target = findWsInVoiceRoom(data.channelId, data.to);
        if (target) send(target, 'rtc:offer', { from: userId, sdp: data.sdp, channelId: data.channelId });
        break;
      }
      case 'rtc:answer': {
        const target = findWsInVoiceRoom(data.channelId, data.to);
        if (target) send(target, 'rtc:answer', { from: userId, sdp: data.sdp, channelId: data.channelId });
        break;
      }
      case 'rtc:ice': {
        const target = findWsInVoiceRoom(data.channelId, data.to);
        if (target) send(target, 'rtc:ice', { from: userId, candidate: data.candidate, channelId: data.channelId });
        break;
      }

      default: break;
    }
  }

  // Notify everyone who received the message about its change (edit/delete).
  function broadcastMessageChange(message) {
    const channelId = message.channel_id;
    const ch = db.getChannel(channelId);
    const isDm = !ch;
    if (isDm) {
      for (const [, c] of clients) {
        if (c && c.user && db.dmChannelHasUser(channelId, c.user.id)) {
          send(c.ws, 'message:update', { message });
        }
      }
    } else {
      for (const c of guildMembers(ch ? ch.guild_id : null)) {
        send(c.ws, 'message:update', { message });
      }
    }
  }

  wss.on('connection', (ws) => {
    clients.set(ws, null);
    ws.on('message', (buf) => handleMessage(ws, buf.toString()));
    ws.on('close', () => {
      const info = clients.get(ws);
      if (info) leaveAllVoice(info);
      clients.delete(ws);
    });
  });

  return wss;
}