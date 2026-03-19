require('dotenv').config();
const ApiService = require('./src/Services/ApiService');
const BotInstance = require('./src/Core/BotInstance');

// 1. Configuración de Sesiones
const tokens = {
    'session-1': process.env.FIRST_NUMBER || '924545013',
    'session-2': process.env.SECOND_NUMBER || '995901454'
};

// 2. Punto de entrada (Inicie el bot)
const botStartTime = Math.floor(Date.now() / 1000);

// Inyectamos las dependencias necesarias
const apiService = new ApiService(process.env.BACKEND_URL, process.env.CHATBOT_TOKEN);

console.log('🚀 Iniciando orquestador de bots de WhatsApp (BAILEYS EDITION)...');

// Iniciamos cada bot independientemente
(async () => {
    for (const [sessionId, number] of Object.entries(tokens)) {
        const bot = new BotInstance(sessionId, number, apiService, botStartTime);
        await bot.initialize();
    }
})();
