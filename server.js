const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint - responds immediately for wake-up calls
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function broadcast(roomCode, message, excludeWs = null) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const data = JSON.stringify(message);
  console.log(`[BCAST] Broadcasting ${message.type} to room ${roomCode}`);
  room.players.forEach(player => {
    if (player.ws !== excludeWs && player.ws.readyState === 1) {
      console.log(`[BCAST] Sending to ${player.name}`);
      player.ws.send(data);
    } else {
      console.log(`[BCAST] Skipping ${player.name} (ws: ${player.ws?.readyState}, exclude: ${player.ws === excludeWs})`);
    }
  });
}

function send(player, message) {
  if (player.ws.readyState === 1) {
    console.log(`[SEND] Sending ${message.type} to ${player.name}`);
    player.ws.send(JSON.stringify(message));
    console.log(`[SEND] ${message.type} sent successfully`);
  } else {
    console.log(`[SEND] FAILED - ws not ready (state: ${player.ws.readyState}) for ${message.type}`);
  }
}

// Heartbeat to keep connections alive on Render (and other platforms with idle timeouts)
// Render free tier has ~55-60s idle timeout, so use 45s interval
const HEARTBEAT_INTERVAL = 45000; // 45 seconds

function startHeartbeat(ws) {
  // Start heartbeat IMMEDIATELY to keep proxy happy (every 10s instead of 45s)
  const interval = setInterval(() => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'ping' }));
      console.log(`[HEARTBEAT] Sent ping`);
    } else {
      clearInterval(interval);
    }
  }, 10000); // 10 second interval for proxy keep-alive

  ws.on('close', () => clearInterval(interval));
  return interval;
}

function handleMessage(ws, message, player, roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const { type, ...data } = message;

  switch (type) {
    case 'join': {
      if (room.players.length >= 2) {
        send(player, { type: 'error', message: 'Room is full' });
        return;
      }
      player.name = data.name || `Player ${room.players.length + 1}`;
      player.id = room.players.length;

      send(player, {
        type: 'joined',
        playerId: player.id,
        name: player.name,
        isHost: player.id === 0
      });

      if (room.players.length === 2) {
        room.host = room.players[0];
        startGame(roomCode);
      }
      break;
    }

    case 'flip': {
      if (room.gameState.lock || room.gameState.currentTurn !== player.id) {
        return;
      }
      const card = room.gameState.cards[data.cardId];
      if (!card || card.state !== 'down') return;

      card.state = 'up';
      room.gameState.flippedCards.push({ cardId: data.cardId, playerId: player.id });

      broadcast(roomCode, {
        type: 'cardFlipped',
        cardId: data.cardId,
        playerId: player.id,
        symbol: card.symbol
      });

      if (room.gameState.flippedCards.length === 2) {
        room.gameState.lock = true;
        setTimeout(() => checkMatch(roomCode), 1000);
      }
      break;
    }

    case 'rematch': {
      if (player.id === 0) {
        startGame(roomCode);
      }
      break;
    }

    case 'leave': {
      handleLeave(roomCode, player);
      break;
    }
  }
}

function startGame(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || room.players.length < 2) return;

  const symbols = ['★', '♥', '♦', '♣', '♠', '●', '■', '▲', '◆', '○'];
  const pairCount = room.config.pairCount || 8;
  const selectedSymbols = symbols.slice(0, pairCount);

  const cards = [];
  selectedSymbols.forEach((symbol, index) => {
    cards.push({ id: cards.length, symbol, state: 'down', matched: false, matchedBy: null });
    cards.push({ id: cards.length, symbol, state: 'down', matched: false, matchedBy: null });
  });

  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }

  room.gameState = {
    cards,
    currentTurn: 0,
    scores: [0, 0],
    flippedCards: [],
    lock: false,
    pairsFound: 0,
    totalPairs: pairCount
  };

  // Create deck array with just symbol indices for client
  const deck = cards.map(c => symbols.indexOf(c.symbol));

  room.players.forEach((player, index) => {
    send(player, {
      type: 'gameStart',
      deck: deck,
      names: room.players.map(p => p.name),
      playerId: index
    });
  });
}

function checkMatch(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const [first, second] = room.gameState.flippedCards;
  const card1 = room.gameState.cards[first.cardId];
  const card2 = room.gameState.cards[second.cardId];

  let match = false;
  let nextTurn = room.gameState.currentTurn;

  if (card1.symbol === card2.symbol) {
    match = true;
    card1.state = 'matched';
    card2.state = 'matched';
    card1.matchedBy = room.gameState.currentTurn;
    card2.matchedBy = room.gameState.currentTurn;
    room.gameState.scores[room.gameState.currentTurn]++;
    room.gameState.pairsFound++;
    nextTurn = room.gameState.currentTurn;
  } else {
    card1.state = 'down';
    card2.state = 'down';
    nextTurn = 1 - room.gameState.currentTurn;
  }

  room.gameState.currentTurn = nextTurn;
  room.gameState.flippedCards = [];
  room.gameState.lock = false;

  broadcast(roomCode, {
    type: 'turnResult',
    match,
    firstCardId: first.cardId,
    secondCardId: second.cardId,
    symbol: card1.symbol,
    currentTurn: nextTurn,
    scores: room.gameState.scores,
    pairsFound: room.gameState.pairsFound
  });

  if (room.gameState.pairsFound === room.gameState.totalPairs) {
    const winner = room.gameState.scores[0] > room.gameState.scores[1] ? 0 :
                   room.gameState.scores[1] > room.gameState.scores[0] ? 1 : -1;
    broadcast(roomCode, {
      type: 'gameOver',
      winner,
      scores: room.gameState.scores,
      playerNames: room.players.map(p => p.name)
    });
  }
}

