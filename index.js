import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import P from 'pino';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ytSearch from 'yt-search';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ytdlMod = require('@distube/ytdl-core');
const ytdl = ytdlMod.default || ytdlMod;

// Setup file path for text database persistence (local JSON file)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_FILE = path.join(__dirname, 'database.json');

// --- DATABASE HELPER FUNCTIONS (Text File Persistence) ---
async function loadDatabase() {
    try {
        const data = await fs.readFile(DB_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        // If file doesn't exist yet, return an empty object
        return {};
    }
}

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

    const moves = Object.keys(RPS_MOVES);
    const botChoice = moves[Math.floor(Math.random() * moves.length)];

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

    sock.ev.on('creds.update', saveCreds);

    // Handle connection & QR Code events
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

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
        const pushName = msg.pushName || "Master"; 
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const trimmedText = text.trim();
        const userCommand = trimmedText.toLowerCase();

        // Load database at the start of each message event
        const db = await loadDatabase();

        // =====================================================================
        // 0. COMMAND FILTER (Ignore normal chat unless it starts with '!')
        // =====================================================================
        const isRegistered = db[sender] ? db[sender].playerBankAccount : false;
        if (!trimmedText.startsWith('!')) {
            if (isRegistered && !userSessions.has(sender)) return;
        }

        // =====================================================================
        // 1. REGISTRATION GATEKEEPER
        // =====================================================================
        if (!db[sender]) {
            if (userCommand === '!y') {
                db[sender] = {
                    playerName: pushName,
                    playerBankAccount: true,
                    playerBankBalance: 0,
                    playerWallet: 5000, 
                    playerStatus: "Active"
                };
                await saveDatabase(db);
                await sock.sendMessage(sender, { 
                    text: `✅ ${db[sender].playerName}'s account has been registered successfully! 🏦\nType '*!bank*' for more information.` 
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
        // 2. ACTIVE SESSION HANDLER (RPS Game Sessions)
        // =====================================================================
        if (userSessions.has(sender)) {
            if (userCommand === 'exit') {
                userSessions.delete(sender);
                await sock.sendMessage(sender, {
                    text: "🚪 You exited the game. Type *!games* to play again or *!help* for commands."
                });
                return;
            }

            const session = userSessions.get(sender);

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

            if (session.state === 'PLAYING_RPS') {
                await processRpsMove(sock, sender, userCommand);
                return;
            }
        }

        // =====================================================================
        // 3. COMMAND ROUTER (Help, Games, Bank, Wallet, Deposit, Withdraw, Play)
        // =====================================================================
        if (userCommand === '!help') {
            await sock.sendMessage(sender, { 
                text: `❇️*${db[sender].playerName}*❇️\nHi! My name is Raphael. How to use me:\n\n` +
                      `◽ *!games* - Play games\n` +
                      `◽ *!bank* - Bank information\n` +
                      `◽ *!wallet balance* - Check wallet cash\n` +
                      `◽ *!deposit #amount#* - Deposit money into Bank\n` +
                      `◽ *!withdraw #amount#* - Withdraw from Bank to Wallet\n` +
                      `◽ *!play <song>* - Search and download YouTube audio` 
            });
        } 
        else if (userCommand === '!games') {
            userSessions.set(sender, { state: 'SELECTING_GAME' });

            let menuText = `🎮 *Available Games Menu* 🎮\n\nReply with the number to play:\n`;
            for (const [key, game] of Object.entries(AVAILABLE_GAMES)) {
                menuText += `*${key}* - ${game.name}\n`;
            }
            menuText += `\nType *exit* to cancel.`;

            await sock.sendMessage(sender, { text: menuText });
        }
        else if (userCommand === '!bank') {
            await sock.sendMessage(sender, { 
                text: `🏦 *BANK* 🏦\n\nWelcome To The Bank ${db[sender].playerName}!!!\nHow To Use The Bank:\n\n` +
                      `◽ \`!deposit #amount#\` - Deposit money into the Bank\n` +
                      `◽ \`!withdraw #amount#\` - Withdraw from Bank to Wallet\n` +
                      `◽ \`!balance\` - Check bank balance\n\n` +
                      `💰 *WALLET* 💰\n` +
                      `▪️ Use wallet to play games (Max capacity: $50,000)` 
            });
        }
        else if (userCommand === '!balance') {
            const balance = db[sender].playerBankBalance;
            await sock.sendMessage(sender, { text: `💰 ${db[sender].playerName}'s Bank account balance: $${balance}` });
        }
        else if (userCommand === '!wallet balance') {
            const walletBalance = db[sender].playerWallet;
            await sock.sendMessage(sender, { text: `👛 Wallet Balance: $${walletBalance}` });
        }
        else if (userCommand.startsWith('!deposit')) {
            const args = text.trim().split(' ');
            const amount = parseInt(args[1]);

            if (isNaN(amount) || amount <= 0) {
                await sock.sendMessage(sender, { text: "⚠️ Please specify a valid amount. Example: `!deposit 500`" });
                return;
            }

            if (amount > db[sender].playerWallet) {
                await sock.sendMessage(sender, { text: "❌ You don't have enough money in your Wallet!" });
                return;
            }

            db[sender].playerWallet -= amount;
            db[sender].playerBankBalance += amount;
            await saveDatabase(db);

            await sock.sendMessage(sender, { 
                text: `Your deposit was successful ✅\nNew Bank Balance: $${db[sender].playerBankBalance}\nWallet Balance: $${db[sender].playerWallet}` 
            });
        }
        else if (userCommand.startsWith('!withdraw')) {
            const args = text.trim().split(' ');
            const amount = parseInt(args[1]);

            if (isNaN(amount) || amount <= 0) {
                await sock.sendMessage(sender, { text: "⚠️ Please specify a valid amount. Example: `!withdraw 500`" });
                return;
            }

            if (amount > db[sender].playerBankBalance) {
                await sock.sendMessage(sender, { text: "❌ You don't have enough money in your Bank account!" });
                return;
            }

            if (amount + db[sender].playerWallet > 50000) {
                await sock.sendMessage(sender, { text: "⚠️ *Withdraw Unsuccessful!!!* Cannot exceed $50,000 capacity." });
                return;
            }

            db[sender].playerBankBalance -= amount;
            db[sender].playerWallet += amount;
            await saveDatabase(db);

            await sock.sendMessage(sender, { 
                text: `✅ $${amount} has been withdrawn successfully to your Wallet!\nWallet Balance: $${db[sender].playerWallet}` 
            });
        }
        else if (userCommand.startsWith('!play')) {
            const query = text.replace(/^!play/i, '').trim();

            if (!query) {
                await sock.sendMessage(sender, { text: "⚠️ Please specify a song name. Example: `!play Shape of You`" });
                return;
            }

            await sock.sendMessage(sender, { text: `🔍 Searching YouTube for *${query}*...` });

            try {
                const searchResult = await ytSearch(query);
                const videos = searchResult.videos;

                if (!videos || videos.length === 0) {
                    await sock.sendMessage(sender, { text: "❌ No results found for that search." });
                    return;
                }

                const topVideo = videos[0];
                await sock.sendMessage(sender, { text: `🎵 Downloading *${topVideo.title}* (${topVideo.timestamp})... Please wait ⏳` });

                const audioFilePath = path.join(__dirname, `temp_${Date.now()}.mp3`);

                const stream = ytdl(topVideo.url, { filter: 'audioonly', quality: 'highestaudio' });
                const writeStream = fsSync.createWriteStream(audioFilePath);

                stream.pipe(writeStream);

                writeStream.on('finish', async () => {
                    await sock.sendMessage(sender, { 
                        audio: { url: audioFilePath }, 
                        mimetype: 'audio/mp4', 
                        ptt: false 
                    });

                    try {
                        await fs.unlink(audioFilePath);
                    } catch (err) {
                        console.error("Cleanup error:", err);
                    }
                });

                stream.on('error', async (err) => {
                    console.error(err);
                    await sock.sendMessage(sender, { text: "❌ Error downloading the audio stream." });
                });

            } catch (error) {
                console.error(error);
                await sock.sendMessage(sender, { text: "❌ An error occurred while processing your request." });
            }
        }
        else {
            await sock.sendMessage(sender, { 
                text: "❌ Unknown command. Type *!help* to see available commands." 
            });
        }
    });
}

startBot();