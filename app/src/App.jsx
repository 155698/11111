import { useEffect, useRef, useState } from 'react';
import { SocketClient } from './socket.js';
import AuthScreen from './components/AuthScreen.jsx';

export default function App() {
  const [socket] = useState(() => new SocketClient());
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const speakingRef = useRef(new Set());      // track current speakers to avoid re-renders
  const vadAnalysers = useRef(new Map());      // userId -> { analyser, lastVol }
  const lastFetchRef = useRef(null);           // last channel we requested messages for
  const [guilds, setGuilds] = useState([]);
  const [dms, setDms] = useState([]);
  const [friends, setFriends] = useState([]);
  const [friendReqIncoming, setFriendReqIncoming] = useState([]);
  const [friendReqPending, setFriendReqPending] = useState([]);
  const [view, setView] = useState('dm'); // 'dm' | 'friends' | 'search' | 'guild'
  const [searchResults, setSearchResults] = useState([]);
  const [activeGuild, setActiveGuild] = useState(null);
  const [guildChannels, setGuildChannels] = useState([]);
  const [activeChannel, setActiveChannel] = useState(null); // {id, name, type, guild_id?, isDm}
  const [channelMessages, setChannelMessages] = useState([]);
  const [connected, setConnected] = useState(false);
  const [voiceChannel, setVoiceChannel] = useState(null);
  const [voiceGuildId, setVoiceGuildId] = useState(null);
  const [channelSince, setChannelSince] = useState({}); // { channelId: timestamp when a member joined }
  const [voiceUsers, setVoiceUsers] = useState([]);
  const [voiceMembers, setVoiceMembers] = useState({}); // { channelId: [ {id, user} ] }
  const [speakingUsers, setSpeakingUsers] = useState(new Set()); // userIds currently talking
  const [remoteAudios, setRemoteAudios] = useState([]);
  const [remoteScreens, setRemoteScreens] = useState([]); // [{uid, stream}]
  const [sharing, setSharing] = useState(false);
  const [expandedShare, setExpandedShare] = useState(false);
  const [barVisible, setBarVisible] = useState(false);
  const [sharePickerOpen, setSharePickerOpen] = useState(false);
  const [shareSources, setShareSources] = useState([]);
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [creatingGuild, setCreatingGuild] = useState(false);
  const [guildName, setGuildName] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settTab, setSettTab] = useState('server');
  const [serverAddr, setServerAddr] = useState('');
  const [lanIps, setLanIps] = useState([]);
  const [updateInfo, setUpdateInfo] = useState(null); // { version, downloadUrl, installer }

  function openSettings() {
    setServerAddr(socket.getServerUrl() || '');
    setSettingsOpen(true);
    if (window.electronAPI?.getLanIps) {
      window.electronAPI.getLanIps().then(setLanIps).catch(() => setLanIps([]));
    }
  }

  // ---- boot ----
  useEffect(() => {
    socket.on('pong', () => setConnected(true));
    socket.auth();
    socket.connect();
    return () => {};
  }, [socket]);

  // ---- update check (from GitHub Releases) ----
  const APP_VERSION = '1.0.7';
  const GH_REPO = '155698/11111';
  const GITHUB_API = 'https://api.github.com/repos/' + GH_REPO + '/releases/latest';
  useEffect(() => {
    let disposed = false;
    async function check() {
      try {
        const r = await fetch(GITHUB_API, { cache: 'no-store' });
        if (!r.ok) return;
        const rel = await r.json();
        if (!rel || !rel.tag_name) return;
        const remoteVersion = String(rel.tag_name).replace(/^v/i, '');
        if (cmpVersions(remoteVersion, APP_VERSION) > 0) {
          // find the .exe asset
          let downloadUrl = '';
          if (Array.isArray(rel.assets)) {
            const exe = rel.assets.find((a) => a.name && /\.exe$/i.test(a.name));
            if (exe) downloadUrl = exe.browser_download_url;
          }
          setUpdateInfo({ version: remoteVersion, downloadUrl });
        }
      } catch (e) { console.error('[update] check failed:', e); /* ignore */ }
    }
    check();
    const id = setInterval(check, 15 * 60 * 1000); // every 15 minutes
    return () => { disposed = true; clearInterval(id); };
  }, []);

  // show voice bar when the cursor is over the central work area (voice tiles)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onMove = (e) => {
      const el = e.target;
      const inWorkArea = el && typeof el.closest === 'function' &&
        (el.closest('.chat-wrap') || el.closest('.voice-bar'));
      setBarVisible(!!inWorkArea);
    };
    const hide = () => setBarVisible(false);
    const onDocOut = (e) => {
      // cursor left the window entirely (no related target inside the document)
      if (!e.relatedTarget) hide();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseleave', hide);
    document.addEventListener('mouseout', onDocOut);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseleave', hide);
      document.removeEventListener('mouseout', onDocOut);
    };
  }, []);

  function cmpVersions(a, b) {
    const pa = String(a).split('.');
    const pb = String(b).split('.');
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = parseInt(pa[i], 10) || 0;
      const y = parseInt(pb[i], 10) || 0;
      if (x > y) return 1;
      if (x < y) return -1;
    }
    return 0;
  }

  useEffect(() => {
    const off1 = socket.on('auth:ok', (d) => {
      // persist token only if "remember me" was chosen (login/register); for
      // auto-auth via stored token this just re-saves the same value.
      if (d.token) socket.persistToken(d.token);
      setUser(d.user);
      setReady(true);
    });
    const off2 = socket.on('state', (d) => { setGuilds(d.guilds || []); setDms(d.dms || []); setFriends(d.friends || []); setFriendReqIncoming(d.friendReqIncoming || []); setFriendReqPending(d.friendReqPending || []); });
    const off3 = socket.on('auth:error', () => { console.warn('no valid session'); });
    return () => { off1(); off2(); off3(); };
  }, [socket]);

  // ---- friends / search events ----
  useEffect(() => {
    const off1 = socket.on('guilds:results', (d) => setSearchResults(d.results || []));
    const off2 = socket.on('friend:added', (d) => {
      setFriends((fs) => (fs.some((f) => f.id === d.friend.id) ? fs : [...fs, d.friend]));
      setFriendReqIncoming((arr) => arr.filter((u) => u.id !== d.friend.id));
      setFriendReqPending((arr) => arr.filter((u) => u.id !== d.friend.id));
    });
    const off3 = socket.on('friends', (d) => setFriends(d.friends || []));
    const off3b = socket.on('friend:req:incoming', (d) => {
      setFriendReqIncoming((arr) => (arr.some((u) => u.id === d.from.id) ? arr : [...arr, d.from]));
    });
    const off3c = socket.on('friend:req:sent', (d) => {
      setFriendReqPending((arr) => (arr.some((u) => u.id === d.to.id) ? arr : [...arr, d.to]));
    });
    const off3d = socket.on('friend:req:list', (d) => {
      setFriendReqIncoming(d.incoming || []);
      setFriendReqPending(d.pending || []);
    });
    const off3e = socket.on('friend:req:declined', (d) => {
      if (d.userId) setFriendReqPending((arr) => arr.filter((u) => u.id !== d.userId));
    });
    const off4 = socket.on('dm:opened', (d) => {
      setActiveChannel({ isDm: true, id: d.dmChannel.id, name: (d.dmChannel.other_user?.display_name || d.dmChannel.other_user?.username || 'ЛС') });
      // normalize to { channelId, messages, isDm } shape used by the messages handler
      setChannelMessages({ channelId: d.dmChannel.id, messages: d.messages || [], isDm: true });
      setView('dm');
    });
    return () => { off1(); off2(); off3(); off3b(); off3c(); off3d(); off3e(); off4(); };
  }, [socket]);

  // ---- guild / channel events ----
  useEffect(() => {
    const subs = [];
    subs.push(socket.on('guild:new', (d) => setGuilds((g) => [...g, d.guild])));
    const applyGuild = (d) => {
      setGuildChannels(d.channels || []);
      if (d.guild) setActiveGuild((g) => (g?.id === d.guild.id ? d.guild : g));
    };
    subs.push(socket.on('guild', applyGuild));          // response to fetch:guild
    subs.push(socket.on('guild:state', applyGuild));    // after create/join
    subs.push(socket.on('guild:refresh', (d) => {
      const ng = d.guild;
      if (!ng) return;
      setGuilds((gs) => gs.map((g) => (g.id === ng.id ? { ...g, host_id: ng.host_id } : g)));
      setActiveGuild((g) => (g?.id === ng.id ? { ...g, host_id: ng.host_id } : g));
    }));
    subs.push(socket.on('channel:new', (d) => {
      const nc = d.channel;
      setGuildChannels((ch) => (ch.some((c) => c.id === nc.id) ? ch : [...ch, nc]));
    }));
    subs.push(socket.on('guild:left', (d) => {
      setGuilds((g) => g.filter((x) => x.id !== d.guildId));
      setGuildChannels((ch) => []); // channels belong to a single active guild; clear on leave
      setActiveChannel((c) => null);
      setActiveGuild((g) => (g?.id === d.guildId ? null : g));
    }));
    return () => subs.forEach((off) => off && off());
  }, [socket]);

  // ---- messages ----
  useEffect(() => {
    const off1 = socket.on('messages', (d) => {
      // replace messages for this channel (ignore stale replies for other channels)
      setChannelMessages((prev) => {
        if (lastFetchRef.current !== null && lastFetchRef.current !== d.channelId) return prev;
        return { channelId: d.channelId, messages: d.messages || [], isDm: !!d.isDm };
      });
    });
    const off2 = socket.on('message:new', (d) => {
      const { message } = d;
      setChannelMessages((prev) => {
        if (prev.channelId === message.channel_id) {
          return { ...prev, messages: [...prev.messages, message] };
        }
        return prev;
      });
    });
    const off3 = socket.on('message:update', (d) => {
      const { message } = d;
      setChannelMessages((prev) => {
        if (prev.channelId !== message.channel_id) return prev;
        return {
          ...prev,
          messages: (prev.messages || []).map((m) => (m.id === message.id ? message : m)),
        };
      });
    });
    return () => { off1(); off2(); off3(); };
  }, [socket]);

  // per-channel activity timers: start when the first member joins, stop when empty
  useEffect(() => {
    setChannelSince((prev) => {
      const next = { ...prev };
      for (const [cid, members] of Object.entries(voiceMembers)) {
        const hasAnyone = Array.isArray(members) && members.length > 0;
        if (hasAnyone && !next[cid]) next[cid] = Date.now();
        if (!hasAnyone && next[cid]) delete next[cid];
      }
      return next;
    });
  }, [voiceMembers]);

  // ---- voice ----
  useEffect(() => {
    const subs = [];
    subs.push(socket.on('voice:state', (d) => {
      setVoiceChannel(d.channelId);
      setVoiceUsers(d.users || []);
      setVoiceMembers((m) => ({ ...m, [d.channelId]: d.users || [] }));
    }));
    subs.push(socket.on('voice:list', (d) => {
      // replace all voice members for this guild with the fresh snapshot
      setVoiceMembers((m) => {
        const next = { ...m };
        for (const ch of d.channels || []) {
          next[ch.channelId] = ch.users || [];
        }
        return next;
      });
    }));
    subs.push(socket.on('voice:member:join', (d) => {
      if (d.userId !== user?.id) socket.connectNewPeer(d.userId);
      const usersToAdd = [ { id: d.userId, user: d.user } ];
      setVoiceMembers((m) => {
        const key = d.channelId;
        const existing = (m[key] || []).filter((u) => u.id !== d.userId);
        return { ...m, [key]: [...existing, ...usersToAdd] };
      });
      setVoiceUsers((arr) => [...arr, { id: d.userId, user: d.user }]);
    }));
    subs.push(socket.on('voice:member:leave', (d) => {
      socket.removePeer(d.userId);
      stopVad(d.userId);
      // if we left the channel ourselves, clear our active channel state
      if (user && d.userId === user.id) {
        setVoiceChannel((c) => (c === d.channelId ? null : c));
      }
      setRemoteScreens((arr) => arr.filter((x) => x.uid !== d.userId));
      setVoiceMembers((m) => {
        const key = d.channelId;
        if (!key || !m[key]) return m;
        return { ...m, [key]: m[key].filter((u) => u.id !== d.userId) };
      });
      setVoiceUsers((arr) => arr.filter((u) => u.id !== d.userId));
    }));
    subs.push(socket.on('rtc:offer', (d) => socket.handleOffer(d.from, d.sdp)));
    subs.push(socket.on('rtc:answer', (d) => socket.handleAnswer(d.from, d.sdp)));
    subs.push(socket.on('rtc:ice', (d) => socket.handleIce(d.from, d.candidate)));
    socket.onRemoteTrack = (uid, stream) => {
      const audio = new Audio();
      audio.srcObject = stream;
      audio.autoplay = true;
      // route to the selected output device (headphones) if supported
      const outId = localStorage.getItem('mvt_out_id');
      if (outId && audio.setSinkId) {
        audio.setSinkId(outId).catch(() => {});
      }
      audio.play().catch(() => {});
      // start voice-activity detection for this peer
      startVad(uid, stream);
      setRemoteAudios((arr) => [...arr, { uid, audio }]);
    };
    socket.onRemoteScreen = (uid, stream) => {
      setRemoteScreens((arr) => {
        const filtered = arr.filter((x) => x.uid !== uid);
        return [...filtered, { uid, stream }];
      });
    };
    socket.onShareChanged = (sh) => setSharing(sh);
    return () => { subs.forEach((off) => off && off()); };
  }, [socket, user]);

  // poll voice channel membership every 5 seconds so users appear/update
  useEffect(() => {
    if (!activeGuild) return undefined;
    const run = () => socket.fetchVoiceList(activeGuild.id);
    run();
    const id = setInterval(run, 5000);
    return () => clearInterval(id);
  }, [socket, activeGuild]);

  // ---- voice activity detection (green ring while talking) ----
  function startVad(uid, stream) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      // Electron/Chromium starts the context suspended; resume it so mic data flows.
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      vadAnalysers.current.set(uid, { analyser, ctx });
      const buf = new Uint8Array(analyser.fftSize);
      let lastTalking = speakingRef.current.has(uid);
      const loop = setInterval(() => {
        // time-domain RMS is the standard, sensitive way to detect speech
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128; // -1..1
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        const talking = rms > 0.05; // sensitivity threshold
        if (talking !== lastTalking) {
          lastTalking = talking;
          if (talking) speakingRef.current.add(uid);
          else speakingRef.current.delete(uid);
          setSpeakingUsers(new Set(speakingRef.current));
        }
      }, 80);
      vadAnalysers.current.get(uid).loopId = loop;
    } catch (e) {
      console.warn('[vad] failed for', uid, e);
    }
  }

  function stopVad(uid) {
    const entry = vadAnalysers.current.get(uid);
    if (entry) {
      if (entry.loopId) clearInterval(entry.loopId);
      try { entry.ctx.close(); } catch {}
      vadAnalysers.current.delete(uid);
    }
    speakingRef.current.delete(uid);
    setSpeakingUsers(new Set(speakingRef.current));
  }

  // ---- actions ----
  function selectGuild(guild) {
    setActiveGuild(guild);
    setActiveChannel(null);
    setChannelMessages({ channelId: null, messages: [] });
    setView('guild');
    socket.fetchGuild(guild.id);
  }

  function openDm(friend) {
    // friend has {id, username, display_name}; open a message to that user
    setActiveChannel({ isDm: true, id: `pending-${friend.id}`, dmUser: friend, name: friend.display_name || friend.username });
    socket.openDm(friend.username);
  }

  function selectDmChannel(dm) {
    setActiveChannel({ isDm: true, id: dm.id, name: (dm.other_user?.display_name || dm.other_user?.username || 'ЛС') });
    lastFetchRef.current = dm.id;
    setChannelMessages({ channelId: null, messages: [] });
    socket.fetchMessages(dm.id);
  }

  function selectChannel(channel) {
    setActiveChannel(channel);
    // clear messages immediately so the previous channel's history doesn't linger
    lastFetchRef.current = channel.id;
    setChannelMessages({ channelId: null, messages: [] });
    socket.fetchMessages(channel.id);
    if (channel.type === 'voice' && channel.id !== voiceChannel) {
      joinVoice(channel);
    }
  }

  async function joinVoice(channel) {
    try {
      // When moving between channels, remove ourselves from every other channel
      // first, so we don't linger in the previous one.
      if (user) {
        setVoiceMembers((m) => {
          const next = {};
          for (const [key, users] of Object.entries(m)) {
            next[key] = users.filter((u) => u.id !== user.id);
          }
          return next;
        });
      }
      await socket.joinVoice(channel.id);
      setVoiceChannel(channel.id);
      setVoiceGuildId(channel.guild_id ?? activeGuild?.id ?? null);
      // monitor our own mic for the green "talking" ring too
      if (socket.localStream && user) {
        try { stopVad(user.id); } catch {}
        startVad(user.id, socket.localStream);
      }
    } catch (e) {
      alert('Не удалось войти в голосовой канал. Проверьте доступ к микрофону.\n\n' + (e && e.message ? e.message : e));
    }
  }

  function leaveVoiceLocal() {
    socket.leaveVoice();
    setVoiceChannel(null);
    setVoiceGuildId(null);
    setExpandedShare(false);
    setVoiceUsers([]);
    // remove ourselves from every channel map so we don't linger anywhere
    if (user) {
      setVoiceMembers((m) => {
        const next = {};
        for (const [key, users] of Object.entries(m)) {
          const kept = users.filter((u) => u.id !== user.id);
          if (kept.length) next[key] = kept;
        }
        return next;
      });
    } else {
      setVoiceMembers({});
    }
    for (const a of remoteAudios) { a.audio.pause(); }
    // stop VAD loops for all current peers
    for (const uid of Array.from(vadAnalysers.current.keys())) stopVad(uid);
    setRemoteAudios([]);
  }

  function toggleMute() {
    const m = !muted; setMuted(m);
    socket.localStream?.getAudioTracks().forEach((t) => (t.enabled = !m));
  }
  function toggleDeafen() { setDeafened(!deafened); }

  async function toggleShare() {
    if (sharing) {
      await socket.stopShare();
      setSharing(false);
      return;
    }
    // reset any leftover fullscreen overlay from a previous session
    setExpandedShare(false);
    // open custom source picker (Electron) or fall back to system dialog in browser
    if (typeof window !== 'undefined' && window.electronAPI?.getShareSources) {
      const srcs = await window.electronAPI.getShareSources();
      if (srcs && srcs.length) {
        setShareSources(srcs);
        setSharePickerOpen(true);
        return;
      }
    }
    // fallback: browser default picker
    const ok = await socket.startShare(null);
    if (ok) setSharing(true);
  }

  async function startShareSource(source) {
    setSharePickerOpen(false);
    setExpandedShare(false);
    const ok = await socket.startShare(source.id);
    if (ok) setSharing(true);
  }

  function applySettings() {
    const url = socket.saveServerUrl(serverAddr);
    setSettingsOpen(false);
    // reconnect to the new address
    if (socket.ws) { try { socket.ws.close(); } catch {} }
    socket.connect(url || undefined);
  }

  if (!user) return <AuthScreen socket={socket} onAuth={setUser} />;

  return (
    <div className="app-root">
      {updateInfo && (
        <div className="update-banner">
          <span className="ub-inner">🚀 Доступна новая версия <b>{updateInfo.version}</b> (у вас {APP_VERSION})</span>
          <button className="btn-primary" onClick={() => {
            const url = updateInfo.downloadUrl || `https://github.com/${GH_REPO}/releases/latest`;
            if (typeof window !== 'undefined' && window.electronAPI?.openExternal) {
              window.electronAPI.openExternal(url);
            } else if (typeof window !== 'undefined' && window.open) {
              window.open(url, '_blank');
            }
            setUpdateInfo(null);
          }}>Скачать</button>
        </div>
      )}
      <Sidebar guilds={guilds} activeGuild={activeGuild} onSelect={selectGuild}
        voiceInGuildId={voiceGuildId}
        onCreate={() => { setGuildName(''); setCreatingGuild(true); }}
        onOpenDm={() => setView('dm')} onOpenFriends={() => { socket.listFriendRequests(); setView('friends'); }}
        onOpenSearch={() => setView('search')}
        view={view} />
      {view === 'guild' && (
        <GuildPanel guild={activeGuild} channels={guildChannels} activeChannel={activeChannel}
          onSelect={selectChannel} socket={socket}
          voiceMembers={voiceMembers} speakingUsers={speakingUsers}
          currentVoiceId={voiceChannel} channelSince={channelSince}
          onLeave={() => socket.leaveGuild(activeGuild.id)} />
      )}
      {view === 'search' && (
        <SearchPanel socket={socket} results={searchResults}
          onJoin={(id) => { socket.joinGuild(id); }}
          onSearch={(q) => socket.searchGuilds(q)} />
      )}
      {view === 'friends' && (
        <FriendsPanel socket={socket} friends={friends}
          incoming={friendReqIncoming} pending={friendReqPending}
          onRequest={(nick) => socket.requestFriend(nick)}
          onAccept={(u) => socket.acceptFriend(u.id)}
          onDecline={(u) => socket.declineFriend(u.id)}
          onDm={(friend) => openDm(friend)} />
      )}
      {view === 'dm' && (
        <DmPanel socket={socket} dms={dms} activeChannel={activeChannel}
          onSelect={selectDmChannel} />
      )}
      <ChatPanel
        channel={activeChannel}
        messages={channelMessages}
        socket={socket}
        currentUserId={user?.id}
        voiceChannel={voiceChannel}
        voiceMembers={voiceMembers}
        speakingUsers={speakingUsers}
        shareStream={socket.shareStream}
        labelsVisible={barVisible}
        expandedShare={expandedShare}
        onToggleExpand={(v) => setExpandedShare(v)}
        onVoiceState={setVoiceChannel} />
      {remoteScreens.length > 0 && (
        <div className="remote-screens">
          {remoteScreens.map((s) => (
            <ScreenView key={s.uid} stream={s.stream} />
          ))}
        </div>
      )}
      <VoiceBar
        voiceChannel={voiceChannel}
        voiceUsers={voiceUsers}
        muted={muted} deafened={deafened}
        sharing={sharing}
        visible={barVisible}
        onMute={toggleMute} onDeafen={toggleDeafen}
        onShare={toggleShare}
        onLeave={leaveVoiceLocal} />
      <UserBar user={user} onLogout={() => { socket.logout(); setUser(null); }}
        onOpenSettings={openSettings} />

      {creatingGuild && (
        <div className="modal-overlay" onClick={() => setCreatingGuild(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Новый сервер</h3>
            <input
              autoFocus
              value={guildName}
              onChange={(e) => setGuildName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { const n = guildName.trim(); if (n) { socket.createGuild(n); setCreatingGuild(false); } }
                if (e.key === 'Escape') setCreatingGuild(false);
              }}
              placeholder="Название сервера"
            />
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setCreatingGuild(false)}>Отмена</button>
              <button className="btn-primary" onClick={() => { const n = guildName.trim(); if (n) { socket.createGuild(n); setCreatingGuild(false); } }}>Создать</button>
            </div>
          </div>
        </div>
      )}

      {sharePickerOpen && (
        <div className="modal-overlay" onClick={() => setSharePickerOpen(false)}>
          <div className="modal modal-sources" onClick={(e) => e.stopPropagation()}>
            <div className="setts-head">Что показать?</div>
            <div className="src-grid">
              {shareSources.map((s) => (
                <button key={s.id} className="src-item" onClick={() => startShareSource(s)}>
                  {s.thumbnail ? <img src={s.thumbnail} alt={s.name} /> : <div className="src-no-thumb">📺</div>}
                  <div className="src-name">{s.name}</div>
                  <div className="src-type">{s.type === 'screen' ? 'Экран' : 'Приложение'}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {settingsOpen && (
        <div className="modal-overlay" onClick={() => setSettingsOpen(false)}>
          <div className="modal-settings" onClick={(e) => e.stopPropagation()}>
            <div className="setts-head">Настройки</div>
            <div className="setts-body">
              <div className="sett-nav">
                <button className={`sett-nav-item ${settTab === 'server' ? 'active' : ''}`} onClick={() => setSettTab('server')}>
                  <span className="sett-nav-ico">🖥</span> Сервер
                </button>
                <button className={`sett-nav-item ${settTab === 'mic' ? 'active' : ''}`} onClick={() => setSettTab('mic')}>
                  <span className="sett-nav-ico">🎧</span> Звук
                </button>
              </div>
              <div className="sett-content">
                {settTab === 'server' && (
                  <>
                    <div className="sett-title">Сервер</div>
                    <p className="sett-hint">Адрес сервера (оставьте пустым для локального):</p>
                    {lanIps.length > 0 && (
                      <p className="sett-hint">💻 Этот ПК (для входа другим): {lanIps.map((x) => x.address).join(', ')}</p>
                    )}
                    <input
                      value={serverAddr}
                      onChange={(e) => setServerAddr(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') applySettings(); }}
                      placeholder="192.168.1.10  или  ws://host:port/ws"
                    />
                    <div className="modal-actions">
                      <button className="btn-secondary" onClick={() => setSettingsOpen(false)}>Отмена</button>
                      <button className="btn-primary" onClick={applySettings}>Сохранить и переподключить</button>
                    </div>
                  </>
                )}
                {settTab === 'mic' && <SoundSettings socket={socket} />}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Sidebar({ guilds, activeGuild, onSelect, onCreate, voiceInGuildId, view, onOpenDm, onOpenFriends, onOpenSearch }) {
  const cls = (v) => (view === v ? 'sd-item active' : 'sd-item');
  return (
    <div className="sidebar">
      <div className="sd-top">
        <button className={`sd-dm ${view === 'search' ? 'active' : ''}`} title="Поиск серверов" onClick={onOpenSearch}>
          <span role="img" aria-label="search">🔍</span>
        </button>
        <button className={`sd-dm ${view === 'friends' ? 'active' : ''}`} style={{ marginTop: 6 }} title="Друзья" onClick={onOpenFriends}>
          <span role="img" aria-label="friends">👥</span>
        </button>
        <button className={`sd-dm ${view === 'dm' ? 'active' : ''}`} style={{ marginTop: 6 }} title="Прямые сообщения" onClick={onOpenDm}>
          <span role="img" aria-label="dm">💬</span>
        </button>
      </div>
      <div className="sd-list">
        {guilds.map((g) => (
          <button key={g.id} className={`sd-guild ${activeGuild?.id === g.id ? 'active' : ''} ${voiceInGuildId === g.id ? 'voice' : ''}`}
            title={g.name} onClick={() => onSelect(g)}>
            {g.name.slice(0, 2).toUpperCase()}
            {voiceInGuildId === g.id && (
              <span className="sd-guild-voice" title="Вы в голосовом канале">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 5 6 9H2v6h4l5 4V5z" fill="currentColor" stroke="none" />
                  <path d="M15.5 8.5a5 5 0 0 1 0 7" />
                  <path d="M18.5 5.5a9 9 0 0 1 0 13" />
                </svg>
              </span>
            )}
          </button>
        ))}
        <button className="sd-add" onClick={onCreate}>+</button>
      </div>
      <div className="sd-bottom">{}</div>
    </div>
  );
}

function GuildPanel({ guild, channels, activeChannel, onSelect, socket, onLeave, voiceMembers, speakingUsers, currentVoiceId, channelSince }) {
  const text = channels.filter((c) => c.type === 'text');
  const voice = channels.filter((c) => c.type === 'voice');
  const [creating, setCreating] = useState(null); // 'text' | 'voice' | null
  const [name, setName] = useState('');

  function submit(type) {
    const n = name.trim();
    if (n) socket.createChannel(guild.id, n, type);
    setName('');
    setCreating(null);
  }

  return (
    <div className="guild-panel">
      <div className="gp-head">
        {guild?.name || '—'}
        <div className="gp-menu">⋯</div>
      </div>
      <div className="gp-body">
        <div className="gp-cat">
          <span className="gp-cat-name">ТЕКСТОВЫЕ</span>
          <button className="gp-add" onClick={() => setCreating('text')}>+</button>
        </div>
        {text.map((c) => (
          <ChannelRow key={c.id} ch={c} active={activeChannel?.id === c.id} onClick={() => onSelect(c)} icon="#" />
        ))}
        <div className="gp-cat">
          <span className="gp-cat-name">ГОЛОСОВЫЕ</span>
          <button className="gp-add" onClick={() => setCreating('voice')}>+</button>
        </div>
        {voice.map((c) => (
          <div key={c.id} className="vc-block">
            <ChannelRow ch={c} active={activeChannel?.id === c.id} onClick={() => onSelect(c)} icon="voice"
              current={currentVoiceId === c.id}
              timerStart={channelSince[c.id] || null} />
            {(voiceMembers[c.id] || []).map((u) => (
              <div key={u.id} className={`vc-user ${speakingUsers.has(u.id) ? 'speaking' : ''}`}>
                <span className="vc-user-ico"><span>{u.user?.display_name?.[0] || u.user?.username?.[0] || '?'}</span></span>
                <span className="vc-user-name">{u.user?.display_name || u.user?.username || `#${u.id}`}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      {guild && (
        <button className="gp-leave" onClick={onLeave}>↩ Покинуть сервер</button>
      )}

      {creating && (
        <div className="modal-overlay" onClick={() => setCreating(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{creating === 'voice' ? 'Новый голосовой канал' : 'Новый текстовый канал'}</h3>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(creating); if (e.key === 'Escape') setCreating(null); }}
              placeholder="Имя канала"
            />
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setCreating(null)}>Отмена</button>
              <button className="btn-primary" onClick={() => submit(creating)}>Создать</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ChannelRow({ ch, active, onClick, icon, current, timerStart }) {
  return (
    <button className={`ch-row ${active ? 'active' : ''} ${current ? 'current' : ''}`} onClick={onClick}>
      <span className="ch-icon">
        {icon === 'voice' ? (
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
            <path d="M11 5 6 9H2v6h4l5 4V5z" />
            <path d="M15.5 8.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <path d="M18.5 5.5a9 9 0 0 1 0 13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        ) : (
          icon
        )}
      </span>
      <span className="ch-name">{ch.name}</span>
      {timerStart && <ChannelTimer startTime={timerStart} />}
    </button>
  );
}

function ChannelTimer({ startTime }) {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setSec(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    setSec(Math.floor((Date.now() - startTime) / 1000));
    return () => clearInterval(id);
  }, [startTime]);
  const mm = String(Math.floor(sec / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return <span className="ch-current-timer">{mm}:{ss}</span>;
}

function SearchPanel({ socket, results, onJoin, onSearch }) {
  const [q, setQ] = useState('');
  useEffect(() => {
    socket.searchGuilds('');
    return () => {};
  }, [socket]);
  return (
    <div className="search-panel">
      <div className="gp-head">Поиск серверов</div>
      <div className="sp-body">
        <input
          className="sp-input"
          placeholder="Название сервера или хоста…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onSearch(q); }}
        />
        <button className="sp-search-btn" onClick={() => onSearch(q)}>Найти</button>
        <div className="sp-results">
          {(results || []).map((g) => (
            <div key={g.id} className="sp-result">
              <div className="sp-result-ico">{g.name.slice(0, 2).toUpperCase()}</div>
              <div className="sp-result-info">
                <span className="sp-result-name">{g.name}</span>
                <span className="sp-result-meta">{g.member_count} участник(ов)</span>
              </div>
              <button className="btn-primary" disabled={g.is_member}
                onClick={() => onJoin(g.id)}>
                {g.is_member ? '✓ Вы внутри' : 'Вступить'}
              </button>
            </div>
          ))}
          {results.length === 0 && <p className="sp-empty">Ничего не найдено</p>}
        </div>
      </div>
    </div>
  );
}

function FriendsPanel({ socket, friends, incoming, pending, onRequest, onAccept, onDecline, onDm }) {
  const [nick, setNick] = useState('');
  const [msg, setMsg] = useState('');
  function doRequest(n) {
    const v = n.trim();
    if (!v) return;
    onRequest(v);
    setNick('');
  }
  return (
    <div className="search-panel">
      <div className="gp-head">Друзья</div>
      <div className="sp-body">
        <div className="sp-addrow">
          <input className="sp-input" placeholder="Имя пользователя (ник)" value={nick}
            onChange={(e) => setNick(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') doRequest(nick); }} />
          <button className="sp-search-btn" onClick={() => doRequest(nick)}>+ Заявка</button>
        </div>

        <div className="sp-cat">ВХОДЯЩИЕ ЗАЯВКИ ({incoming.length})</div>
        <div className="sp-results">
          {(incoming || []).map((u) => (
            <div key={u.id} className="sp-result">
              <div className="sp-result-ico">{u.display_name?.[0] || u.username?.[0] || '?'}</div>
              <div className="sp-result-info">
                <span className="sp-result-name">{u.display_name || u.username}</span>
                <span className="sp-result-meta">@{u.username}</span>
              </div>
              <button className="btn-secondary" onClick={() => onAccept(u)}>✓ Принять</button>
              <button className="btn-secondary" style={{ color: 'var(--red)' }} onClick={() => onDecline(u)}>✕</button>
            </div>
          ))}
          {(incoming || []).length === 0 && <p className="sp-empty-mini">Нет входящих заявок</p>}
        </div>

        <div className="sp-cat">ОТПРАВЛЕННЫЕ ({pending.length})</div>
        <div className="sp-results">
          {(pending || []).map((u) => (
            <div key={u.id} className="sp-result muted">
              <div className="sp-result-ico">{u.display_name?.[0] || u.username?.[0] || '?'}</div>
              <div className="sp-result-info">
                <span className="sp-result-name">{u.display_name || u.username}</span>
                <span className="sp-result-meta">ожидает ответа</span>
              </div>
            </div>
          ))}
          {(pending || []).length === 0 && <p className="sp-empty-mini">Нет отправленных</p>}
        </div>

        <div className="sp-cat">МОИ ДРУЗЬЯ ({friends.length})</div>
        <div className="sp-results">
          {friends.map((f) => (
            <div key={f.id} className="sp-result">
              <div className="sp-result-ico">{f.display_name?.[0] || f.username?.[0] || '?'}</div>
              <div className="sp-result-info">
                <span className="sp-result-name">{f.display_name || f.username}</span>
                <span className="sp-result-meta">@{f.username}</span>
              </div>
              <button className="btn-primary" onClick={() => onDm(f)}>💬</button>
            </div>
          ))}
          {friends.length === 0 && <p className="sp-empty">Друзей пока нет</p>}
        </div>
      </div>
    </div>
  );
}

function DmPanel({ socket, dms, activeChannel, onSelect }) {
  return (
    <div className="search-panel">
      <div className="gp-head">Прямые сообщения</div>
      <div className="sp-body">
        <div className="sp-results">
          {dms.map((d) => {
            const name = d.other_user?.display_name || d.other_user?.username || 'ЛС';
            return (
              <div key={d.id} className={`sp-result ${activeChannel?.id === d.id ? 'active' : ''}`} onClick={() => onSelect(d)}>
                <div className="sp-result-ico">{name[0]}</div>
                <div className="sp-result-info">
                  <span className="sp-result-name">{name}</span>
                  <span className="sp-result-meta">@{(d.other_user?.username) || ''}</span>
                </div>
              </div>
            );
          })}
          {dms.length === 0 && <p className="sp-empty">Нет диалогов. Добавьте друга и откройте переписку.</p>}
        </div>
      </div>
    </div>
  );
}

function ChatPanel({ channel, messages, socket, currentUserId, voiceChannel, voiceMembers, speakingUsers, shareStream, labelsVisible, expandedShare, onToggleExpand }) {
  useEffect(() => {
    const el = document.getElementById('msg-scroll');
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.messages?.length, channel?.id]);

  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editingText, setEditingText] = useState('');
  const editInputRef = useRef(null);

  useEffect(() => {
    if (editingId != null && editInputRef.current) {
      editInputRef.current.focus();
    }
  }, [editingId, editingText]);

  function submit(e) {
    e.preventDefault();
    const t = draft.trim();
    if (!t) return;
    socket.sendMessage(channel.id, t);
    setDraft('');
  }

  function submitEdit(m) {
    const t = editingText.trim();
    if (!t) { setEditingId(null); return; }
    socket.editMessage(m.id, t);
    setEditingId(null);
    setEditingText('');
  }

  // voice tiles shown only when this exact voice channel is open
  const voiceId = typeof voiceChannel === 'object' && voiceChannel ? voiceChannel.id : voiceChannel;
  const showTiles = voiceId != null && channel != null && channel.id === voiceId;
  // input area only makes sense for text channels / DMs
  const canChat = channel && (channel.isDm || channel.type === 'text' || channel.type === undefined);

  return (
    <div className="chat-wrap">
      {showTiles && (
        <div className={`voice-tiles ${labelsVisible ? '' : 'labels-hidden'}`}>
          {shareStream && (
            <div className="voice-tile self-share">
              <SelfShareVideo stream={shareStream} />
              <div className="vt-name">🖥 Ваша трансляция</div>
              <button className="vt-expand" title={expandedShare ? 'Свернуть' : 'Развернуть'}
                onClick={() => onToggleExpand(!expandedShare)}>
                {expandedShare ? '🗕' : '⛶'}
              </button>
            </div>
          )}
          {(voiceMembers[voiceId] || []).map((u) => (
            <div key={u.id} className={`voice-tile ${speakingUsers.has(u.id) ? 'speaking' : ''}`}>
              <div className="vt-avatar">
                {u.user?.display_name?.[0] || u.user?.username?.[0] || '?'}
              </div>
              <div className="vt-name">{u.user?.display_name || u.user?.username || `#${u.id}`}</div>
            </div>
          ))}
          {(voiceMembers[voiceId] || []).length === 0 && !shareStream && (
            <div className="voice-tiles-empty" />
          )}
        </div>
      )}
      {!channel && !voiceId && null}
      {channel && (
        <>
          {canChat ? (
            <>
              <div id="msg-scroll" className="msg-scroll">
                {(messages.messages || []).map((m) => {
                  const mine = m.user_id === currentUserId;
                  if (m.deleted) {
                    return (
                      <div key={m.id} className="msg msg-deleted">
                        <div className="msg-body">
                          <div className="msg-content msg-deleted-text">🚫 Сообщение удалено</div>
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div key={m.id} className="msg">
                      <div className="msg-avatar">{m.user?.display_name?.[0] || '?'}</div>
                      <div className="msg-body">
                        <div className="msg-top">
                          <span className="msg-author">{m.user?.display_name || m.user?.username}</span>
                          <span className="msg-time">{new Date(m.created_at).toLocaleTimeString('ru')}</span>
                          {mine && (
                            <span className="msg-actions">
                              <button className="msg-btn" title="Редактировать" onClick={() => { setEditingId(m.id); setEditingText(m.content); }}>✏️</button>
                              <button className="msg-btn" title="Удалить" onClick={() => { if (confirm('Удалить сообщение?')) socket.deleteMessage(m.id); }}>🗑</button>
                            </span>
                          )}
                        </div>
                        {editingId === m.id ? (
                          <div className="msg-editrow">
                            <input ref={editInputRef} value={editingText} onChange={(e) => setEditingText(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter') submitEdit(m); if (e.key === 'Escape') setEditingId(null); }} />
                            <button className="chat-send" onClick={() => submitEdit(m)}>✓</button>
                          </div>
                        ) : (
                          <div className="msg-content">{m.content} {m.edited ? <span className="msg-edited">(изменено)</span> : null}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <form className="chat-input" onSubmit={submit}>
                <input value={draft} onChange={(e) => setDraft(e.target.value)}
                  placeholder="Введите сообщение…" autoFocus />
                <button type="submit" className="chat-send" title="Отправить">➤</button>
              </form>
            </>
          ) : (
            null
          )}
        </>
      )}

      {expandedShare && shareStream && (
        <div className="share-expanded" onClick={() => onToggleExpand(false)}>
          <SelfShareVideo stream={shareStream} />
          <button className="vt-expand share-expanded-btn" title="Свернуть"
            onClick={() => onToggleExpand(false)}>
            🗕
          </button>
        </div>
      )}
    </div>
  );
}

function VoiceBar({ voiceChannel, voiceUsers, muted, deafened, sharing, visible, onMute, onDeafen, onShare, onLeave }) {
  if (!voiceChannel) return null;
  return (
    <div className={`voice-bar ${visible ? 'visible' : ''}`}>
      <div className="vb-controls">
        <button className={`vb-btn ${muted ? 'off' : ''}`} onClick={onMute} title="Отключить микрофон">{muted ? '🔇' : '🎙'}</button>
        <button className={`vb-btn ${deafened ? 'off' : ''}`} onClick={onDeafen} title="Заглушить всех">{deafened ? '🔇' : '🎧'}</button>
        <button className={`vb-btn ${sharing ? 'sharing' : ''}`} onClick={onShare} title={sharing ? 'Остановить демонстрацию экрана' : 'Демонстрация экрана'}>{sharing ? '🟥' : '🖥'}</button>
        <button className="vb-btn leave" onClick={onLeave} title="Покинуть канал">📴</button>
      </div>
    </div>
  );
}

function UserBar({ user, onLogout, onOpenSettings }) {
  return (
    <div className="user-bar">
      <div className="ub-avatar">{user.display_name?.[0] || user.username[0]}</div>
      <div className="ub-info">
        <span className="ub-name">{user.display_name || user.username}</span>
        <span className="ub-status">в сети</span>
      </div>
      <button className="ub-settings" onClick={onOpenSettings} title="Настройки">⚙</button>
      <button className="ub-logout" onClick={onLogout} title="Выйти">⏻</button>
    </div>
  );
}

function SoundSettings({ socket }) {
  const [inDevices, setInDevices] = useState([]);
  const [outDevices, setOutDevices] = useState([]);
  const [selectedIn, setSelectedIn] = useState(() => localStorage.getItem('mvt_mic_id') || '');
  const [selectedOut, setSelectedOut] = useState(() => localStorage.getItem('mvt_out_id') || '');
  const [testing, setTesting] = useState(false);
  const [testingOut, setTestingOut] = useState(false);
  const [level, setLevel] = useState(0);
  const [outTestMsg, setOutTestMsg] = useState('');
  const levelRef = useRef(0);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const testAudioRef = useRef(null);

  useEffect(() => {
    const refresh = () => navigator.mediaDevices.enumerateDevices().then((ds) => {
      setInDevices(ds.filter((d) => d.kind === 'audioinput'));
      setOutDevices(ds.filter((d) => d.kind === 'audiooutput'));
    }).catch(() => {});
    refresh();
    // re-enumerate when devices change
    navigator.mediaDevices.addEventListener?.('devicechange', refresh);
    return () => {
      navigator.mediaDevices.removeEventListener?.('devicechange', refresh);
      stopTest();
      stopOutTest();
    };
  }, []);

  function stopTest() {
    setTesting(false);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
    setLevel(0); levelRef.current = 0;
  }

  async function startTest() {
    stopTest();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: selectedIn ? { deviceId: { exact: selectedIn } } : true,
      });
      streamRef.current = stream;
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / buf.length);
        const pct = Math.min(100, Math.round(rms * 400));
        levelRef.current = pct;
        setLevel(pct);
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
      setTesting(true);
    } catch (e) {
      alert('Не удалось открыть микрофон: ' + (e && e.message ? e.message : e));
    }
  }

  function stopOutTest() {
    setTestingOut(false);
    if (testAudioRef.current) {
      try { testAudioRef.current.pause(); testAudioRef.current.src = ''; } catch {}
      testAudioRef.current = null;
    }
    setOutTestMsg('');
  }

  async function testOutput() {
    stopOutTest();
    try {
      const audio = new Audio();
      testAudioRef.current = audio;
      // generate a short beep via WebAudio and play to the selected sink
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 440;
      osc.connect(gain);
      gain.connect(ctx.destination);
      // route to output device if supported
      if (selectedOut && ctx.setSinkId) {
        try { await ctx.setSinkId(selectedOut); } catch {}
      }
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
      osc.start();
      osc.stop(ctx.currentTime + 0.8);
      setTestingOut(true);
      setOutTestMsg('Играет тестовый сигнал…');
      setTimeout(() => { stopOutTest(); }, 1000);
    } catch (e) {
      // fallback: try HTMLAudioElement setSinkId
      try {
        const audio = new Audio();
        testAudioRef.current = audio;
        audio.src = 'data:audio/wav;base64,UklGRlwAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
        if (selectedOut && audio.setSinkId) { try { await audio.setSinkId(selectedOut); } catch {} }
        await audio.play().catch(() => {});
        setTestingOut(true);
        setOutTestMsg('Играет тестовый сигнал…');
        setTimeout(() => stopOutTest(), 1200);
      } catch (e2) {
        alert('Не удалось воспроизвести тест: ' + (e2 && e2.message ? e2.message : e2));
      }
    }
  }

  function apply() {
    localStorage.setItem('mvt_mic_id', selectedIn);
    localStorage.setItem('mvt_out_id', selectedOut);
    if (socket && socket.requestMicDevice) socket.requestMicDevice(selectedIn);
    setLevel(0);
  }

  return (
    <div className="mic-settings">
      <div className="sett-title">Микрофон</div>
      <p className="sett-hint">Устройство ввода для голосовых каналов:</p>
      <select
        className="sp-input"
        value={selectedIn}
        onChange={(e) => setSelectedIn(e.target.value)}
      >
        <option value="">По умолчанию (системный)</option>
        {inDevices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>{d.label || `Микрофон ${d.deviceId.slice(0, 6)}`}</option>
        ))}
      </select>
      {inDevices.length === 0 && <p className="sp-empty-mini">Не удалось получить список устройств (разрешите доступ к микрофону)</p>}

      <div className="mic-level">
        <span>Уровень:</span>
        <div className="mic-bar"><div className="mic-bar-fill" style={{ width: level + '%' }} /></div>
      </div>

      <div className="modal-actions">
        {!testing ? (
          <button className="btn-primary" onClick={startTest}>Тест микрофона</button>
        ) : (
          <button className="btn-secondary" onClick={stopTest}>Остановить</button>
        )}
      </div>

      <div style={{ margin: '18px 0 0', borderTop: '1px solid var(--bg3)', paddingTop: '16px' }}>
        <div className="sett-title">Наушники (вывод)</div>
        <p className="sett-hint">Устройство вывода звука:</p>
        <select
          className="sp-input"
          value={selectedOut}
          onChange={(e) => setSelectedOut(e.target.value)}
        >
          <option value="">По умолчанию (системный)</option>
          {outDevices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>{d.label || `Наушники ${d.deviceId.slice(0, 6)}`}</option>
          ))}
        </select>
        {outTestMsg && <p className="sp-empty-mini">{outTestMsg}</p>}
        <div className="modal-actions">
          {!testingOut ? (
            <button className="btn-primary" onClick={testOutput}>Тест наушников</button>
          ) : (
            <button className="btn-secondary" onClick={stopOutTest}>Стоп</button>
          )}
          <button className="btn-secondary" onClick={apply}>Применить</button>
        </div>
      </div>
    </div>
  );
}

function ScreenView({ stream }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.srcObject = stream;
      ref.current.play().catch(() => {});
    }
  }, [stream]);
  return <video ref={ref} className="screen-view" autoPlay playsInline muted />;
}

function SelfShareVideo({ stream }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.srcObject = stream;
      ref.current.play().catch(() => {});
    }
  }, [stream]);
  return <video ref={ref} className="vt-video" autoPlay playsInline muted />;
}