function handleLeave(roomCode, player) {
  const room = rooms.get(roomCode);
  if (!room) return;

  // Mark player as disconnected instead of removing them
  player.disconnected = true;
  player.ws = null;

  const otherPlayer = room.players.find(p => p !== player && !p.disconnected);
  if (otherPlayer) {
    send(otherPlayer, { type: 'opponentLeft' });
  }

  // Check if all players are disconnected - then clean up
  const activePlayers = room.players.filter(p => !p.disconnected);
  if (activePlayers.length === 0) {
    rooms.delete(roomCode);
  }
}

wss.on('error', (err) => {
  console.error('[WSS ERROR]', err);
});

wss.on('connection', (ws) => {
  let currentRoom = null;
  let currentPlayer = null;
  const connTime = Date.now();

  console.log('[CONN] New WebSocket connection');

  // Send immediate ack to establish bidirectional flow (helps with proxies)
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'connected', timestamp: Date.now() }));
  }

  // Start heartbeat to keep connection alive
  startHeartbeat(ws);

  ws.once('message', () => {
    console.log(`[TIMING] First message received after ${Date.now() - connTime}ms`);
  });

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log(`[MSG] Room: ${currentRoom}, Type: ${message.type}, Player: ${currentPlayer?.name || 'none'}, Data:`, JSON.stringify(message).slice(0, 200));
      console.log(`[MSG] About to process ${message.type}`);

      // Send immediate processing ack to keep proxy alive during processing
      if (message.type === 'createRoom' || message.type === 'joinRoom') {
        send(currentPlayer || { ws }, { type: 'processing', message: 'Processing request...' });
      }

      // Handle pong from client
      if (message.type === 'pong') {
        return;
      }

      function notifyJoined(room, code) {
    room.players.forEach((player, index) => {
      send(player, {
        type: 'joined',
        playerId: index,
        name: player.name || `Player ${index + 1}`,
        isHost: index === 0
      });
    });
    if (room.players.length === 2) {
      room.host = room.players[0];
      startGame(code);
    }
  }

  if (message.type === 'createRoom') {
    let code;
    do {
      code = generateRoomCode();
    } while (rooms.has(code));

    const pairCount = message.pairCount || 8;
    rooms.set(code, {
      code,
      config: { pairCount },
      players: [],
      host: null,
      gameState: null
    });

    currentRoom = code;
    currentPlayer = { ws, name: message.name || 'Player 1', id: 0 };
    rooms.get(code).players.push(currentPlayer);

    send(currentPlayer, { type: 'roomCreated', code, isHost: true });
    console.log(`[CREATE] roomCreated sent, calling notifyJoined`);
    notifyJoined(rooms.get(code), code);
    console.log(`[CREATE] notifyJoined done`);
  }
  else if (message.type === 'joinRoom') {
    const code = message.code.toUpperCase();
    const room = rooms.get(code);

    console.log(`[JOIN] Room ${code} exists:`, !!room, 'players:', room?.players?.length);
    if (!room) {
      send(ws, { type: 'error', message: 'Room not found' });
      return;
    }

    if (room.players.length >= 2) {
      send(ws, { type: 'error', message: 'Room is full' });
      return;
    }

    currentRoom = code;
    currentPlayer = { ws, name: message.name || 'Player 2', id: room.players.length };
    room.players.push(currentPlayer);

    console.log(`[JOIN] Sending roomJoined to player ${currentPlayer.id}`);
    send(currentPlayer, { type: 'roomJoined', code, isHost: false });
    console.log(`[JOIN] roomJoined sent, calling notifyJoined`);
    notifyJoined(room, code);
    console.log(`[JOIN] notifyJoined done`);
  }
  else if (message.type === 'rejoin') {
    const code = message.code.toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
      return;
    }

    // Find existing player by name
    let existingPlayer = room.players.find(p => p.name === message.name);
    if (existingPlayer) {
      // Replace the old websocket with the new one
      existingPlayer.ws = ws;
      currentRoom = code;
      currentPlayer = existingPlayer;

      // Send current game state
      if (room.gameState) {
        const deck = room.gameState.cards.map(c => ['★', '♥', '♦', '♣', '♠', '●', '■', '▲', '◆', '○'].indexOf(c.symbol));
        send(currentPlayer, {
          type: 'gameStart',
          deck: deck,
          names: room.players.map(p => p.name),
          playerId: existingPlayer.id
        });
        // Also send current turn and scores
        send(currentPlayer, {
          type: 'turnResult',
          match: false,
          firstCardId: -1,
          secondCardId: -1,
          symbol: '',
          currentTurn: room.gameState.currentTurn,
          scores: room.gameState.scores,
          pairsFound: room.gameState.pairsFound
        });
      } else {
        // Still in lobby
        send(currentPlayer, { type: 'roomJoined', code, isHost: existingPlayer.id === 0 });
        notifyJoined(room, code);
      }
    } else {
      ws.send(JSON.stringify({ type: 'error', message: 'Player not found in room' }));
    }
  }
      else if (currentRoom && currentPlayer) {
        handleMessage(ws, message, currentPlayer, currentRoom);
      }
    } catch (e) {
      console.error('Error handling message:', e);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`[CLOSE] Room: ${currentRoom}, Player: ${currentPlayer?.name}, Code: ${code}, Reason: ${reason?.toString() || 'none'}`);
    if (currentRoom && currentPlayer) {
      handleLeave(currentRoom, currentPlayer);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});