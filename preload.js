const {contextBridge, ipcRenderer} = require('electron');

// 暴露一个安全接口给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
    toggleBall: (show) => ipcRenderer.send('toggle-ball', show),
    getWindowPosition: () => ipcRenderer.invoke('get-window-position'),
    dragWindow: (position) => ipcRenderer.send('window-drag', position),
    toggleMainWindow: () => ipcRenderer.send('toggle-main-window'),
    onBallStatus: (callback) => ipcRenderer.on('ball-status', (event, exists) => callback(exists)),
    QuickListen: (isLongPress, isBegin) => ipcRenderer.send('quick-listen', {isLongPress: isLongPress, isBegin: isBegin}),
    onUpdateStatus: (callback) => {
        // 接收主进程的返回
        ipcRenderer.on('update-status', callback)
    },
    sessionSwitch: (sessionId) => ipcRenderer.invoke('chat:session-switch', sessionId),
    sendMessage: (msg) => ipcRenderer.invoke('chat:send', msg),
    getHistory: () => ipcRenderer.invoke('chat:getHistory'),
    runCommand: (cmd) => ipcRenderer.invoke('terminal:run', cmd),
    onAiResponse: (callback) => ipcRenderer.on('chat:ai-response', callback),
});

// // 如果需要控制窗口移动或关闭，也可以暴露：
// contextBridge.exposeInMainWorld('electronWindow', {
//     moveWindow: (win, dx, dy) => {
//         const [x, y] = win.getBounds();
//         win.setBounds({x: x + dx, y: y + dy, width: win.getBounds().width, height: win.getBounds().height});
//     },
//     closeWindow: (win) => win.close()
// });
