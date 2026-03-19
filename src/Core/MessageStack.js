class MessageStack {
    constructor(debounceTime = 10000) {
        this.debounceTime = debounceTime;
        this.stacks = new Map();
    }

    async add(chatId, messageBody, onComplete) {
        if (this.stacks.has(chatId)) {
            const stack = this.stacks.get(chatId);
            clearTimeout(stack.timer);
            stack.messages.push(messageBody);

            stack.timer = setTimeout(() => this._execute(chatId, onComplete), this.debounceTime);
            return;
        }

        this.stacks.set(chatId, {
            messages: [messageBody],
            timer: setTimeout(() => this._execute(chatId, onComplete), this.debounceTime)
        });
    }

    _execute(chatId, onComplete) {
        const stack = this.stacks.get(chatId);
        if (!stack) return;

        const fullContent = stack.messages.join(' ');
        this.stacks.delete(chatId);
        onComplete(fullContent);
    }
}

module.exports = MessageStack;
