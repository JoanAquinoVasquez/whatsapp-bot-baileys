const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeInMemoryStore
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const fs = require('fs');
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
        this.store = makeInMemoryStore({}); // Para mapear LIDs a números de teléfono
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
        this.store.bind(this.sock.ev); // Vincular el almacén a los eventos del bot

        this.sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log(`\n=== ESCANEA ESTE QR PARA EL NÚMERO ${this.number} ===`);
                qrcodeTerminal.generate(qr, { small: true });

                // Generar versión HTML (Imagen perfecta)
                const fileName = `scan-me-${this.sessionId}.html`;
                const filePath = path.join(__dirname, `../../${fileName}`);
                QRCode.toDataURL(qr).then(url => {
                    const html = `<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f0f2f5;">
                        <div style="background:white;padding:20px;border-radius:15px;text-align:center;box-shadow:0 10px 25px rgba(0,0,0,0.1);font-family:sans-serif;">
                            <h2>Escanear para: ${this.number}</h2>
                            <img src="${url}" style="width:300px;height:300px;display:block;margin:10px auto;" />
                            <p style="color:#666;">Actualiza este archivo para ver un nuevo QR si expira.</p>
                        </div>
                    </body></html>`;
                    fs.writeFileSync(filePath, html);
                    console.log(`✅ QR generado en imagen: ${fileName} (Ábrelo con 'View' en cPanel)`);
                });
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

            // Extraer el identificador del usuario de forma robusta
            const senderJid = originalMsg.key.participant || chatId;

            // Intentamos obtener el número real desde el almacén de contactos
            const contact = this.store.contacts[senderJid];
            let realNumber = senderJid.split('@')[0].split(':')[0];

            if (contact && contact.id && contact.id.includes('@s.whatsapp.net')) {
                realNumber = contact.id.split('@')[0].split(':')[0];
            }

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
