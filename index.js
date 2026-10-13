'use strict';

/**
 * Servidor do Janta.
 *
 * Faz duas coisas:
 *  1) Guarda servidores (guilds), canais e mensagens em memória.
 *  2) Repassa a sinalização WebRTC entre as pessoas (offer/answer/ICE) para as
 *     chamadas de voz/vídeo/tela. O áudio e o vídeo NÃO passam pelo servidor —
 *     vão direto de pessoa para pessoa (P2P). O servidor só apresenta um ao
 *     outro. Por isso ele roda tranquilo num plano grátis.
 *
 * Estado em memória: ao reiniciar (ou o plano grátis "dormir"), os servidores
 * criados se perdem. Para amigos é suficiente; veja o guia para persistência.
 */

const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3001;
const MAX_HISTORY = 100; // mensagens guardadas por canal
const MAX_TEXT = 4000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // ~3MB em base64 cabe aqui
const MAX_CHANNELS = 50;

// ---- Estado ----------------------------------------------------------------
/** code -> guild */
const guilds = new Map();
/** socketId -> { id, nick, code, voiceChannel, media } */
const members = new Map();

function makeCode() {
  // Código de convite curto e fácil de digitar (ex.: "JANTA-7KQ2X").
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += alphabet[(Math.random() * alphabet.length) | 0];
  return 'JANTA-' + s;
}

function makeId(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 10);
}

/** Nome de canal: texto vira "minusculo-com-hifen"; voz mantém o texto. */
function cleanChannelName(name, type) {
  let n = (name || '').toString().trim().slice(0, 32);
  if (type === 'text') {
    n = n
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9à-ú_-]/gi, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }
  return n;
}

function emptyMedia() {
  return { muted: false, cam: false, sharing: false, micStreamId: null, camStreamId: null, screenStreamId: null, screenHasAudio: false };
}

function cleanMedia(media) {
  const id = (v) => (typeof v === 'string' && v.length > 0 && v.length <= 100 ? v : null);
  return {
    muted: !!media.muted,
    cam: !!media.cam,
    sharing: !!media.sharing,
    micStreamId: id(media.micStreamId),
    camStreamId: id(media.camStreamId),
    screenStreamId: id(media.screenStreamId),
    screenHasAudio: !!media.screenHasAudio,
  };
}

function createGuild(name) {
  let code = makeCode();
  while (guilds.has(code)) code = makeCode();
  const guild = {
    id: makeId('g'),
    code,
    name: (name || 'Servidor').toString().slice(0, 60),
    channels: [
      { id: makeId('c'), name: 'geral', type: 'text' },
      { id: makeId('c'), name: 'bate-papo', type: 'text' },
      { id: makeId('v'), name: 'Sala de voz', type: 'voice' },
    ],
    messages: {}, // channelId -> [msg]
    voice: {}, // channelId -> Set(socketId)
  };
  guilds.set(code, guild);
  return guild;
}

function publicGuild(guild) {
  return { id: guild.id, code: guild.code, name: guild.name, channels: guild.channels };
}

function guildMembers(code) {
  const list = [];
  for (const m of members.values()) if (m.code === code) list.push({ id: m.id, nick: m.nick });
  return list;
}

function voiceRoster(guild, channelId) {
  const set = guild.voice[channelId];
  if (!set) return [];
  const peers = [];
  for (const sid of set) {
    const m = members.get(sid);
    if (m) peers.push({ id: m.id, nick: m.nick, media: m.media });
  }
  return peers;
}

/** Quem está em cada canal de voz (para mostrar na lista de canais). */
function voiceState(guild) {
  const out = {};
  for (const c of guild.channels) {
    if (c.type === 'voice') out[c.id] = voiceRoster(guild, c.id);
  }
  return out;
}

// ---- HTTP + Socket.IO ------------------------------------------------------
const httpServer = http.createServer((req, res) => {
  // Página simples para quem abrir o endereço no navegador / health check.
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Janta server online. Servidores ativos: ' + guilds.size);
});

const io = new Server(httpServer, {
  // O app abre via file:// (origem "null"), então liberamos a origem.
  cors: { origin: true, methods: ['GET', 'POST'] },
  maxHttpBufferSize: 6 * 1024 * 1024, // caber imagem em base64
});

function emitVoiceState(guild) {
  io.to(guild.code).emit('voice:state', voiceState(guild));
}

