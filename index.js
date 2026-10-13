'use strict';

/**
 * Servidor do Concorde.
 *
 *  1) Guarda servidores (guilds), canais, mensagens e o cadastro de membros
 *     (quem já entrou), em memória.
 *  2) Repassa a sinalização WebRTC (offer/answer/ICE) entre as pessoas. Áudio e
 *     vídeo NÃO passam pelo servidor — vão direto de pessoa para pessoa (P2P).
 *  3) Sincroniza o mini player (tocar junto) e repassa o ping.
 *
 * Estado em memória: ao reiniciar (ou o plano grátis "dormir"), tudo se perde.
 */

const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3001;
const MAX_HISTORY = 100;
const MAX_TEXT = 4000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_AVATAR = 400 * 1024; // avatar/ícone em dataURL (~300KB de imagem)
const MAX_CHANNELS = 50;

// code -> guild
const guilds = new Map();
// socketId -> { socketId, userId, nick, code, voiceChannel, media }
const members = new Map();

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += alphabet[(Math.random() * alphabet.length) | 0];
  return 'CORDE-' + s;
}
function makeId(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 10);
}
function cleanNick(n) {
  return (n || 'Visitante').toString().trim().slice(0, 32) || 'Visitante';
}
function cleanUserId(u) {
  return typeof u === 'string' && /^[A-Za-z0-9_]{6,80}$/.test(u) ? u : null;
}
function cleanImage(v, max) {
  return typeof v === 'string' && v.startsWith('data:image/') && v.length <= max ? v : null;
}
function cleanChannelName(name, type) {
  let n = (name || '').toString().trim().slice(0, 32);
  if (type === 'text') {
    n = n.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9à-ú_-]/gi, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  }
  return n;
}
function emptyMedia() {
  return { muted: false, cam: false, sharing: false, micStreamId: null, camStreamId: null, screenStreamId: null, screenHasAudio: false };
}
function cleanMedia(media) {
  const id = (v) => (typeof v === 'string' && v.length > 0 && v.length <= 100 ? v : null);
  return {
    muted: !!media.muted, cam: !!media.cam, sharing: !!media.sharing,
    micStreamId: id(media.micStreamId), camStreamId: id(media.camStreamId),
    screenStreamId: id(media.screenStreamId), screenHasAudio: !!media.screenHasAudio,
  };
}

function createGuild(name) {
  let code = makeCode();
  while (guilds.has(code)) code = makeCode();
  const guild = {
    id: makeId('g'), code,
    name: (name || 'Servidor').toString().slice(0, 60),
    icon: null,
    channels: [
      { id: makeId('c'), name: 'geral', type: 'text' },
      { id: makeId('c'), name: 'bate-papo', type: 'text' },
      { id: makeId('v'), name: 'Sala de voz', type: 'voice' },
    ],
    messages: {},
    voice: {},
    roster: new Map(), // userId -> { userId, nick, avatar }
    player: null, // { videoId, title, playing, time, at }
  };
  guilds.set(code, guild);
  return guild;
}

function publicGuild(guild) {
  return { id: guild.id, code: guild.code, name: guild.name, icon: guild.icon, channels: guild.channels };
}

/** Quem está online agora, por userId. */
function onlineUserIds(code) {
  const set = new Set();
  for (const m of members.values()) if (m.code === code) set.add(m.userId);
  return set;
}

/** Lista de membros: cadastro completo (online + offline) com avatar. */
function guildMembers(guild) {
  const online = onlineUserIds(guild.code);
  const list = [];
  for (const r of guild.roster.values()) {
    list.push({ userId: r.userId, nick: r.nick, avatar: r.avatar || null, online: online.has(r.userId) });
  }
  // online primeiro, depois alfabético
  list.sort((a, b) => (a.online === b.online ? a.nick.localeCompare(b.nick) : a.online ? -1 : 1));
  return list;
}

