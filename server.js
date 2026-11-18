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
  room.players.forEach(player => {
    if (player.ws !== excludeWs && player.ws.readyState === 1) {
      player.ws.send(data);
    }
  });
}

function send(player, message) {
  if (player.ws.readyState === 1) {
    player.ws.send(JSON.stringify(message));
  }
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

  room.players.forEach((player, index) => {
    send(player, {
      type: 'gameStart',
      cards: cards.map(c => ({ id: c.id, symbol: c.symbol, state: c.state })),
      currentTurn: 0,
      scores: [0, 0],
      playerNames: room.players.map(p => p.name),
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

  const otherPlayer = room.players.find(p => p !== player);
  if (otherPlayer) {
    send(otherPlayer, { type: 'opponentLeft' });
  }

  rooms.delete(roomCode);
}

wss.on('connection', (ws) => {
  let currentRoom = null;
  let currentPlayer = null;

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());

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
        currentPlayer = { ws, name: '', id: -1 };
        rooms.get(code).players.push(currentPlayer);

        send(currentPlayer, { type: 'roomCreated', code, isHost: true });
      }
      else if (message.type === 'joinRoom') {
        const code = message.code.toUpperCase();
        const room = rooms.get(code);

        if (!room) {
          send(ws, { type: 'error', message: 'Room not found' });
          return;
        }

        if (room.players.length >= 2) {
          send(ws, { type: 'error', message: 'Room is full' });
          return;
        }

        currentRoom = code;
        currentPlayer = { ws, name: '', id: -1 };
        room.players.push(currentPlayer);

        send(currentPlayer, { type: 'roomJoined', code, isHost: false });
      }
      else if (currentRoom && currentPlayer) {
        handleMessage(ws, message, currentPlayer, currentRoom);
      }
    } catch (e) {
      console.error('Error handling message:', e);
    }
  });

  ws.on('close', () => {
    if (currentRoom && currentPlayer) {
      handleLeave(currentRoom, currentPlayer);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});