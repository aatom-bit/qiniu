const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { randomUUID } = require('crypto');
const os = require('os');

const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const { Listen, ListenClose } = require('./util/rtasr-ws-node.js');
const { loadHistory, saveHistory, initHistory, getSession } = require('./util/historyStore');
const { containSudoCommand } = require('./AdvancedTerminal.js');
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
        width: 600,
        height: 450,
        minWidth: 400,    // 强制最小宽度，确保侧边栏+对话区有基本空间
        minHeight: 300,
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
        width: 150,
        height: 150,
        x: x === null ? undefined : x,
        y: y === null ? undefined : y,
        frame: false, // 测试时注释这里
        transparent: true,
        alwaysOnTop: true,
        resizable: false,
        skipTaskbar: true,
        hasShadow: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true
        }
    });

    ballWin.loadFile('./src/ball.html');
    ballWin.on('closed', () => {
        ballWin = null;
        // mainWin?.webContents?.send('ball-status', false);
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

    // 1. 明确的代码/脚本语言
    const explicitTechRegex = /\b(python|javascript|java|golang|c\+\+|bash|shell|sh|powershell|sql|html|css|json|yaml|xml|markdown)\b/i;

    // 2. 高权重指令动词（这些词出现，基本就是为了执行命令）
    const highWeightActionRegex = /(安装|卸载|更新|升级|install|uninstall|upgrade|update|apt|yum|pacman|pip|npm|npm|brew)/i;

    // 3. 普通操作动词
    const actionRegex = /(启动|停止|重启|查看|检查|创建|删除|修改|设置|运行|执行|查找|搜索|start|stop|restart|check|show|list|create|remove|delete|edit|set|run|exec|find|grep|search)/i;

    // 4. 系统实体词库
    const systemEntityRegex = /(端口|进程|服务|目录|文件夹|文件|权限|网络|内存|cpu|磁盘|日志|软件|包|依赖|配置|port|process|service|dir|directory|folder|file|permission|network|ip|memory|disk|log|software|package|dep|config)/i;

    // 5. 命令行工具
    const toolRegex = /\b(sudo|systemctl|lsof|netstat|ps|top|htop|df|du|mkdir|cd|pwd|cat|ssh|docker|git|node|python|sh|bash)\b/i;

    // 6. 引导意图词
    const intentRegex = /(怎么|如何|编写|脚本|代码|指令|命令|how to|command|script)/i;

    // --- 决策逻辑 ---

    // A. 包含高权重动词 (如: 安装vlc)
    if (highWeightActionRegex.test(input)) {
        return 'command';
    }

    // B. 包含明确的技术/语言名称
    if (explicitTechRegex.test(input)) {
        return 'command';
    }

    // C. 直接提到系统工具 (如: 用lsof查一下)
    if (toolRegex.test(input)) {
        return 'command';
    }

    // D. 动作 + 实体组合 (如: 查看进程)
    if (actionRegex.test(input) && systemEntityRegex.test(input)) {
        return 'command';
    }

    // E. 意图词 + (动作或实体) (如: 怎么查看端口)
    if (intentRegex.test(input) && (systemEntityRegex.test(input) || actionRegex.test(input))) {
        return 'command';
    }

    // F. 特殊匹配：动作词 + 英文/数字名（处理不在词库里的软件包，如：运行 nginx）
    // 匹配中文动词后面跟着英文单词的模式
    const actionAndUnknownEntity = new RegExp(`${actionRegex.source}[a-z0-9\\s]+`, 'i');
    if (actionAndUnknownEntity.test(input)) {
        return 'command';
    }

    return 'chat';
}

async function getSudoPermission(content) {
    // 如果包含sudo命令，则向用户申请密码(仅需一次)，并返回；否则返回null
    if (containSudoCommand(content)) {
        try {
            const password = await requestPermissionFromMainwindow(mainWin.webContents, {
                type: 'sudo-password',
                message: '执行此命令需要管理员密码'
            });
            return password.output ? password.output : password;
        } catch (error) {
            console.error('获取密码失败:', error);
            return null;
        }
    }
    return null;
}

async function getRunPermission(content) {
    // 显示用户确认执行 content 命令的窗口，返回用户的确认结果
    try {
        const permission = await requestPermissionFromMainwindow(mainWin.webContents, {
            type: 'run-confirmation',
            command: content,
            message: '确认是否执行此命令？'
        });
        return permission === true; // 只有用户点击"执行"才返回 true
    } catch (error) {
        console.error('获取运行权限失败:', error);
        return false;
    }
}

// 存储所有待处理的请求：Map<requestId, { resolve, reject }>
const pendingRequests = new Map();

/**
 * 主进程发起权限请求的函数
 * @param {WebContents} webContents 目标窗口的 webContents
 * @param {Object} data 请求参数（如权限类型）
 * @returns {Promise}
 */
function requestPermissionFromMainwindow(webContents, data) {
    return new Promise((resolve, reject) => {
        const requestId = randomUUID(); // 生成唯一ID，确保并发不冲突

        // 1. 存入 Map
        pendingRequests.set(requestId, { resolve, reject });

        // 2. 发送给前端
        webContents.send('ask-for-permission', { requestId, ...data });

        // 可选：设置超时，防止渲染进程不响应导致内存泄漏
        setTimeout(() => {
            if (pendingRequests.has(requestId)) {
                pendingRequests.delete(requestId);
                reject(new Error('Permission request timed out'));
            }
        }, 60000); // 60秒超时
    });
}

// --- 系统适配逻辑 ---
let sysInfo = {
    flavor: 'debian', // 默认 debian
    commands: {}
};

// 定义不同系统的命令模板
const PkgConfigs = {
    debian: {
        list: "dpkg-query -W -f='${Package}|${Version}|${Description}\n'",
        search: (q) => `apt-cache search "${q}" | head -n 100`,
        info: (n) => `apt-cache show ${n}`,
        install: (n) => `sudo apt-get install -y ${n}`,
        remove: (n) => `sudo apt-get remove -y ${n}`,
        parseList: (line) => {
            const [name, version, desc] = line.split('|');
            return { name, version, description: desc?.split('\n')[0] };
        }
    },
    redhat: {
        list: "rpm -qa --queryformat '%{NAME}|%{VERSION}|%{SUMMARY}\n'",
        search: (q) => `dnf search "${q}" | grep ":" | head -n 100`, // dnf 或 yum
        info: (n) => `dnf info ${n}`,
        install: (n) => `sudo dnf install -y ${n}`,
        remove: (n) => `sudo dnf remove -y ${n}`,
        parseList: (line) => {
            const [name, version, desc] = line.split('|');
            return { name, version, description: desc };
        }
    },
    arch: {
        list: "pacman -Q",
        search: (q) => `pacman -Ss "${q}" | grep "^[a-z]" | head -n 100`,
        info: (n) => `pacman -Si ${n}`,
        install: (n) => `sudo pacman -S --noconfirm ${n}`,
        remove: (n) => `sudo pacman -R --noconfirm ${n}`,
        parseList: (line) => {
            const parts = line.split(' ');
            return { name: parts[0], version: parts[1], description: 'Arch Package' };
        }
    }
};

// 自动检测系统发行版
async function detectDistro() {
    try {
        const { stdout } = await execPromise('cat /etc/os-release');
        if (/ID(_LIKE)?=.*(ubuntu|debian)/i.test(stdout)) {
            sysInfo.flavor = 'debian';
        } else if (/ID(_LIKE)?=.*(centos|fedora|rhel)/i.test(stdout)) {
            sysInfo.flavor = 'redhat';
        } else if (/ID(_LIKE)?=.*(arch)/i.test(stdout)) {
            sysInfo.flavor = 'arch';
        }
        sysInfo.commands = PkgConfigs[sysInfo.flavor];
        console.log(`检测到系统类型: ${sysInfo.flavor}`);
    } catch (e) {
        console.error('无法确定发行版，默认使用 Debian 模式');
        sysInfo.commands = PkgConfigs['debian'];
    }
}

ipcMain.handle('pkg:getInstalled', async () => {
    try {
        const { stdout } = await execPromise(sysInfo.commands.list);
        if (!stdout) return [];

        const rawLines = stdout.trim().split('\n');

        // 过滤掉空对象
        const allParsed = rawLines
            .map(line => sysInfo.commands.parseList(line))
            .filter(pkg => pkg && pkg.name);

        // 使用 Map 进行去重
        const uniqueMap = new Map();
        for (const pkg of allParsed) {
            // 如果 Map 中还没有这个包，则添加
            // 这样如果是多架构包（如 libc6 和 libc6:i386），只会保留第一个出现的
            if (!uniqueMap.has(pkg.name)) {
                uniqueMap.set(pkg.name, pkg);
            }
        }
        return Array.from(uniqueMap.values())
            .sort((a, b) => a.name.localeCompare(b.name));
            
    } catch (error) {
        console.error('获取安装包列表异常:', error);
        return [];
    }
});

ipcMain.handle('pkg:search', async (event, query) => {
    try {
        const { stdout } = await execPromise(sysInfo.commands.search(query));
        // 简单的通用解析：由于搜索输出格式各异，这里进行模糊处理
        return stdout.trim().split('\n').map(line => {
            const name = line.split(/[ \/]/)[0]; // 取第一个单词或斜杠前的部分
            return { name, description: line };
        });
    } catch (error) { return []; }
});

ipcMain.handle('pkg:getInfo', async (event, pkgName) => {
    try {
        const { stdout } = await execPromise(sysInfo.commands.info(pkgName));
        return stdout;
    } catch (error) { return "无法获取详情"; }
});

ipcMain.handle('pkg:install', async (event, pkgName) => {
    return sysInfo.commands.install(pkgName);
});

ipcMain.handle('pkg:remove', async (event, pkgName) => {
    return sysInfo.commands.remove(pkgName);
});

// 提供给前端显示当前使用的是哪个包管理器
ipcMain.handle('pkg:getManagerName', () => {
    const managers = { debian: 'APT (dpkg)', redhat: 'DNF (rpm)', arch: 'Pacman' };
    return managers[sysInfo.flavor];
});

// 监听渲染进程的回执
ipcMain.on('permission-response', (event, { requestId, result }) => {
    const request = pendingRequests.get(requestId);
    if (request) {
        request.resolve(result); // 触发 Promise 成功
        pendingRequests.delete(requestId); // 及时清理
    }
});

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

            // 直接调用 consoleAssignTask，由 ConsoleAssistant 处理所有权限和执行逻辑
            aiFinalContent = await consoleAssistant.consoleAssignTask(sessionId, content);
        } else {
            // 纯聊天内容
            let ret = await consoleAssistant.normalConversation(content);
            aiFinalContent = ret ? ret : `ai agent发生错误`;
        }
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
    return `任务 ${isCompelted ? '已完成' : '执行失败'}`;
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
        mainWin.hide();
        // if (mainWin.isFocused()) {
        //     mainWin.hide(); // 如果已经可见且聚焦，则隐藏
        // } else {
        //     mainWin.focus(); // 如果可见但没聚焦，则聚焦到最前
        // }
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

