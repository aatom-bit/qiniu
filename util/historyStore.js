const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const historyPath = path.join(app.getPath('userData'), 'chat_history.json');

function saveHistory(history) {
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
}

function loadHistory() {
    if (!fs.existsSync(historyPath)) return [];
    try {
        const parsed = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
        return Array.isArray(parsed) ? parsed : [parsed];
    } catch (e) {
        return [];
    }
}

function initHistory() {
    if (!fs.existsSync(historyPath)) {
        saveHistory([]);
    }
}

function getSession(history, idx, expand = true) {
    if (idx < 0 || !(history || Array.isArray(history))) {
        return null
    }

    if (expand && idx >= history.length) {
        let range = idx + 1 - history.length; 
        for (let i = 0;i < range;i++) {
            history.unshift({ title: '新会话', messages: [] })
        }
    }
    const session = history[idx];
    return session;
}

module.exports = { saveHistory, loadHistory, initHistory, getSession };