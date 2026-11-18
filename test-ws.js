// WebSocket test script for room creation and joining
const WebSocket = require('ws');

const PORT = 3000;
const URL = `ws://localhost:${PORT}`;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testFlow() {
  console.log('=== Starting WebSocket Test ===\n');

  // Kill existing server on port 3000
  const { execSync } = require('child_process');
  try {
    execSync('for /f "tokens=5" %a in (\'netstat -ano ^| findstr :3000 ^| findstr LISTENING\') do @if %a NEQ 0 taskkill /f /pid %a', { shell: true });
  } catch (e) {}

  // Start server
  const { spawn } = require('child_process');
  const server = spawn('node', ['server.js'], {
    cwd: __dirname,
    stdio: 'inherit'
  });

  await delay(1500);

  try {
    // Test 1: Create room (Player 1 - Host)
    console.log('\n--- Test 1: Player 1 Creates Room ---');
    const ws1 = new WebSocket(URL);

    await new Promise((resolve, reject) => {
      ws1.on('open', () => {
        console.log('WS1: Connected');
        ws1.send(JSON.stringify({
          type: 'createRoom',
          pairCount: 16,
          name: 'Player 1'
        }));
      });

      ws1.on('message', (data) => {
        const msg = JSON.parse(data);
        console.log('WS1 Received:', msg.type, msg);
        if (msg.type === 'roomCreated') {
          roomCode = msg.code;
          console.log(`Room created with code: ${roomCode}`);
          resolve();
        }
      });

      ws1.on('error', reject);
    });

    // Test 2: Join room (Player 2 - Guest)
    console.log('\n--- Test 2: Player 2 Joins Room ---');
    const ws2 = new WebSocket(URL);

    await new Promise((resolve, reject) => {
      ws2.on('open', () => {
        console.log('WS2: Connected');
        ws2.send(JSON.stringify({
          type: 'joinRoom',
          code: roomCode,
          name: 'Player 2'
        }));
      });

      ws2.on('message', (data) => {
        const msg = JSON.parse(data);
        console.log('WS2 Received:', msg.type, msg);
        if (msg.type === 'roomJoined') {
          console.log(`Joined room: ${msg.code}`);
          resolve();
        }
        if (msg.type === 'error') {
          reject(new Error(msg.message));
        }
      });

      ws2.on('error', reject);
    });

    // Test 3: Wait for automatic gameStart (server auto-starts when 2 players join)
    console.log('\n--- Test 3: Waiting for automatic gameStart ---');
    let gameStarted = false;

    await new Promise((resolve, reject) => {
      const checkGameStart = (ws, playerNum) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data);
          console.log(`WS${playerNum} Received:`, msg.type);

          if (msg.type === 'joined') {
            console.log(`Player ${playerNum} joined as ID: ${msg.playerId}, isHost: ${msg.isHost}`);
          }

          if (msg.type === 'gameStart') {
            if (!gameStarted) {
              gameStarted = true;
              console.log('\n✅ Game started!');
              console.log('Cards:', msg.deck.length);
              console.log('Player ID:', msg.playerId);
              console.log('Player names:', msg.names);
              resolve();
            }
          }
        });
      };

      checkGameStart(ws1, 1);
      checkGameStart(ws2, 2);

      // Timeout after 10 seconds
      setTimeout(() => reject(new Error('Timeout waiting for gameStart')), 10000);
    });

    console.log('\n=== All Tests Passed! ===');

  } catch (error) {
    console.error('\n=== Test Failed ===', error.message);
  } finally {
    server.kill();
    process.exit(0);
  }
}

let roomCode = '';
testFlow();