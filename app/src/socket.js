// WebSocket client wrapper with auth + voice (WebRTC) helpers.
export class SocketClient {
  constructor() {
    this.ws = null;
    this.handlers = new Map();
    this.token = localStorage.getItem('mvt_token') || '';
    this.peers = new Map(); // userId -> RTCPeerConnection
    this.localStream = null;
    this.shareStream = null; // screen-share stream
    this.muted = false;
    this.deafened = false;
    this.voiceChannelId = null;
  }

  connect(url) {
    // Shared-server mode: connect to the configured address (⚙ settings) first.
    // Explicit url (from settings save) wins, then the saved address, then the
    // embedded server (server-mode instance), then localhost default.
    const saved = localStorage.getItem('mvt_server_url') || '';
    let local = '';
    if (typeof window !== 'undefined' && window.electronAPI?.getServerUrl) {
      local = window.electronAPI.getServerUrl() || '';
    }
    this.url = url || saved || local || this._browserWsUrl() || 'ws://localhost:3000/ws';
    this._openSocket(this.url);
  }

  _browserWsUrl() {
    if (typeof window === 'undefined' || !window.location) return '';
    // only valid for http(s) origins (browser/web mode), not file:// (Electron)
    if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') return '';
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws`;
  }

  _openSocket(url, fallback) {
    if (this.ws) { try { this.ws.close(); } catch {} }
    this.ws = new WebSocket(url);
    this.ws.onmessage = (e) => this._dispatch(JSON.parse(e.data));
    this.ws.onclose = () => {
      console.warn('[ws] closed', url);
      if (fallback && this.url !== fallback) {
        // local server unreachable -> switch to the network address
        this.url = fallback;
        this._fallback = '';
        setTimeout(() => this._openSocket(this.url), 500);
      } else {
        setTimeout(() => this.connect(), 3000);
      }
    };
  }

  saveServerUrl(raw) {
    let url = String(raw || '').trim();
    if (url) {
      if (!/^wss?:\/\//.test(url)) url = 'ws://' + url;
      if (!/\/ws$/.test(url)) url = url.replace(/\/+$/, '') + '/ws';
      localStorage.setItem('mvt_server_url', url);
    } else {
      localStorage.removeItem('mvt_server_url');
    }
    return url;
  }
  getServerUrl() { return localStorage.getItem('mvt_server_url') || ''; }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type)?.delete(fn);
  }

  _dispatch(msg) {
    const set = this.handlers.get(msg.type);
    if (set) for (const fn of set) fn(msg.data);
  }

  send(type, data = {}) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type, data }));
  }

  // ---- auth ----
  setToken(token, remember = true) {
    this.token = token;
    if (remember) {
      localStorage.setItem('mvt_token', token);
    } else {
      // session-only: keep in memory but don't persist
      localStorage.removeItem('mvt_token');
    }
  }
  clearToken() { this.token = ''; localStorage.removeItem('mvt_token'); }

  // remember = keep logged in on next launch (persist token)
  register(username, displayName, password, remember = true) {
    this._pendingRemember = remember;
    this.send('register', { username, displayName, password });
  }
  login(username, password, remember = true) {
    this._pendingRemember = remember;
    this.send('login', { username, password });
  }
  auth() {
    if (this.token) this.send('auth', { token: this.token });
  }
  // called when server responds auth:ok — persists token if remember was set
  persistToken(token) {
    const remember = this._pendingRemember !== undefined ? this._pendingRemember : true;
    this.setToken(token, remember);
    this._pendingRemember = undefined;
  }
  logout() {
    this.send('logout');
    this.clearToken();
    this.leaveVoice();
  }

  // ---- guilds / channels ----
  fetchGuild(id) { this.send('fetch:guild', { guildId: id }); }
  fetchGuildMembers(guildId) { this.send('guild:members', { guildId }); }
  kickMember(guildId, userId) { this.send('guild:kick-member', { guildId, userId }); }
  createGuild(name) { this.send('guild:create', { name }); }
  joinGuild(id) { this.send('guild:join', { guildId: id }); }
  leaveGuild(id) { this.send('guild:leave', { guildId: id }); }
  createChannel(guildId, name, type = 'text') { this.send('channel:create', { guildId, name, type }); }
  searchGuilds(query) { this.send('search:guilds', { query }); }
  requestFriend(username) { this.send('friend:request', { username }); }
  acceptFriend(userId) { this.send('friend:accept', { userId }); }
  declineFriend(userId) { this.send('friend:decline', { userId }); }
  listFriendRequests() { this.send('friend:requests', {}); }
  listFriends() { this.send('friend:list', {}); }

  // ---- messages ----
  sendMessage(channelId, content) { this.send('message:send', { channelId, content }); }
  editMessage(messageId, content) { this.send('message:edit', { messageId, content }); }
  deleteMessage(messageId) { this.send('message:delete', { messageId }); }
  fetchMessages(channelId, limit = 50) { this.send('fetch:messages', { channelId, limit }); }
  openDm(username) { this.send('dm:open', { username }); }
  fetchVoiceList(guildId) { this.send('voice:list', { guildId }); }
  adminListUsers() { this.send('admin:list-users', {}); }
  adminBan(userId) { this.send('admin:ban', { userId }); }
  adminUnban(userId) { this.send('admin:unban', { userId }); }
  adminDeleteGuild(guildId) { this.send('admin:delete-guild', { guildId }); }

  // ---- voice (WebRTC) ----
  async startMic() {
    if (this.localStream) return this.localStream;
    try {
      const saved = localStorage.getItem('mvt_mic_id') || '';
      const constraints = saved
        ? { audio: { deviceId: { exact: saved } } }
        : { audio: true };
      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.localStream.getAudioTracks().forEach((t) => (t.enabled = !this.muted));
    } catch (e) {
      // mic unavailable/denied — still allow joining to hear others
      this.localStream = null;
      console.warn('[mic] not available:', e && e.message ? e.message : e);
    }
    return this.localStream;
  }

  // Apply mic processing chain (noise gate + filters + gain) and route the
  // processed audio to every connected peer. Settings: {gain, noiseGate, sensitivity}
  async applyMicProcessing(settings = {}) {
    if (!this.localStream) return;
    // stop previous processing chain
    if (this.micProc) {
      try {
        this.micProc.source.disconnect();
        this.micProc.ctx.close();
      } catch {}
      this.micProc = null;
    }
    const gain = Number(settings.gain) || 1;        // amplification (0..3)
    const noiseGate = Number(settings.noiseGate) || 0; // gate threshold 0..1
    const sensitivity = Number(settings.sensitivity) || 0; // 0..1

    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const source = ctx.createMediaStreamSource(this.localStream);
      // high-pass: remove rumble/hum below ~100Hz
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 80 + noiseGate * 140;
      // low-pass: soften harshness above ~8kHz
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 8000;
      // gain stage
      const gainNode = ctx.createGain();
      gainNode.gain.value = gain;
      // noise gate: analyser + gain node, gate closes when level below threshold
      const gateGain = ctx.createGain();
      gateGain.gain.value = 1;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;

      source.connect(hp).connect(lp).connect(gainNode).connect(analyser);
      analyser.connect(gateGain);

      // processed stream
      const dest = ctx.createMediaStreamDestination();
      gateGain.connect(dest);

      this.micProc = { ctx, source, gateGain, analyser, noiseGate, sensitivity };

      // run gate loop
      const buf = new Uint8Array(analyser.fftSize);
      const threshold = 0.02 + noiseGate * 0.12;
      const attack = Math.max(0.015, sensitivity * 0.05);
      const loop = setInterval(() => {
        if (!this.micProc || !this.localStream) return;
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / buf.length);
        const isSpeech = rms > threshold;
        const g = this.micProc.gateGain.gain;
        const target = isSpeech ? 1 : Math.max(0.02, 1 - noiseGate * 0.98);
        // smooth transition (attack/release)
        g.value += (target - g.value) * attack;
        if (!isSpeech && g.value < 0.05) g.value = target;
      }, 20);
      this._micGateLoop = loop;

      // replace the audio track sent to every peer
      const outTrack = dest.stream.getAudioTracks()[0];
      outTrack.enabled = true;
      for (const pc of this.peers.values()) {
        const sender = pc.getSenders && pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
        if (sender) { try { await sender.replaceTrack(outTrack); } catch {} }
      }
      this._procTrack = outTrack;
      return true;
    } catch (e) {
      console.warn('[mic-proc] failed:', e);
      return false;
    }
  }

  // Re-acquire the mic with a specific device (called from mic settings).
  async requestMicDevice(deviceId) {
    try {
      const constraints = deviceId ? { audio: { deviceId: { exact: deviceId } } } : { audio: true };
      const newStream = await navigator.mediaDevices.getUserMedia(constraints);
      const wasEnabled = !!(this.localStream && this.localStream.getAudioTracks().some((t) => t.enabled));
      if (this.localStream) this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = newStream;
      this.localStream.getAudioTracks().forEach((t) => (t.enabled = this.muted ? false : wasEnabled));
      // swap tracks on all live peer connections
      for (const pc of this.peers.values()) {
        const sender = pc.getSenders && pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
        if (sender) {
          try { await sender.replaceTrack(this.localStream.getAudioTracks()[0] || null); } catch {}
        }
      }
      return true;
    } catch (e) {
      console.warn('[mic] device change failed:', e);
      return false;
    }
  }

  async joinVoice(channelId) {
    await this.startMic();
    this.voiceChannelId = channelId;
    this.send('voice:join', { channelId });
    // apply saved mic processing after connecting
    try {
      const settings = JSON.parse(localStorage.getItem('mvt_mic_proc') || '{}');
      if (settings && (settings.gain || settings.noiseGate || settings.sensitivity)) {
        this.applyMicProcessing(settings);
      }
    } catch {}
    // If mic denied or no track, tell UI.
    const hasMic = !!(this.localStream && this.localStream.getAudioTracks().length);
    if (!hasMic) this.onMicUnavailable?.();
  }

  // ---- screen share ----
  async startShare(sourceId) {
    if (this.shareStream) return this.shareStream;
    try {
      const quality = JSON.parse(localStorage.getItem('mvt_share_quality') || '"1080p60"');
      const preset = {
        '1080p60': { width: 1920, height: 1080, frameRate: 60 },
        '1080p30': { width: 1920, height: 1080, frameRate: 30 },
        '720p60': { width: 1280, height: 720, frameRate: 60 },
        '720p30': { width: 1280, height: 720, frameRate: 30 },
        '480p30': { width: 854, height: 480, frameRate: 30 },
        '360p30': { width: 640, height: 360, frameRate: 30 },
      };
      const p = preset[quality] || preset['1080p60'];
      const ideal = { width: { ideal: p.width }, height: { ideal: p.height }, frameRate: { ideal: p.frameRate } };

      let stream;
      if (sourceId) {
        // custom picker: grab the chosen desktop source directly in Electron
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId,
              maxWidth: p.width,
              maxHeight: p.height,
              maxFrameRate: p.frameRate,
            },
          },
        });
      } else {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: ideal, audio: false });
      }
      this.shareStream = stream;
      // stop sharing if user closes the system dialog
      stream.getVideoTracks()[0]?.addEventListener('ended', () => this.stopShare());
      // add the video sender to every connected peer; onnegotiationneeded
      // will automatically renegotiate (send offer) for each
      for (const [uid, pc] of this.peers) {
        if (!pc.getSenders().find((s) => s.track && s.track.kind === 'video')) {
          pc.addTrack(stream.getVideoTracks()[0], stream);
        }
      }
      this.onShareChanged?.(true);
      return stream;
    } catch (e) {
      console.warn('[share] failed:', e);
      return null;
    }
  }

  async stopShare() {
    if (!this.shareStream) return;
    const tracks = this.shareStream.getTracks();
    tracks.forEach((t) => { try { t.stop(); } catch {} });
    // remove video senders from peers; onnegotiationneeded renegotiates
    for (const [uid, pc] of this.peers) {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) {
        try { pc.removeTrack(sender); } catch {}
      }
    }
    this.shareStream = null;
    this.onShareChanged?.(false);
  }

  leaveVoice() {
    if (this.voiceChannelId) this.send('voice:leave', { channelId: this.voiceChannelId });
    this.voiceChannelId = null;
    // stop mic processing chain
    if (this.micProc) {
      if (this._micGateLoop) clearInterval(this._micGateLoop);
      try { this.micProc.ctx.close(); } catch {}
      this.micProc = null;
    }
    // drop all peers
    for (const [uid, pc] of this.peers) { try { pc.close(); } catch {} }
    this.peers.clear();
    if (this.shareStream) {
      this.shareStream.getTracks().forEach((t) => t.stop());
      this.shareStream = null;
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
  }

  // Called when a peer joins -> we initiate the call.
  async connectNewPeer(userId) {
    const pc = new RTCPeerConnection(this._iceConfig());
    this.peers.set(userId, pc);
    if (this.localStream) this.localStream.getAudioTracks().forEach((t) => pc.addTrack(t, this.localStream));
    if (this.shareStream) this.shareStream.getVideoTracks().forEach((t) => pc.addTrack(t, this.shareStream));

    // attach handlers; addTrack already fired negotiationneeded,
    // which will create and send the offer automatically.
    this._wirePeer(pc, userId);
  }

  // attach handlers + automatic renegotiation to a peer connection
  _wirePeer(pc, userId) {
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.send('rtc:ice', { to: userId, candidate: e.candidate, channelId: this.voiceChannelId });
      }
    };
    pc.ontrack = (e) => {
      console.warn('[rtc] ontrack kind=', e.track && e.track.kind, 'user=', userId);
      if (e.track && e.track.kind === 'video') {
        this.onRemoteScreen?.(userId, e.streams[0]);
        // when the remote screen track ends (streamer stopped sharing), remove it
        e.track.onended = () => this.onRemoteScreenEnded?.(userId);
      } else {
        this.onRemoteTrack?.(userId, e.streams[0]);
      }
    };
    // automatic renegotiation when tracks are added/removed
    pc.onnegotiationneeded = async () => {
      try {
        if (pc.signalingState !== 'stable') return; // an offer is already in flight
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.send('rtc:offer', { to: userId, sdp: offer, channelId: this.voiceChannelId });
      } catch (e) {
        console.warn('[rtc] negotiationneeded failed', e);
      }
    };
  }

  // Peer initiated -> we answer.
  async handleOffer(from, sdp) {
    const pc = this.peers.get(from) || this._makePeer(from);
    await pc.setRemoteDescription(sdp);
    // add tracks only if we don't already have a sender of that kind (fixes
    // duplicate senders during renegotiation)
    if (this.localStream && !pc.getSenders().find((s) => s.track && s.track.kind === 'audio')) {
      this.localStream.getAudioTracks().forEach((t) => pc.addTrack(t, this.localStream));
    }
    if (this.shareStream && !pc.getSenders().find((s) => s.track && s.track.kind === 'video')) {
      this.shareStream.getVideoTracks().forEach((t) => pc.addTrack(t, this.shareStream));
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.send('rtc:answer', { to: from, sdp: answer, channelId: this.voiceChannelId });
  }

  async handleAnswer(from, sdp) {
    const pc = this.peers.get(from);
    if (pc) await pc.setRemoteDescription(sdp);
  }

  async handleIce(from, candidate) {
    const pc = this.peers.get(from) || this._makePeer(from);
    try { await pc.addIceCandidate(candidate); } catch {}
  }

  // STUN servers for WebRTC; host candidates help LAN peers find each other.
  _iceConfig() {
    return {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    };
  }

  _makePeer(userId) {
    const pc = new RTCPeerConnection(this._iceConfig());
    this.peers.set(userId, pc);
    this._wirePeer(pc, userId);
    return pc;
  }

  removePeer(userId) {
    const pc = this.peers.get(userId);
    if (pc) { try { pc.close(); } catch {} this.peers.delete(userId); }
  }
}