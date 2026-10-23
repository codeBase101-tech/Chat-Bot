import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import P from 'pino';



// ============================================================================
// 1. PLACE THIS AT THE VERY TOP OF YOUR FILE (OUTSIDE startBot)
// ============================================================================
const userSessions = new Map();

const RPS_MOVES = {
  r: { name: 'Rock', emoji: '🪨', beats: 's' },
  p: { name: 'Paper', emoji: '📄', beats: 'r' },
  s: { name: 'Scissors', emoji: '✂️', beats: 'p' }
};

const AVAILABLE_GAMES = {
  '1': { name: 'Rock-Paper-Scissors ⚛️', sessionType: 'RPS_GAME' }
};

async function processRpsMove(sock, sender, userChoice) {
  if (!RPS_MOVES[userChoice]) {
    await sock.sendMessage(sender, { 
      text: "❌ Invalid choice! Reply with 'r' for Rock 🪨, 'p' for Paper 📄, 's' for Scissors ✂️, or type *exit* to quit." 
    });
    return;
  }

  // Pick computer move
  const moves = Object.keys(RPS_MOVES);
  const botChoice = moves[Math.floor(Math.random() * moves.length)];

  // Determine Winner
  let outcome = '';
  if (userChoice === botChoice) {
    outcome = "It's a tie! 👔";
  } else if (RPS_MOVES[userChoice].beats === botChoice) {
    outcome = "You win! 🎉";
  } else {
    outcome = "Bot wins! 🤖";
  }

  const resultText = 
    `🎮 *Game Result* 🎮\n\n` +
    `You: ${RPS_MOVES[userChoice].name} ${RPS_MOVES[userChoice].emoji}\n` +
    `Bot: ${RPS_MOVES[botChoice].name} ${RPS_MOVES[botChoice].emoji}\n\n` +
    `*${outcome}*\n\n` +
    `_Play again? Reply 'r', 'p', or 's'. Type *exit* to leave the game._`;

  await sock.sendMessage(sender, { text: resultText });
}

// ============================================================================
// BANKING SYSTEM
// ============================================================================



// ============================================================================
// 2. MAIN BOT FUNCTION
// ============================================================================
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const sock = makeWASocket({ auth: state });

  // 3. Save login credentials
  sock.ev.on('creds.update', saveCreds);

  
  // 4. Handle connection events
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Display QR code whenever Baileys emits it
    if (qr) {
      console.log('\n📱 Scan this QR code with WhatsApp:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      console.log(`⚠️ Connection closed (Status Code: ${statusCode}). Reconnecting...`);

      // Reconnect automatically unless explicitly logged out from WhatsApp phone app
      if (!isLoggedOut) {
        startBot();
      } else {
        console.log('❌ Logged out from WhatsApp. Clear auth_info_baileys and restart.');
      }
    } else if (connection === 'open') {
      console.log('✅ Connected to WhatsApp successfully!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0];
    if (!m.message || m.key.fromMe) return;

    const sender = m.key.remoteJid;
    const text = m.message.conversation || m.message.extendedTextMessage?.text || '';
    const userCommand = text.trim().toLowerCase();

    // -------------------------------------------------------------
    // 1. ACTIVE SESSION HANDLER (Handles ongoing game actions)
    // -------------------------------------------------------------
    if (userSessions.has(sender)) {
      // Check if user wants to exit active session at any point
      if (userCommand === 'exit') {
        userSessions.delete(sender);
        await sock.sendMessage(sender, { 
          text: "🚪 You exited the game. Type *!games* to play again or *!help* for commands." 
        });
        return;
      }

      const session = userSessions.get(sender);

      // Branch A: User is picking a game from the menu
      if (session.state === 'SELECTING_GAME') {
        const selectedGame = AVAILABLE_GAMES[userCommand];

        if (!selectedGame) {
          await sock.sendMessage(sender, { 
            text: "❌ Invalid selection! Reply with a valid game number or type *exit* to cancel." 
          });
          return;
        }

        if (selectedGame.sessionType === 'RPS_GAME') {
          userSessions.set(sender, { state: 'PLAYING_RPS' });
          await sock.sendMessage(sender, {
            text: `⚛️ *Rock-Paper-Scissors* ⚛️\n\nChoose your move:\n• Reply *r* for Rock 🪨\n• Reply *p* for Paper 📄\n• Reply *s* for Scissors ✂️\n\n_Type *exit* anytime to quit._`
          });
        }
        return;
      }

      // Branch B: User is in the Rock-Paper-Scissors game loop
      if (session.state === 'PLAYING_RPS') {
        await processRpsMove(sock, sender, userCommand);
        return;
      }
    }

    // -------------------------------------------------------------
    // 2. COMMAND ROUTER (Default & Normal Commands)
    // -------------------------------------------------------------
    if (userCommand === '!help') {
      await sock.sendMessage(sender, { 
        text: "ℹ️ *Help Menu*\n\n• Type *!games* to play interactive games.\n• Type *!help* to view this help message." 
      });
    } else if (userCommand === '!games') {
      // Set state to game selection mode
      userSessions.set(sender, { state: 'SELECTING_GAME' });

      let menuText = `🎮 *Available Games Menu* 🎮\n\nReply with the number to play:\n`;
      for (const [key, game] of Object.entries(AVAILABLE_GAMES)) {
        menuText += `*${key}* - ${game.name}\n`;
      }
      menuText += `\n_Type *exit* to cancel._`;

      await sock.sendMessage(sender, { text: menuText });
    } else {
      // Default greeting for non-commands
      await sock.sendMessage(sender, { 
        text: "Hi! To use me, enter *!help*." 
      });
    }
  });
}

startBot();