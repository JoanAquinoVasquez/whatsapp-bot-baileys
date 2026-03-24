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
        this.store = makeInMemoryStore({});
        this.mutedFile = path.join(__dirname, `../../muted-users.json`);
        this.mutedUsers = new Map();
        this._loadMutedUsers();
    }

    _loadMutedUsers() {
        try {
            if (fs.existsSync(this.mutedFile)) {
                const data = JSON.parse(fs.readFileSync(this.mutedFile, 'utf8'));
                this.mutedUsers = new Map(Object.entries(data));
            }
        } catch (e) {
            console.error('Error cargando usuarios silenciados:', e.message);
        }
    }

    _saveMutedUsers() {
        try {
            const data = Object.fromEntries(this.mutedUsers);
            fs.writeFileSync(this.mutedFile, JSON.stringify(data), 'utf8');
        } catch (e) {
            console.error('Error guardando usuarios silenciados:', e.message);
        }
    }

    // Helper para unificar IDs (LID vs JID) de forma inteligente
    _getCleanId(jid) {
        if (!jid) return 'unknown';

        // 1. Limpieza estándar para JIDs y LIDs
        let [idPart] = jid.split('@');
        idPart = idPart.split(':')[0];

        // 2. Intentar buscar en contactos si es un LID
        if (jid.includes('@lid')) {
            const contact = this.store.contacts[jid];
            if (contact && contact.id && contact.id.includes('@s.whatsapp.net')) {
                const resolvedId = contact.id.split('@')[0].split(':')[0];
                console.log(`DEBUG: ID resuelto de LID ${jid} -> ${resolvedId}`);
                return resolvedId;
            }
        }

        return idPart;
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
        if (!msg.message) return;

        const chatId = msg.key.remoteJid;
        if (chatId.includes('@g.us')) return;

        const body = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!body) return;

        const cleanId = this._getCleanId(chatId);
        const now = Date.now();

        if (msg.key.fromMe) {
            // Si TÚ respondes algo manual, activamos o desactivamos el mando humano
            if (body.toLowerCase().includes('#epg')) {
                this.mutedUsers.delete(cleanId);
                this.messageStack.cancel(chatId); // No dejar nada pendiente del bot
                // Intento extra por si hay variaciones del ID
                if (chatId.includes('@lid')) {
                    // Limpiar el original tmb
                    this.mutedUsers.delete(chatId.split('@')[0]);
                }

                console.log(`🤖 Bot reactivado EXPLÍCITAMENTE para: ${cleanId} (Manual)`);
                await this.sock.sendMessage(chatId, { text: "🤖 *Asistente Virtual reactivado.*" }, { quoted: msg });
            } else {
                // Silenciamos por 5 minutos cada vez que tú escribas algo manual
                const expiresAt = now + (5 * 60 * 1000);
                this.mutedUsers.set(cleanId, expiresAt);
                this.messageStack.cancel(chatId); // Si yo estoy contestando, el bot se calla lo que tuviera en espera
                console.log(`🔇 Mando humano activado para: ${cleanId}. Bot silenciado hasta ${new Date(expiresAt).toLocaleString()}`);
            }
            this._saveMutedUsers();
            return;
        }

        console.log(`📩 Mensaje de ${cleanId}: "${body}"`);

        // 2. Verificar si el usuario está silenciado
        if (this.mutedUsers.has(cleanId)) {
            const expiry = this.mutedUsers.get(cleanId);
            if (now < expiry) {
                console.log(`⏳ Bot en espera (5 min de cortesía al humano) para ${cleanId}`);
                await this.messageStack.add(chatId, body, async (fullContent) => {
                    await this._processAndReply(msg, chatId, cleanId, fullContent);
                }, 5 * 60 * 1000); // 5 minutos de espera si el humano está activo (Mando Humano)
                return;
            } else {
                this.mutedUsers.delete(cleanId);
                this._saveMutedUsers();
                console.log(`⏳ Silencio expirado para ${cleanId}. Reactivando.`);
            }
        }

        // 3. Ignorar mensajes recibidos ANTES de que el bot arrancara
        const timestamp = msg.messageTimestamp;
        if (timestamp < this.botStartTime) return;

        // Feedback visual: escribiendo
        await this.sock.sendPresenceUpdate('composing', chatId);

        await this.messageStack.add(chatId, body, async (fullContent) => {
            await this._processAndReply(msg, chatId, cleanId, fullContent);
        });
    }

    async _processAndReply(originalMsg, chatId, cleanId, content) {
        try {
            await this.sock.sendPresenceUpdate('composing', chatId);

            const reply = await this.apiService.sendMessage(content, cleanId);

            if (reply && reply.trim().length > 0) {
                console.log(`🤖 Respondiendo a ${cleanId}: "${reply.substring(0, 50)}..."`);
                const formattedReply = reply.replace(/\*\*/g, '*');
                await this.sock.sendMessage(chatId, { text: formattedReply }, { quoted: originalMsg });
            } else {
                console.log(`😶 Backend devolvió respuesta VACÍA para ${cleanId}`);
            }

            await this.sock.sendPresenceUpdate('paused', chatId);
        } catch (error) {
            console.error('Error in processAndReply:', error.message);
            await this.sock.sendPresenceUpdate('paused', chatId);
        }
    }
}

module.exports = BotInstance;
