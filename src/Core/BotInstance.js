const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const MessageStack = require('./MessageStack');
const path = require('path');

class BotInstance {
    constructor(sessionId, number, apiService, botStartTime) {
        this.sessionId = sessionId;
        this.number = number;
        this.apiService = apiService;
        this.botStartTime = botStartTime;
        this.messageStack = new MessageStack(10000);
        this.authDir = path.join(__dirname, `../../sessions/${sessionId}`);
    }

    async initialize() {
        console.log(`Cargando sesión desde: ${this.authDir}`);
        const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
        const { version } = await fetchLatestBaileysVersion();

        this.sock = makeWASocket({
            version,
            logger: pino({ level: 'warn' }),
            printQRInTerminal: false,
            auth: state,
            browser: ["Ubuntu", "Chrome", "20.0.04"]
        });

        this.sock.ev.on('creds.update', saveCreds);

        this.sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log(`\n=== ESCANEA ESTE QR PARA EL NÚMERO ${this.number} ===`);
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log('Conexión cerrada. ¿Reconectando?', shouldReconnect);
                if (shouldReconnect) this.initialize();
            } else if (connection === 'open') {
                console.log(`¡Bot conectado via Baileys para el número ${this.number}!`);
            }
        });

        this.sock.ev.on('messages.upsert', async (m) => this._handleMessages(m));
    }

    async _handleMessages(m) {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const chatId = msg.key.remoteJid;
        if (chatId.includes('@g.us')) return;

        const timestamp = msg.messageTimestamp;
        if (timestamp < this.botStartTime) return;

        const body = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!body) return;

        // Feedback visual: escribiendo
        await this.sock.sendPresenceUpdate('composing', chatId);

        await this.messageStack.add(chatId, body, async (fullContent) => {
            await this._processAndReply(msg, chatId, fullContent);
        });
    }

    async _processAndReply(originalMsg, chatId, content) {
        try {
            await this.sock.sendPresenceUpdate('composing', chatId);

            const realNumber = chatId.split('@')[0];
            const reply = await this.apiService.sendMessage(content, realNumber);

            if (reply && reply.trim().length > 0) {
                const formattedReply = reply.replace(/\*\*/g, '*');
                await this.sock.sendMessage(chatId, { text: formattedReply }, { quoted: originalMsg });
            }

            await this.sock.sendPresenceUpdate('paused', chatId);
        } catch (error) {
            console.error('Error in processAndReply:', error.message);
            await this.sock.sendPresenceUpdate('paused', chatId);
        }
    }
}

module.exports = BotInstance;
