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

function getSession(history, idx, expand = true, targetRange = -1) {
    if (idx < 0 || !(history || Array.isArray(history))) {
        return null
    }

    if (expand) {
        let target = targetRange > idx + 1 ? targetRange : idx + 1;

        for (let i = history.length;i < target;i++) {
            history.unshift({ title: '新会话', messages: [] })
        }
    } else if (idx >= history.length) {
        return null;
    }
    const session = history[idx];
    return session;
}

module.exports = { saveHistory, loadHistory, initHistory, getSession };