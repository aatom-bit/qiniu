const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { Listen, ListenClose } = require('./util/rtasr-ws-node.js');
const { loadHistory, saveHistory, initHistory, getSession } = require('./util/historyStore');
const { ConsoleAssistant } = require('./consoleAssistant');

// 代替默认终端输出，自动保存为log
const log = require('electron-log');
console.log = log.info;
console.error = log.error;

process.env.PYTHONIOENCODING = 'utf-8';
process.env.PYTHONLEGACYWINDOWSSTDIO = 'utf-8';

// 不要使用gpu
app.commandLine.appendSwitch('disable-gpu');

// 内存中的历史记录
initHistory();
let chatHistory = loadHistory();

let mainWin;
let ballWin;

// 创建终端ai助手
const consoleAssistant = new ConsoleAssistant();
// 保存前端当前的Session信息
const sessionInfo = {
    sessionId: 0,
};

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

    // 让隐藏不等于退出
    mainWin.on('close', (event) => {
        event.preventDefault();
        mainWin.hide();
    });
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
        mainWin?.webContents.send('ball-status', false);
    });
}

/**
 * 判断用户意图
 * @param {string} content 用户输入的原始文本
 * @returns {string} "command" (执行脚本/代码) 或 "chat" (一般对话)
 */
function getAiDecision(content) {
    if (!content || typeof content !== 'string') return 'chat';

    const input = content.trim().toLowerCase();

    // 1. 明确包含编程语言或脚本术语的正则
    const explicitTechRegex = /\b(python|javascript|java|golang|c\+\+|bash|shell|sh|powershell|sql|html|css|json|yaml|xml|markdown)\b/i;

    // 2. 常见的 Linux 操作动词 (安装、卸载、启动、查看等)
    const actionRegex = /(安装|卸载|启动|停止|重启|查看|检查|创建|删除|修改|设置|运行|执行|查找|搜索|install|uninstall|start|stop|restart|check|show|list|create|remove|delete|edit|set|run|exec|find|grep|search)/i;

    // 3. 典型的 Linux 系统实体 (端口、进程、文件、目录、权限等)
    const systemEntityRegex = /(端口|进程|服务|目录|文件夹|文件|权限|网络|内存|cpu|磁盘|日志|软件|包|依赖|port|process|service|dir|directory|folder|file|permission|chmod|chown|network|ip|memory|disk|log|software|package|dep)/i;

    // 4. 特定的 Linux 命令行工具名称
    const toolRegex = /\b(sudo|apt|yum|dnf|pacman|systemctl|lsof|netstat|ps|top|htop|df|du|mkdir|cd|pwd|cat|ssh|docker|git|npm|pip|node)\b/i;

    // 决策逻辑：
    // A. 如果包含明确的代码/脚本术语 -> command
    // B. 如果同时包含 [操作动词] 和 [系统实体] -> command (例如: "查看进程")
    // C. 如果直接提到了某个 Linux 命令工具 -> command (例如: "用 lsof 查一下")
    // D. 如果包含 "怎么写"、"如何实现"、"脚本"、"指令" 等引导词 -> command
    const intentRegex = /(怎么|如何|编写|脚本|代码|指令|命令|代码|how to|command|script)/i;

    if (
        explicitTechRegex.test(input) || 
        toolRegex.test(input) || 
        (actionRegex.test(input) && systemEntityRegex.test(input)) ||
        (intentRegex.test(input) && (systemEntityRegex.test(input) || actionRegex.test(input)))
    ) {
        return 'command';
    }

    // 5. 默认判定为一般对话
    return 'chat';
}

/**
 * 处理用户输入并同步历史记录
 * @param {string} content 用户输入的文本
 * @param {number} sessionId 当前会话索引
 */
