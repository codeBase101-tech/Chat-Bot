import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import P from 'pino';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// Setup file path for text database persistence (like a local JSON file)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_FILE = path.join(__dirname, 'database.json');

// --- DATABASE HELPER FUNCTIONS (Text File Persistence) ---
// Asynchronously loads the JSON database file (comparable to reading a C++ file stream)
async function loadDatabase() {
    try {
        const data = await fs.readFile(DB_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        // If file doesn't exist yet, return an empty object
        return {};
    }
}

// Asynchronously saves data back into the text file
async function saveDatabase(db) {
    await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

// Active session storage for games
const userSessions = new Map();

const RPS_MOVES = {
    r: { name: 'Rock', emoji: '🪨', beats: 's' },
    p: { name: 'Paper', emoji: '📄', beats: 'r' },
    s: { name: 'Scissors', emoji: '✂️', beats: 'p' }
};

const AVAILABLE_GAMES = {
    '1': { name: 'Rock-Paper-Scissors ⚛️', sessionType: 'RPS_GAME' }
};

// Function to process Rock-Paper-Scissors game logic
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

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const sock = makeWASocket({
        auth: state,
        logger: P({ level: 'silent' })
    });

    // Save login credentials
    sock.ev.on('creds.update', saveCreds);

    // Handle connection events
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
            
            if (!isLoggedOut) {
                startBot();
            } else {
                console.log('❌ Logged out. Clear auth_info_baileys and restart.');
            }
        } else if (connection === 'open') {
            console.log('✅ Connected to WhatsApp successfully!');
        }
    });

    // --- MAIN MESSAGE LISTENER ---
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const userCommand = text.trim().toLowerCase();

        // Load the database state at the beginning of each message event
        const db = await loadDatabase();

        // =====================================================================
        // 1. REGISTRATION GATEKEEPER (Checks if sender has an account)
        // =====================================================================
        if (!db[sender]) {
            if (userCommand === '!y') {
                db[sender] = {
                    playerName: "Master",
                    registeredPlayer: true,
                    accountBalance: 0,
                    wallet: 100
                };
                await saveDatabase(db);
                await sock.sendMessage(sender, { 
                    text: `✅ ${db[sender].playerName}'s account has been registered successfully! Type '*!bank*' for more information.` 
                });
                return;
            } 
            else if (userCommand === '!n') {
                await sock.sendMessage(sender, { text: "❌ Registration cancelled. Type '*!y*' whenever you want to create an account!" });
                return;
            }
            else {
                await sock.sendMessage(sender, { 
                    text: "You are not a registered player!\nWould you like to register for an account?\n\n(!y / !n)" 
                });
                return;
            }
        }

        // =====================================================================
        // 2. ACTIVE SESSION HANDLER (Handles ongoing game actions like RPS)
        // =====================================================================
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

            // Branch A: User is selecting a game from the menu
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
                        text: `⚛️ *Rock-Paper-Scissors* ⚛️\n\nChoose your move:\nReply *r* for Rock 🪨\nReply *p* for Paper 📄\nReply *s* for Scissors ✂️`
                    });
                }
                return;
            }

            // Branch B: User is actively playing Rock-Paper-Scissors
            if (session.state === 'PLAYING_RPS') {
                await processRpsMove(sock, sender, userCommand);
                return;
            }
        }

        // =====================================================================
        // 3. COMMAND ROUTER (Banking System, Help, & Menu Commands)
        // =====================================================================
        if (userCommand === '!help') {
            await sock.sendMessage(sender, { 
                text: "ℹ️ *Help Menu*\n\n• *!games* - Play interactive games\n• *!bank* - Open bank menu\n• *!balance* - Check account balance\n• *!help* - View help menu" 
            });
        } 
        else if (userCommand === '!games') {
            // Set state to game selection mode
            userSessions.set(sender, { state: 'SELECTING_GAME' });

            let menuText = `🎮 *Available Games Menu* 🎮\n\nReply with the number to play:\n`;
            for (const [key, game] of Object.entries(AVAILABLE_GAMES)) {
                menuText += `*${key}* - ${game.name}\n`;
            }
            menuText += `\nType *exit* to cancel.`;

            await sock.sendMessage(sender, { text: menuText });
        }
        // --- BANKING SYSTEM COMMANDS ---
        else if (userCommand === '!bank') {
            await sock.sendMessage(sender, { 
                text: `🏦 *BANK* 🏦\nWelcome to the Bank Master ${db[sender].playerName}!\n\n` +
                      `• \`!balance\` - Check your balance\n` +
                      `• \`!deposit <amount>\` - Deposit cash to bank\n` +
                      `• \`!withdraw <amount>\` - Withdraw from bank` 
            });
        }
        else if (userCommand === '!balance') {
            const balance = db[sender].accountBalance;
            await sock.sendMessage(sender, { text: `💰 ${db[sender].playerName}'s account balance: $${balance}` });
        }
        else if (userCommand.startsWith('!deposit')) {
            const args = text.trim().split(' ');
            const amount = parseInt(args[1]);

            if (isNaN(amount) || amount <= 0) {
                await sock.sendMessage(sender, { text: "⚠️ Please specify a valid amount to deposit. Example: `!deposit 50`" });
                return;
            }

            db[sender].accountBalance += amount;
            await saveDatabase(db); // Save updated balance to database.json instantly
            await sock.sendMessage(sender, { text: `Your deposit was successful ✅\nNew Balance: $${db[sender].accountBalance}` });
        }
        else if (userCommand.startsWith('!withdraw')) {
            const args = text.trim().split(' ');
            const amount = parseInt(args[1]);

            if (isNaN(amount) || amount <= 0) {
                await sock.sendMessage(sender, { text: "⚠️ Please specify a valid amount to withdraw. Example: `!withdraw 50`" });
                return;
            }

            // Check if player has enough balance (matching your flowchart logic)
            if (amount > db[sender].accountBalance) {
                await sock.sendMessage(sender, { text: "❌ You don't have enough money in your account!" });
                return;
            }

            db[sender].accountBalance -= amount;
            await saveDatabase(db); // Save updated balance to database.json
            await sock.sendMessage(sender, { text: `✅ $${amount} has been withdrawn successfully!` });
        }
        else {
            // Default fallback greeting for unrecognized text
            await sock.sendMessage(sender, { 
                text: "Hi! Type *!help* to see available commands or *!bank* for banking." 
            });
        }
    });
}

startBot();