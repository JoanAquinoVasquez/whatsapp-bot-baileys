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
        this.mutedFile = path.join(__dirname, `../../muted-users.json`);
        this.mutedUsers = new Map();
        this.lidToJidMap = new Map();  // Mapa LID -> JID real (@s.whatsapp.net)
        this.pendingReplies = new Map(); // Mensajes pendientes de ACK para retry
        this.lidMapFile = path.join(__dirname, `../../lid-map-${sessionId}.json`);
        this._loadMutedUsers();
        this._loadLidMap();
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

    _loadLidMap() {
        try {
            if (fs.existsSync(this.lidMapFile)) {
                const data = JSON.parse(fs.readFileSync(this.lidMapFile, 'utf8'));
                this.lidToJidMap = new Map(Object.entries(data));
                console.log(`📇 [${this.sessionId}] Mapa LID cargado: ${this.lidToJidMap.size} entradas`);
            }
        } catch (e) {
            console.error('Error cargando mapa LID:', e.message);
        }
    }

    _saveLidMap() {
        try {
            const data = Object.fromEntries(this.lidToJidMap);
            fs.writeFileSync(this.lidMapFile, JSON.stringify(data), 'utf8');
        } catch (e) {
            // Silencioso para no saturar logs
        }
    }

    _updateLidMapFromContacts(contacts) {
        let newEntries = 0;
        for (const contact of contacts) {
            const jid = contact.id || contact.jid;
            const lid = contact.lid;
            if (lid && jid && jid.includes('@s.whatsapp.net')) {
                // Guardar mapeo completo (lid@lid -> jid@s.whatsapp.net)
                this.lidToJidMap.set(lid, jid);
                // Guardar también solo la parte numérica del LID
                const lidNum = lid.split('@')[0].split(':')[0];
                this.lidToJidMap.set(lidNum, jid);
                newEntries++;
            }
        }
        if (newEntries > 0) {
            console.log(`📇 [${this.sessionId}] +${newEntries} mapeos LID->JID (Total: ${this.lidToJidMap.size})`);
            this._saveLidMap();
        }
    }

    // Helper para unificar IDs (LID vs JID) de forma inteligente
    _getCleanId(jid) {
        if (!jid) return 'unknown';

        // 1. Si es un LID, intentar buscar en nuestro mapa persistido primero
        if (jid.includes('@lid')) {
            if (this.lidToJidMap.has(jid)) {
                const resolved = this.lidToJidMap.get(jid);
                const resolvedId = resolved.split('@')[0].split(':')[0];
                console.log(`DEBUG _getCleanId: LID ${jid} resuelto via lidToJidMap -> ${resolvedId}`);
                return resolvedId;
            }
            const lidNum = jid.split('@')[0].split(':')[0];
            if (this.lidToJidMap.has(lidNum)) {
                const resolved = this.lidToJidMap.get(lidNum);
                const resolvedId = resolved.split('@')[0].split(':')[0];
                console.log(`DEBUG _getCleanId: LID ${jid} (num) resuelto via lidToJidMap -> ${resolvedId}`);
                return resolvedId;
            }
        }

        // 2. Limpieza estándar para JIDs y LIDs
        let [idPart] = jid.split('@');
        idPart = idPart.split(':')[0];

        return idPart;
    }

    // Resolver LID a JID real para enviar mensajes
    _resolveJidForSending(chatId) {
        if (!chatId || !chatId.includes('@lid')) {
            return chatId; // Ya es un JID normal
        }

        const lidNum = chatId.split('@')[0].split(':')[0];

        // 1. Buscar en nuestro mapa LID->JID persistido
        if (this.lidToJidMap.has(chatId)) {
            const resolved = this.lidToJidMap.get(chatId);
            console.log(`📱 LID resuelto via mapa: ${chatId} -> ${resolved}`);
            return resolved;
        }
        if (this.lidToJidMap.has(lidNum)) {
            const resolved = this.lidToJidMap.get(lidNum);
            console.log(`📱 LID resuelto via mapa (num): ${lidNum} -> ${resolved}`);
            return resolved;
        }

        // 2. Fallback: avisar que no se pudo resolver y retornar el ID original
        console.log(`⚠️ No se pudo resolver LID: ${chatId} - el mensaje podría no entregarse`);
        return chatId;
    }

    _isAdmin(cleanId) {
        const adminNumbersStr = process.env.ADMIN_NUMBERS || '';
        const adminNumbers = adminNumbersStr.split(',').map(n => n.trim());
        console.log(`🔍 [DEBUG _isAdmin] Verificando si ${cleanId} es administrador.`);
        console.log(`🔍 [DEBUG _isAdmin] Lista de admins configurados:`, adminNumbers);
        const isMatch = adminNumbers.some(adminNum => {
            if (!adminNum) return false;
            const match = cleanId === adminNum || cleanId.endsWith(adminNum);
            if (match) console.log(`   -> Match encontrado con: ${adminNum}`);
            return match;
        });
        console.log(`🔍 [DEBUG _isAdmin] Resultado para ${cleanId}: ${isMatch ? 'AUTORIZADO' : 'NO AUTORIZADO'}`);
        return isMatch;
    }

    async initialize() {
        console.log(`Cargando sesión desde: ${this.authDir}`);

        // Importación dinámica de Baileys para dar soporte a ESM en entorno CommonJS (Node 16)
        const {
            default: makeWASocket,
            useMultiFileAuthState,
            DisconnectReason,
            fetchLatestBaileysVersion
        } = await import('@whiskeysockets/baileys');

        const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
        const { version } = await fetchLatestBaileysVersion();

        this.sock = makeWASocket({
            version,
            logger: pino({ level: 'warn' }),
            printQRInTerminal: false,
            auth: state,
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            syncFullHistory: false
        });

        this.sock.ev.on('creds.update', saveCreds);

        // === MAPEO LID -> JID: Escuchar sincronización de contactos ===
        this.sock.ev.on('contacts.set', ({ contacts }) => {
            console.log(`📇 [${this.sessionId}] contacts.set recibido (${contacts?.length || 0} contactos)`);
            if (contacts) this._updateLidMapFromContacts(contacts);
        });

        this.sock.ev.on('contacts.update', (updates) => {
            this._updateLidMapFromContacts(updates);
        });

        this.sock.ev.on('contacts.upsert', (contacts) => {
            this._updateLidMapFromContacts(contacts);
        });

        // Capturar historial de mensajes (sync inicial)
        this.sock.ev.on('messaging-history.set', ({ contacts }) => {
            if (contacts && contacts.length) {
                console.log(`📇 [${this.sessionId}] messaging-history.set: ${contacts.length} contactos`);
                this._updateLidMapFromContacts(contacts);
            }
        });

        // === RETRY: Detectar error 463 en ACK y reintentar ===
        this.sock.ev.on('messages.update', (updates) => {
            for (const update of updates) {
                const msgId = update.key?.id;
                // status 0 o ERROR en Baileys puede indicar fallo de envío
                if (msgId && this.pendingReplies.has(msgId)) {
                    const status = update.update?.status;
                    // status: 1=pending, 2=sent/server, 3=delivered, 4=read, 0/5=error
                    if (status === 0 || status === 5) {
                        const pending = this.pendingReplies.get(msgId);
                        this.pendingReplies.delete(msgId);
                        console.log(`🔄 ACK error detectado para msg ${msgId}, reintentando con JID alternativo...`);
                        this._retryWithAlternativeJid(pending);
                    } else if (status >= 2) {
                        // Mensaje entregado correctamente, limpiar
                        this.pendingReplies.delete(msgId);
                    }
                }
            }
        });

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
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`Conexión cerrada para la sesión ${this.sessionId}. Código: ${statusCode}. ¿Reconectando?: ${shouldReconnect}`);
                
                if (shouldReconnect) {
                    this.initialize();
                } else {
                    console.log(`⚠️ Sesión inválida o cerrada (Logged Out). Limpiando credenciales en: ${this.authDir}`);
                    try {
                        if (fs.existsSync(this.authDir)) {
                            fs.rmSync(this.authDir, { recursive: true, force: true });
                        }
                    } catch (err) {
                        console.error('Error al borrar la carpeta de sesión:', err.message);
                    }
                    console.log('🔄 Re-inicializando para generar un nuevo código QR...');
                    this.initialize();
                }
            } else if (connection === 'open') {
                console.log(`¡Bot conectado via Baileys para el número ${this.number}!`);
            }
        });

        this.sock.ev.on('messages.upsert', async (m) => this._handleMessages(m));
    }

    async _retryWithAlternativeJid(pending) {
        try {
            const { chatId, cleanId, text } = pending;
            const lidNum = chatId.split('@')[0].split(':')[0];

            // Si cleanId es igual al lidNum, no se pudo resolver un JID real de teléfono.
            // Enviar a cleanId@s.whatsapp.net sería enviar al número de LID en el dominio de teléfonos, lo cual fallará.
            if (cleanId === lidNum) {
                console.log(`⚠️ No se puede reintentar con JID alternativo: cleanId es igual al LID (${cleanId}).`);
                return;
            }

            const altJid = cleanId + '@s.whatsapp.net';
            console.log(`🔄 Reintentando envío a JID alternativo: ${altJid} (original: ${chatId})`);
            const result = await this.sock.sendMessage(altJid, { text });
            if (result) {
                // Guardar el mapeo para futuros mensajes
                this.lidToJidMap.set(chatId, altJid);
                this.lidToJidMap.set(lidNum, altJid);
                this._saveLidMap();
                console.log(`✅ Retry exitoso! Mapeo guardado: ${chatId} -> ${altJid}`);
            }
        } catch (error) {
            console.error(`❌ Retry también falló:`, error.message);
        }
    }

    async _handleMessages(m) {
        const msg = m.messages[0];
        if (!msg.message) return;

        const chatId = msg.key.remoteJid;
        if (chatId.includes('@g.us')) return;

        // Intentar capturar el JID real alternativo si el mensaje viene de un LID
        if (chatId.includes('@lid')) {
            const altJid = msg.key.remoteJidAlt || msg.key.participantAlt;
            if (altJid && altJid.includes('@s.whatsapp.net')) {
                const lidNum = chatId.split('@')[0].split(':')[0];
                this.lidToJidMap.set(chatId, altJid);
                this.lidToJidMap.set(lidNum, altJid);
                this._saveLidMap();
                console.log(`📇 Mapeo capturado de msg.key: ${chatId} -> ${altJid}`);
            }
        }

        const body = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!body) return;

        const cleanId = this._getCleanId(chatId);
        const now = Date.now();

        if (msg.key.fromMe) {
            // Ignorar si es un mensaje enviado automáticamente por el propio bot
            const isBotMessage = body.includes('🤖') || body.includes('⏳') || body.includes('❌');
            if (isBotMessage) {
                return;
            }

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

        // Interceptar comandos administrativos (ej. Reporte Top Programas)
        const normalizedBody = body.toLowerCase().trim();
        const isAdminCommand = normalizedBody === '/reportetop' || 
                             normalizedBody === 'reporte top' || 
                             normalizedBody === 'reporte top programas' ||
                             normalizedBody === 'reporte de programas top';

        console.log(`🔍 [DEBUG _handleMessages] normalizedBody: "${normalizedBody}", isAdminCommand: ${isAdminCommand}`);

        if (isAdminCommand) {
            if (this._isAdmin(cleanId)) {
                console.log(`👑 Comando admin de ${cleanId} detectado: "${normalizedBody}"`);
                await this.sock.sendPresenceUpdate('composing', chatId);
                await this.sock.sendMessage(chatId, { text: "⏳ *Generando el reporte de programas top en PDF...*" }, { quoted: msg });
                
                try {
                    const pdfBuffer = await this.apiService.getTopProgramasPdf();
                    if (pdfBuffer) {
                        const dateStr = new Date().toLocaleDateString('es-PE', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
                        await this.sock.sendMessage(chatId, {
                            document: pdfBuffer,
                            mimetype: 'application/pdf',
                            fileName: `reporte_top_programas_${dateStr}.pdf`,
                            caption: "🤖 *Aquí tienes el reporte top de programas solicitado.*"
                        }, { quoted: msg });
                    } else {
                        await this.sock.sendMessage(chatId, { text: "❌ *Error al obtener el reporte desde el servidor.*" }, { quoted: msg });
                    }
                } catch (error) {
                    console.error("❌ Error al enviar PDF del reporte:", error);
                    await this.sock.sendMessage(chatId, { text: "❌ *Hubo un error al generar o enviar el archivo PDF.*" }, { quoted: msg });
                }
            } else {
                console.log(`⚠️ Usuario no autorizado ${cleanId} intentó ejecutar comando: "${normalizedBody}"`);
            }
            return; // Terminar procesamiento, no pasarlo a la IA ni encolarlo
        }

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
            // Resolver LID a JID real antes de enviar
            const sendToJid = this._resolveJidForSending(chatId);

            await this.sock.sendPresenceUpdate('composing', sendToJid).catch(() => {});

            const replyData = await this.apiService.sendMessage(content, cleanId);
            const reply = replyData?.reply;
            const handover = replyData?.handover;

            if (reply && reply.trim().length > 0) {
                console.log(`🤖 Respondiendo a ${cleanId} (JID: ${sendToJid}): "${reply.substring(0, 50)}..."`);
                const formattedReply = reply.replace(/\*\*/g, '*');

                // Enviar el mensaje
                const sentMsg = await this.sock.sendMessage(sendToJid, { text: formattedReply }, { quoted: originalMsg });

                // Intentar capturar el JID real alternativo desde la respuesta si enviamos a un LID
                if (chatId.includes('@lid')) {
                    const sentAltJid = sentMsg?.key?.remoteJidAlt || sentMsg?.key?.participantAlt;
                    if (sentAltJid && sentAltJid.includes('@s.whatsapp.net')) {
                        this.lidToJidMap.set(chatId, sentAltJid);
                        const lidNum = chatId.split('@')[0].split(':')[0];
                        this.lidToJidMap.set(lidNum, sentAltJid);
                        this._saveLidMap();
                        console.log(`📇 Mapeo capturado al enviar mensaje: ${chatId} -> ${sentAltJid}`);
                    }

                    // Registrar para retry automático vía ACK
                    if (sentMsg?.key?.id) {
                        this.pendingReplies.set(sentMsg.key.id, {
                            chatId,
                            cleanId,
                            text: formattedReply
                        });
                        // Limpiar después de 30 segundos si no hubo ACK
                        setTimeout(() => this.pendingReplies.delete(sentMsg.key.id), 30000);
                    }
                }

                // Si la IA activó el handover, silenciamos al bot para este usuario
                if (handover) {
                    const now = Date.now();
                    const expiresAt = now + (24 * 60 * 60 * 1000);
                    this.mutedUsers.set(cleanId, expiresAt);
                    this._saveMutedUsers();
                    console.log(`🔇 Mando humano activado via IA para: ${cleanId}. Bot silenciado por 24h.`);
                }
            } else {
                console.log(`😶 Backend devolvió respuesta VACÍA para ${cleanId}`);
            }

            await this.sock.sendPresenceUpdate('paused', sendToJid).catch(() => {});
        } catch (error) {
            console.error(`❌ Error in processAndReply para ${cleanId}:`, error.message);
            // Si el envío falló con excepción y era LID, intentar con @s.whatsapp.net
            if (chatId.includes('@lid')) {
                try {
                    const fallbackJid = cleanId + '@s.whatsapp.net';
                    console.log(`🔄 Fallback: intentando enviar a ${fallbackJid}`);
                    const replyData = await this.apiService.sendMessage(content, cleanId);
                    if (replyData?.reply) {
                        const formattedReply = replyData.reply.replace(/\*\*/g, '*');
                        await this.sock.sendMessage(fallbackJid, { text: formattedReply });
                    }
                } catch (retryErr) {
                    console.error(`❌ Fallback también falló:`, retryErr.message);
                }
            }
            await this.sock.sendPresenceUpdate('paused', chatId).catch(() => {});
        }
    }
}

module.exports = BotInstance;
