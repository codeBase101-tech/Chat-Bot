import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import P from 'pino';

async function startBot() {
    // 1. Stores your login session locally so you don't have to scan the QR code every time
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    // 2. Creates the WhatsApp socket connection
    const sock = makeWASocket({
        auth: state,
        logger: P({ level: 'silent' }) // Keeps the terminal clean of spammy debug logs
    });

    // 3. Save your login credentials whenever they update
    sock.ev.on('creds.update', saveCreds);

    // 4. Handle connection events (generating the QR code & reconnecting if dropped)
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n📲 Scan this QR code with WhatsApp:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('⚠️ Connection closed. Reconnecting...', shouldReconnect);
            if (shouldReconnect) {
                startBot();
            }
        } else if (connection === 'open') {
            console.log('✅ Connected to WhatsApp successfully!');
        }
    });

    // 5. Listen for incoming messages
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const sender = m.key.remoteJid;
        const text = m.message.conversation || m.message.extendedTextMessage?.text;

        console.log(`📩 Message from ${sender}: ${text}`);

        // Simple automated response test
        if (text?.toLowerCase() === 'hi') {
            await sock.sendMessage(sender, { text: 'Hello! This is my custom WhatsApp bot built from scratch!' });
        }
    });
}

startBot();