function voiceRoster(guild, channelId) {
  const set = guild.voice[channelId];
  if (!set) return [];
  const peers = [];
  for (const sid of set) {
    const m = members.get(sid);
    if (m) {
      const r = guild.roster.get(m.userId) || {};
      peers.push({ id: m.socketId, userId: m.userId, nick: m.nick, avatar: r.avatar || null, media: m.media });
    }
  }
  return peers;
}
function voiceState(guild) {
  const out = {};
  for (const c of guild.channels) if (c.type === 'voice') out[c.id] = voiceRoster(guild, c.id);
  return out;
}

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Concorde server online. Servidores ativos: ' + guilds.size);
});

const io = new Server(httpServer, {
  cors: { origin: true, methods: ['GET', 'POST'] },
  maxHttpBufferSize: 6 * 1024 * 1024,
});

function emitVoiceState(guild) { io.to(guild.code).emit('voice:state', voiceState(guild)); }
function emitMembers(guild) { io.to(guild.code).emit('members', guildMembers(guild)); }

io.on('connection', (socket) => {
  socket.emit('init', { id: socket.id });
  const reply = (ack, payload) => { if (typeof ack === 'function') ack(payload); };

  function myGuild() {
    const me = members.get(socket.id);
    if (!me) return [null, null];
    return [me, guilds.get(me.code) || null];
  }

  function leaveVoice() {
    const [me, guild] = myGuild();
    if (!me || !me.voiceChannel) return;
    const ch = me.voiceChannel;
    me.voiceChannel = null;
    me.media = emptyMedia();
    if (guild && guild.voice[ch]) {
      guild.voice[ch].delete(socket.id);
      socket.to(me.code).emit('voice:peer-left', { channelId: ch, id: me.socketId });
      emitVoiceState(guild);
    }
  }

  function enterGuild(guild, userId, nick, avatar) {
    const r = { userId, nick, avatar: avatar || (guild.roster.get(userId) || {}).avatar || null };
    guild.roster.set(userId, r);
    const m = { socketId: socket.id, userId, nick, code: guild.code, voiceChannel: null, media: emptyMedia() };
    members.set(socket.id, m);
    socket.join(guild.code);
    return m;
  }

  function joinResponse(guild, m) {
    return {
      ok: true, guild: publicGuild(guild), selfId: m.socketId,
      history: guild.messages, voiceState: voiceState(guild),
      members: guildMembers(guild), player: guild.player,
    };
  }

  socket.on('guild:create', ({ name, nick, userId, avatar } = {}, ack) => {
    const uid = cleanUserId(userId);
    if (!uid) return reply(ack, { ok: false, error: 'Identidade inválida.' });
    try {
      const guild = createGuild(name);
      const m = enterGuild(guild, uid, cleanNick(nick), cleanImage(avatar, MAX_AVATAR));
      reply(ack, joinResponse(guild, m));
      emitMembers(guild);
    } catch (e) {
      reply(ack, { ok: false, error: 'Falha ao criar o servidor.' });
    }
  });

  socket.on('guild:join', ({ code, nick, userId, avatar } = {}, ack) => {
    const uid = cleanUserId(userId);
    if (!uid) return reply(ack, { ok: false, error: 'Identidade inválida.' });
    const guild = code ? guilds.get(code.toString().trim().toUpperCase()) : null;
    if (!guild) return reply(ack, { ok: false, error: 'Código inválido ou servidor não encontrado.' });
    const m = enterGuild(guild, uid, cleanNick(nick), cleanImage(avatar, MAX_AVATAR));
    reply(ack, joinResponse(guild, m));
    emitMembers(guild);
  });

  // ---- Perfil (apelido + foto) ----
  socket.on('profile:update', ({ nick, avatar } = {}, ack) => {
    const [me, guild] = myGuild();
    if (!guild) return reply(ack, { ok: false, error: 'Você não está em um servidor.' });
    const r = guild.roster.get(me.userId) || { userId: me.userId };
    if (nick != null) { r.nick = cleanNick(nick); me.nick = r.nick; }
    if (avatar !== undefined) r.avatar = cleanImage(avatar, MAX_AVATAR); // null limpa
    guild.roster.set(me.userId, r);
    // Atualiza o apelido/foto em todos os outros servidores abertos pelo mesmo userId.
    for (const g of guilds.values()) {
      if (g === guild) continue;
      const rr = g.roster.get(me.userId);
      if (rr) { if (nick != null) rr.nick = r.nick; if (avatar !== undefined) rr.avatar = r.avatar; emitMembers(g); emitVoiceState(g); }
    }
    emitMembers(guild);
    emitVoiceState(guild);
    reply(ack, { ok: true, nick: r.nick, avatar: r.avatar || null });
  });

  // ---- Identidade do servidor (nome + ícone) ----
  socket.on('guild:update', ({ name, icon } = {}, ack) => {
    const [, guild] = myGuild();
    if (!guild) return reply(ack, { ok: false, error: 'Você não está em um servidor.' });
    if (name != null) { const n = (name || '').toString().trim().slice(0, 60); if (n) guild.name = n; }
    if (icon !== undefined) guild.icon = cleanImage(icon, MAX_AVATAR);
    io.to(guild.code).emit('guild:info', { code: guild.code, name: guild.name, icon: guild.icon });
    reply(ack, { ok: true, name: guild.name, icon: guild.icon });
  });

  // ---- Canais ----
  socket.on('channel:create', ({ name, type } = {}, ack) => {
    const [, guild] = myGuild();
    if (!guild) return reply(ack, { ok: false, error: 'Você não está em um servidor.' });
    if (type !== 'text' && type !== 'voice') return reply(ack, { ok: false, error: 'Tipo de canal inválido.' });
    if (guild.channels.length >= MAX_CHANNELS) return reply(ack, { ok: false, error: 'Limite de canais atingido.' });
    const clean = cleanChannelName(name, type);
    if (!clean) return reply(ack, { ok: false, error: 'Dê um nome ao canal.' });
    const channel = { id: makeId(type === 'text' ? 'c' : 'v'), name: clean, type };
    guild.channels.push(channel);
    io.to(guild.code).emit('channels', guild.channels);
    emitVoiceState(guild);
    reply(ack, { ok: true, channel });
  });

  socket.on('channel:rename', ({ channelId, name } = {}, ack) => {
    const [, guild] = myGuild();
    if (!guild) return reply(ack, { ok: false, error: 'Você não está em um servidor.' });
    const channel = guild.channels.find((c) => c.id === channelId);
    if (!channel) return reply(ack, { ok: false, error: 'Canal não encontrado.' });
    const clean = cleanChannelName(name, channel.type);
    if (!clean) return reply(ack, { ok: false, error: 'Dê um nome ao canal.' });
    channel.name = clean;
    io.to(guild.code).emit('channels', guild.channels);
    reply(ack, { ok: true, channel });
  });

  socket.on('channel:delete', ({ channelId } = {}, ack) => {
    const [, guild] = myGuild();
    if (!guild) return reply(ack, { ok: false, error: 'Você não está em um servidor.' });
    const channel = guild.channels.find((c) => c.id === channelId);
    if (!channel) return reply(ack, { ok: false, error: 'Canal não encontrado.' });
    if (channel.type === 'text' && guild.channels.filter((c) => c.type === 'text').length <= 1) {
      return reply(ack, { ok: false, error: 'O servidor precisa de pelo menos um canal de texto.' });
    }
    if (channel.type === 'voice' && guild.voice[channelId]) {
      for (const sid of guild.voice[channelId]) {
        const m = members.get(sid);
        if (m) {
          m.voiceChannel = null; m.media = emptyMedia();
          io.to(sid).emit('voice:force-leave', { channelId });
          io.to(guild.code).emit('voice:peer-left', { channelId, id: sid });
        }
      }
      delete guild.voice[channelId];
    }
    guild.channels = guild.channels.filter((c) => c.id !== channelId);
    delete guild.messages[channelId];
    io.to(guild.code).emit('channels', guild.channels);
    emitVoiceState(guild);
    reply(ack, { ok: true });
  });

  // ---- Mensagens (texto, imagem/vídeo em dataURL, ou GIF por URL) ----
  socket.on('message:send', ({ channelId, text, image, gif } = {}) => {
    const [me, guild] = myGuild();
    if (!guild) return;
    const channel = guild.channels.find((c) => c.id === channelId && c.type === 'text');
    if (!channel) return;
    const cleanText = (text || '').toString().slice(0, MAX_TEXT);
    let img = null;
    if (image && typeof image === 'string' && image.startsWith('data:') && image.length <= MAX_IMAGE_BYTES * 1.4) img = image;
    let g = null;
    if (gif && typeof gif === 'string' && /^https:\/\/[^\s]{1,400}$/.test(gif)) g = gif;
    if (!cleanText && !img && !g) return;
    const r = guild.roster.get(me.userId) || {};
    const msg = {
      id: makeId('m'), channelId, from: me.nick, fromId: me.userId,
      avatar: r.avatar || null, text: cleanText, image: img, gif: g, ts: Date.now(),
    };
    const arr = guild.messages[channelId] || (guild.messages[channelId] = []);
    arr.push(msg);
    if (arr.length > MAX_HISTORY) arr.splice(0, arr.length - MAX_HISTORY);
    io.to(me.code).emit('message:new', msg);
  });

  // ---- Voz / WebRTC mesh ----
  socket.on('voice:join', ({ channelId } = {}) => {
    const [me, guild] = myGuild();
    if (!guild) return;
    const channel = guild.channels.find((c) => c.id === channelId && c.type === 'voice');
    if (!channel) return;
    leaveVoice();
    me.voiceChannel = channelId;
    const set = guild.voice[channelId] || (guild.voice[channelId] = new Set());
    socket.emit('voice:roster', { channelId, peers: voiceRoster(guild, channelId) });
    const r = guild.roster.get(me.userId) || {};
    socket.to(me.code).emit('voice:peer-joined', {
      channelId, peer: { id: me.socketId, userId: me.userId, nick: me.nick, avatar: r.avatar || null, media: me.media },
    });
    set.add(socket.id);
    emitVoiceState(guild);
  });

  socket.on('voice:leave', () => leaveVoice());

  socket.on('signal', ({ to, data } = {}) => {
    const me = members.get(socket.id);
    if (!me || !to) return;
    const target = members.get(to);
    if (!target || target.code !== me.code) return;
    io.to(to).emit('signal', { from: me.socketId, data });
  });

  socket.on('voice:media', (media = {}) => {
    const [me, guild] = myGuild();
    if (!guild) return;
    me.media = cleanMedia(media);
    socket.to(me.code).emit('voice:peer-media', { id: me.socketId, media: me.media });
    emitVoiceState(guild);
  });

  // ---- Mini player (tocar junto) ----
  socket.on('player:set', ({ videoId, title } = {}) => {
    const [, guild] = myGuild();
    if (!guild) return;
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || '')) return;
    guild.player = { videoId, title: (title || '').toString().slice(0, 120), playing: true, time: 0, at: Date.now() };
    io.to(guild.code).emit('player:state', guild.player);
  });
  socket.on('player:control', ({ action, time } = {}) => {
    const [, guild] = myGuild();
    if (!guild || !guild.player) return;
    const p = guild.player;
    if (action === 'play') { p.playing = true; p.at = Date.now(); if (typeof time === 'number') p.time = time; }
    else if (action === 'pause') { if (p.playing) p.time = p.time + (Date.now() - p.at) / 1000; p.playing = false; }
    else if (action === 'seek') { p.time = Math.max(0, +time || 0); p.at = Date.now(); }
    else if (action === 'stop') { guild.player = null; }
    else return;
    io.to(guild.code).emit('player:state', guild.player);
  });

  // ---- Ping (latência) ----
  socket.on('net:ping', (t, ack) => { if (typeof ack === 'function') ack(t); });

  socket.on('disconnect', () => {
    const me = members.get(socket.id);
    if (!me) return;
    const code = me.code;
    const guild = guilds.get(code);
    leaveVoice();
    members.delete(socket.id);
    if (guild) emitMembers(guild);
    setTimeout(() => {
      const g = guilds.get(code);
      if (g && onlineUserIds(code).size === 0) guilds.delete(code);
    }, 5 * 60 * 1000);
  });
});

httpServer.listen(PORT, () => console.log('Concorde server ouvindo na porta ' + PORT));