// 删除会话
ipcMain.handle('chat:deleteSession', (event, sessionId) => {
    if (sessionId >= 0 && sessionId < chatHistory.length) {
        chatHistory.splice(sessionId, 1);
        saveHistory(chatHistory);
        return { success: true };
    }
    return { success: false };
});

// 创建新会话
ipcMain.handle('chat:createSession', (event) => {
    const newSession = { title: '新会话', messages: [] };
    chatHistory.unshift(newSession);
    saveHistory(chatHistory);
    return { success: true, sessionId: 0 };
});

// 执行脚本
ipcMain.handle('terminal:run', async (event, command, sessionId) => {
    console.log("正在执行脚本:", command);
    // 使用你已有的 AdvancedTerminal 执行命令
    const result = await consoleAssistant.directRun(command, sessionId);

    return result;
});

// 获取系统资源占用情况
ipcMain.handle('get-system-stats', async (event) => {
    try {
        const cpus = os.cpus();
        const totalMemory = os.totalmem();
        const freeMemory = os.freemem();
        const usedMemory = totalMemory - freeMemory;
        const memoryPercent = Math.round((usedMemory / totalMemory) * 100);

        // 计算CPU使用率（简单方法：获取平均负载）
        const loadavg = os.loadavg();
        const cpuPercent = Math.round((loadavg[0] / cpus.length) * 100);

        return {
            cpu: `${Math.min(cpuPercent, 100)}%`,
            ram: `${memoryPercent}%`
        };
    } catch (error) {
        console.error('获取系统信息失败:', error);
        return { cpu: 'N/A', ram: 'N/A' };
    }
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
let currentListenPromise = null;

// 长按悬浮球自动录音并处理
ipcMain.on('quick-listen', async (event, data) => {
    if (data.isBegin) {
        // 开始录音
        if (listenProcessing) return;
        listenProcessing = true;
        mainWin.webContents.send('update-status', { role: 'ai', content: '正在聆听...' });

        // 立即启动 Listen，不要等待
        currentListenPromise = Listen(data.isLongPress);
    } else if (data.isLongPress) {
        // 停止录音并发送识别
        if (!listenProcessing) return;

        ListenClose();

        // 等待识别结果
        try {
            const text = await currentListenPromise;
            if (!text) {
                listenProcessing = false;
                return;
            }

            // 将识别结果填充到输入框
            mainWin.webContents.send('update-status', { role: 'voice-input', content: text });
        } catch (error) {
            console.error('ASR 识别出错:', error);
        } finally {
            listenProcessing = false;
            currentListenPromise = null;
        }
    } else {
        // 取消录音（少于500ms）
        if (!listenProcessing) return;

        ListenClose();
        listenProcessing = false;
        currentListenPromise = null;
    }
});

// 渲染窗口
app.on('ready', () => {
    detectDistro(); //检测发行版本
    createMainWindow();
    // 为 ConsoleAssistant 注入权限请求函数（此时 mainWin 已创建）
    consoleAssistant.setPermissionRequester((data) => requestPermissionFromMainwindow(mainWin.webContents, data));
});

app.on('window-all-closed', () => {
    // if (ballWin !== null) ballWin.close();
    // if (mainWin !== null) mainWin.close();
    app.quit();
});