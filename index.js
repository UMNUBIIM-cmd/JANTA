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

// ---- Estado ----------------------------------------------------------------
/** code -> guild */
const guilds = new Map();
/** socketId -> { id, nick, code, voiceChannel, media } */
const members = new Map();

function makeCode() {
  // Código de convite curto e fácil de digitar (ex.: "JANTA-7KQ2").
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += alphabet[(Math.random() * alphabet.length) | 0];
  return 'JANTA-' + s;
}

function makeId(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 10);
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

io.on('connection', (socket) => {
  socket.emit('init', { id: socket.id });

  function leaveVoice() {
    const me = members.get(socket.id);
    if (!me || !me.voiceChannel) return;
    const guild = guilds.get(me.code);
    const ch = me.voiceChannel;
    me.voiceChannel = null;
    if (guild && guild.voice[ch]) {
      guild.voice[ch].delete(socket.id);
      socket.to(me.code).emit('voice:peer-left', { channelId: ch, id: me.id });
    }
  }

  socket.on('guild:create', ({ name, nick } = {}, ack) => {
    try {
      const guild = createGuild(name);
      const m = {
        id: socket.id,
        nick: (nick || 'Visitante').toString().slice(0, 32),
        code: guild.code,
        voiceChannel: null,
        media: { muted: false, cam: false, sharing: false },
      };
      members.set(socket.id, m);
      socket.join(guild.code);
      if (typeof ack === 'function') {
        ack({ ok: true, guild: publicGuild(guild), selfId: m.id, history: {} });
      }
      io.to(guild.code).emit('members', guildMembers(guild.code));
    } catch (e) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Falha ao criar o servidor.' });
    }
  });

  socket.on('guild:join', ({ code, nick } = {}, ack) => {
    const guild = code ? guilds.get(code.toString().trim().toUpperCase()) : null;
    if (!guild) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Código inválido ou servidor não encontrado.' });
      return;
    }
    const m = {
      id: socket.id,
      nick: (nick || 'Visitante').toString().slice(0, 32),
      code: guild.code,
      voiceChannel: null,
      media: { muted: false, cam: false, sharing: false },
    };
    members.set(socket.id, m);
    socket.join(guild.code);
    if (typeof ack === 'function') {
      ack({ ok: true, guild: publicGuild(guild), selfId: m.id, history: guild.messages });
    }
    io.to(guild.code).emit('members', guildMembers(guild.code));
  });

  socket.on('message:send', ({ channelId, text, image } = {}) => {
    const me = members.get(socket.id);
    if (!me) return;
    const guild = guilds.get(me.code);
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
    const me = members.get(socket.id);
    if (!me) return;
    const guild = guilds.get(me.code);
    if (!guild) return;
    const channel = guild.channels.find((c) => c.id === channelId && c.type === 'voice');
    if (!channel) return;

    leaveVoice();
    me.voiceChannel = channelId;
    const set = guild.voice[channelId] || (guild.voice[channelId] = new Set());

    // Envia ao recém-chegado a lista de quem já está (ele inicia as conexões).
    socket.emit('voice:roster', { channelId, peers: voiceRoster(guild, channelId) });

    // Avisa os presentes que alguém novo chegou (eles esperam a oferta).
    socket.to(me.code).emit('voice:peer-joined', {
      channelId,
      peer: { id: me.id, nick: me.nick, media: me.media },
    });

    set.add(socket.id);
  });

  socket.on('voice:leave', () => leaveVoice());

  // Repasse de sinalização (offer/answer/ICE) para um alvo específico.
  socket.on('signal', ({ to, data } = {}) => {
    const me = members.get(socket.id);
    if (!me || !to) return;
    io.to(to).emit('signal', { from: me.id, data });
  });

  // Estado de mídia (mute/câmera/transmitindo) para a UI dos outros.
  socket.on('voice:media', (media = {}) => {
    const me = members.get(socket.id);
    if (!me) return;
    me.media = {
      muted: !!media.muted,
      cam: !!media.cam,
      sharing: !!media.sharing,
    };
    socket.to(me.code).emit('voice:peer-media', { id: me.id, media: me.media });
  });

  socket.on('disconnect', () => {
    const me = members.get(socket.id);
    if (!me) return;
    leaveVoice();
    members.delete(socket.id);
    io.to(me.code).emit('members', guildMembers(me.code));
    socket.to(me.code).emit('voice:peer-left', { id: me.id });

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
