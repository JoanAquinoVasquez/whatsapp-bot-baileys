const axios = require('axios');

class ApiService {
    constructor(backendUrl, chatbotToken) {
        this.backendUrl = backendUrl;
        this.chatbotToken = chatbotToken;
    }

    async sendMessage(message, realNumber, source = 'whatsapp') {
        try {
            const response = await axios.post(`${this.backendUrl}/chat`, {
                message,
                source,
                user_number: realNumber
            }, {
                headers: {
                    'X-Chatbot-Token': this.chatbotToken,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            });

            return response.data && response.data.success ? response.data.data.reply : null;
        } catch (error) {
            console.error('❌ Error API Laravel/Gemini:', error.message);
            return null;
        }
    }
}

module.exports = ApiService;
