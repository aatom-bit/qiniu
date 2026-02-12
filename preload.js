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
    createSession: () => ipcRenderer.invoke('chat:createSession'),
    deleteSession: (sessionId) => ipcRenderer.invoke('chat:deleteSession', sessionId),
    runCommand: (cmd, sessionId) => ipcRenderer.invoke('terminal:run', cmd, sessionId),
    onAiResponse: (callback) => ipcRenderer.on('chat:ai-response', (_event, group) => callback(group)),
    // 监听主进程的权限请求
    onAskPermission: (callback) => ipcRenderer.on('ask-for-permission', (_event, value) => callback(value)),
    // 发送回复给主进程
    sendPermissionResponse: (response) => ipcRenderer.send('permission-response', response),
    // 获取系统资源占用情况
    getSystemStats: () => ipcRenderer.invoke('get-system-stats')
    
    // // 如果需要控制窗口移动或关闭，也可以暴露：
    //     moveWindow: (win, dx, dy) => {
    //         const [x, y] = win.getBounds();
    //         win.setBounds({x: x + dx, y: y + dy, width: win.getBounds().width, height: win.getBounds().height});
    //     },
    //     closeWindow: (win) => win.close()
});