io.on('connection', (socket) => {
  socket.emit('init', { id: socket.id });

  const reply = (ack, payload) => {
    if (typeof ack === 'function') ack(payload);
  };

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
      socket.to(me.code).emit('voice:peer-left', { channelId: ch, id: me.id });
      emitVoiceState(guild);
    }
  }

  function enterGuild(guild, nick) {
    const m = {
      id: socket.id,
      nick: (nick || 'Visitante').toString().trim().slice(0, 32) || 'Visitante',
      code: guild.code,
      voiceChannel: null,
      media: emptyMedia(),
    };
    members.set(socket.id, m);
    socket.join(guild.code);
    return m;
  }

  socket.on('guild:create', ({ name, nick } = {}, ack) => {
    try {
      const guild = createGuild(name);
      const m = enterGuild(guild, nick);
      reply(ack, { ok: true, guild: publicGuild(guild), selfId: m.id, history: {}, voiceState: voiceState(guild) });
      io.to(guild.code).emit('members', guildMembers(guild.code));
    } catch (e) {
      reply(ack, { ok: false, error: 'Falha ao criar o servidor.' });
    }
  });

  socket.on('guild:join', ({ code, nick } = {}, ack) => {
    const guild = code ? guilds.get(code.toString().trim().toUpperCase()) : null;
    if (!guild) {
      reply(ack, { ok: false, error: 'Código inválido ou servidor não encontrado.' });
      return;
    }
    const m = enterGuild(guild, nick);
    reply(ack, { ok: true, guild: publicGuild(guild), selfId: m.id, history: guild.messages, voiceState: voiceState(guild) });
    io.to(guild.code).emit('members', guildMembers(guild.code));
  });

  // ---- Canais --------------------------------------------------------------
  socket.on('channel:create', ({ name, type } = {}, ack) => {
    const [me, guild] = myGuild();
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
    // Quem estava nesse canal de voz é desconectado da chamada.
    if (channel.type === 'voice' && guild.voice[channelId]) {
      for (const sid of guild.voice[channelId]) {
        const m = members.get(sid);
        if (m) {
          m.voiceChannel = null;
          m.media = emptyMedia();
          io.to(sid).emit('voice:force-leave', { channelId });
          io.to(guild.code).emit('voice:peer-left', { channelId, id: m.id });
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

  // ---- Mensagens -----------------------------------------------------------
  socket.on('message:send', ({ channelId, text, image } = {}) => {
    const [me, guild] = myGuild();
    if (!guild) return;
    const channel = guild.channels.find((c) => c.id === channelId && c.type === 'text');
    if (!channel) return;

    const cleanText = (text || '').toString().slice(0, MAX_TEXT);
    let img = null;
    if (image && typeof image === 'string' && image.startsWith('data:')) {
      if (image.length <= MAX_IMAGE_BYTES * 1.4) img = image; // base64 ~1.37x
    }
    if (!cleanText && !img) return;

    const msg = {
      id: makeId('m'),
      channelId,
      from: me.nick,
      fromId: me.id,
      text: cleanText,
      image: img,
      ts: Date.now(),
    };
    const arr = guild.messages[channelId] || (guild.messages[channelId] = []);
    arr.push(msg);
    if (arr.length > MAX_HISTORY) arr.splice(0, arr.length - MAX_HISTORY);

    io.to(me.code).emit('message:new', msg);
  });

  // ---- Voz / WebRTC mesh ---------------------------------------------------
  socket.on('voice:join', ({ channelId } = {}) => {
    const [me, guild] = myGuild();
    if (!guild) return;
    const channel = guild.channels.find((c) => c.id === channelId && c.type === 'voice');
    if (!channel) return;

    leaveVoice();
    me.voiceChannel = channelId;
    const set = guild.voice[channelId] || (guild.voice[channelId] = new Set());

    // Envia ao recém-chegado a lista de quem já está.
    socket.emit('voice:roster', { channelId, peers: voiceRoster(guild, channelId) });

    // Avisa os presentes que alguém novo chegou.
    socket.to(me.code).emit('voice:peer-joined', {
      channelId,
      peer: { id: me.id, nick: me.nick, media: me.media },
    });

    set.add(socket.id);
    emitVoiceState(guild);
  });

  socket.on('voice:leave', () => leaveVoice());

  // Repasse de sinalização (offer/answer/ICE) para um alvo específico.
  socket.on('signal', ({ to, data } = {}) => {
    const me = members.get(socket.id);
    if (!me || !to) return;
    const target = members.get(to);
    if (!target || target.code !== me.code) return; // só dentro do mesmo servidor
    io.to(to).emit('signal', { from: me.id, data });
  });

  // Estado de mídia (mute/câmera/transmitindo + ids das faixas) para os outros.
  socket.on('voice:media', (media = {}) => {
    const [me, guild] = myGuild();
    if (!guild) return;
    me.media = cleanMedia(media);
    socket.to(me.code).emit('voice:peer-media', { id: me.id, media: me.media });
    emitVoiceState(guild);
  });

  socket.on('disconnect', () => {
    const me = members.get(socket.id);
    if (!me) return;
    leaveVoice();
    members.delete(socket.id);
    io.to(me.code).emit('members', guildMembers(me.code));

    // Limpa guild vazia depois de um tempo (evita vazamento de memória).
    const code = me.code;
    setTimeout(() => {
      if (guildMembers(code).length === 0) guilds.delete(code);
    }, 60 * 1000);
  });
});

httpServer.listen(PORT, () => {
  console.log('Janta server ouvindo na porta ' + PORT);
});
