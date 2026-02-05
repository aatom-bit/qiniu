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

module.exports = { saveHistory, loadHistory, initHistory };