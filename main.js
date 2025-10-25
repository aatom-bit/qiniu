const {app, BrowserWindow, ipcMain} = require('electron');
const path = require('path');
const {Begin, Close} = require('./util/rtasr-ws-node.js');


let mainWin;
let ballWin;

function createMainWindow() {
    mainWin = new BrowserWindow({
        width: 400,
        height: 300,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true
        }
    });

    mainWin.loadFile('./src/index.html');
    // mainWin.webContents.openDevTools({ mode: 'detach' }); // 调试用
}

function createBallWindow(x, y) {
    if (ballWin) return;

    ballWin = new BrowserWindow({
        width: 50,
        height: 50,
        x: x === null ? undefined : x,
        y: y === null ? undefined : y,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: false,
        skipTaskbar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true
        }
    });

    ballWin.loadFile('./src/ball.html');
    ballWin.on('closed', () => {
        ballWin = null;
        mainWin.webContents.send('ball-status', false);
    });
}

app.on('ready', createMainWindow)

app.on('window-all-closed', () => {
    // if (ballWin !== null) ballWin.close();
    // if (mainWin !== null) mainWin.close();
    app.quit();
});

// 监听主窗口按钮事件
ipcMain.on('toggle-ball', (event, show) => {
    if (show) {
        createBallWindow();
    } else {
        if (ballWin) {
            ballWin.close();
            ballWin = null;
        }
    }
});

// 悬浮球拖动逻辑
ipcMain.on('move-window', (event, delta) => {
    if (!ballWin) return;
    const [x, y] = ballWin.getPosition();
    ballWin.setPosition(x + delta.dx, y + delta.dy);
});

// 悬浮球关闭自身
ipcMain.on('close-ball', () => {
    // const [x, y] = ballWin.getPosition()
    if (ballWin) {
        ballWin.close();
        ballWin = null;
    }
    if (mainWin) mainWin.webContents.send('ball-status', false);
});

ipcMain.on('begin', (event, data) => {
    if (data.isBegin) {
        Begin(data.isLongPress)
    } else {
        Close();
    }
});