async function handleUserInput(content, sessionId, sessionCount = -1) {
    const decision = getAiDecision(content); // 之前写的意图识别函数
    const session = getSession(chatHistory, sessionId, true, sessionCount);
    
    // 1. 先把用户的提问存入历史记录
    session.messages.push({ role: 'user', content: content });

    var aiFinalContent = ""; // 用于最终保存的 AI 回复内容

    try {
        if (decision === 'command') {
            // 状态通知：让前端知道正在开始执行
            mainWin.webContents.send('update-status', { role: 'ai', content: `🚀 正在准备执行相关指令...` });

            // TODO：这里不该直接执行命令，应该让用户先看一下命令，然后ai提示该命令的作用和风险，然后用户进行确认和取消
            // 执行命令逻辑
            let ret = await consoleAssistant.consoleAssignTask(0, content);
            
            let output = ret?.output;
            if (output) {
                // 整理输出结果：如果是 shell，通常用代码块包裹
                aiFinalContent = `任务执行结果：\n\`\`\`sh\n${output || '无输出'}\n\`\`\``;
            } else {
                aiFinalContent = `ai agent错误, 执行失败`;
            }
            
        } else {
            // 纯聊天内容
            let ret = await consoleAssistant.normalConversation(content);
            aiFinalContent = ret ? ret : `ai agent发生错误`;
        }
        // TTS 播报结果
            // const ttsBuffer = await getTTSVoice(`执行完毕。${aiFinalContent.substring(0, 50)}`);
            // await playAudio(ttsBuffer);
    } catch (error) {
        aiFinalContent = `❌ 发生错误: ${error.message}`;
    }

    // 2. 将 AI 的最终回复存入历史记录
    session.messages.push({ role: 'assistant', content: aiFinalContent });

    // 3. 如果是会话的第一条消息，自动生成标题
    if (session.messages.length <= 2) {
        session.title = content.substring(0, 15) + (content.length > 15 ? "..." : "");
    }

    // 4. 核心：持久化到 chat_history.json
    saveHistory(chatHistory);

    // 5. 通知前端更新（两种方式：通过 IPC 发送，或通过 handle 的返回值）
    // 这里直接发送，让前端逻辑更统一
    mainWin.webContents.send('chat:ai-response', { 
        role: 'assistant', 
        content: aiFinalContent,
        sessionId: sessionId 
    });

    return aiFinalContent;
}

function onCommandFinished(isCompelted, consoleNum) {
    return `任务 ${ isCompelted ? '已完成' : '执行失败'}`;
}
consoleAssistant.taskCompleteCallbackAddlistener(onCommandFinished.bind(this));

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

ipcMain.on('toggle-main-window', () => {
    if (!mainWin) return;

    if (mainWin.isVisible()) {
        if (mainWin.isFocused()) {
            mainWin.hide(); // 如果已经可见且聚焦，则隐藏
        } else {
            mainWin.focus(); // 如果可见但没聚焦，则聚焦到最前
        }
    } else {
        mainWin.show(); // 如果隐藏，则显示
    }
});

ipcMain.handle('chat:session-switch', (sessionId) => {
    sessionInfo.sessionId = sessionId;
});

// 处理 AI 消息
ipcMain.handle('chat:send', async (event, { text, sessionId, sessionCount }) => {
    var result = '';
    try {
        // 对话逻辑
        const ret = await handleUserInput(text, sessionId, sessionCount);
        result = ret.output ? ret.output : ret;
    } catch (error) {
        console.log(`chat:send in main.js 异常: ${error}`);
        result = `获取ai助手执行结果失败, error: ${error}`;
    }
    return result;
});

// 获取历史
ipcMain.handle('chat:getHistory', () => chatHistory);

// 执行脚本
ipcMain.handle('terminal:run', async (event, command) => {
    console.log("正在执行脚本:", command);
    // 使用你已有的 AdvancedTerminal 执行命令
    const result = await consoleAssistant.directRun(command);

    return result;
});

ipcMain.handle('get-window-position', (event) => {
    if (!ballWin) return;
    const [x, y] = ballWin.getPosition()
    return { x, y }
})

ipcMain.on('window-drag', (event, position) => {
    if (!ballWin) return;
    ballWin.setPosition(position.x, position.y)
})

// 悬浮球关闭自身
ipcMain.on('close-ball', () => {
    if (ballWin) {
        ballWin.close();
        ballWin = null;
    }
    if (mainWin) mainWin.webContents.send('ball-status', false);
});

let listenProcessing = false;
// 长按悬浮球自动录音并处理
ipcMain.on('quick-listen', async (event, data) => {
    if (data.isBegin) {
        if (listenProcessing) return;
        listenProcessing = true;
        mainWin.webContents.send('update-status', { role: 'ai', content: '正在聆听...' });
        
        // 1. ASR 识别
        const text = await Listen(data.isLongPress); 
        if (!text) return;
        
        mainWin.webContents.send('update-status', { role: 'user', content: text });

        // 直接将用户输入的文本交由ai处理
        await handleUserInput(text, sessionInfo.sessionId);
    } else {
        ListenClose();
        listenProcessing = false;
    }
});

app.on('ready', () => {
    createMainWindow();
});

app.on('window-all-closed', () => {
    // if (ballWin !== null) ballWin.close();
    // if (mainWin !== null) mainWin.close();
    app.quit();
});