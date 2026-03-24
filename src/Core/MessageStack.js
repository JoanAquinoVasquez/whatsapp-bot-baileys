class MessageStack {
    constructor(debounceTime = 10000) {
        this.debounceTime = debounceTime;
        this.stacks = new Map();
    }

    async add(chatId, messageBody, onComplete, customDebounce = null) {
        const time = customDebounce || this.debounceTime;
        if (this.stacks.has(chatId)) {
            const stack = this.stacks.get(chatId);
            clearTimeout(stack.timer);
            stack.messages.push(messageBody);

            stack.timer = setTimeout(() => this._execute(chatId, onComplete), time);
            return;
        }

        this.stacks.set(chatId, {
            messages: [messageBody],
            timer: setTimeout(() => this._execute(chatId, onComplete), time)
        });
    }

    _execute(chatId, onComplete) {
        const stack = this.stacks.get(chatId);
        if (!stack) return;

        const fullContent = stack.messages.join(' ');
        this.stacks.delete(chatId);
        onComplete(fullContent);
    }

    cancel(chatId) {
        if (this.stacks.has(chatId)) {
            clearTimeout(this.stacks.get(chatId).timer);
            this.stacks.delete(chatId);
        }
    }
}

module.exports = MessageStack;
