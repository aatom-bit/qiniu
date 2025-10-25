const { spawn } = require('child_process');
const readline = require('readline');
const { randomUUID } = require('crypto');
const EventEmitter = require('events');
const process = require('process');
const pty = require('@lydell/node-pty');

function parseCommands(commands) {
    if (!commands || typeof commands !== 'string') {
        return [];
    }
    
    const lines = [];
    let currentLine = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let escapeNext = false;
    
    for (let i = 0; i < commands.length; i++) {
        const char = commands[i];
        
        if (escapeNext) {
            // 处理转义字符
            currentLine += char;
            escapeNext = false;
            continue;
        }
        
        switch (char) {
            case '\\':
                // 转义字符，下一个字符按字面意思处理
                escapeNext = true;
                currentLine += char;
                break;
                
            case "'":
                if (!inDoubleQuote) {
                    inSingleQuote = !inSingleQuote;
                }
                currentLine += char;
                break;
                
            case '"':
                if (!inSingleQuote) {
                    inDoubleQuote = !inDoubleQuote;
                }
                currentLine += char;
                break;
                
            case '\n':
                if (inSingleQuote || inDoubleQuote) {
                    // 在引号内的换行符，作为命令的一部分
                    currentLine += char;
                } else {
                    // 真正的命令分隔符
                    if (currentLine.trim() !== '') {
                        lines.push(currentLine.trim());
                    }
                    currentLine = '';
                }
                break;
                
            case '\r':
                // 忽略回车符，等待换行符
                break;
                
            default:
                currentLine += char;
                break;
        }
    }
    
    // 处理最后一行
    if (currentLine.trim() !== '') {
        lines.push(currentLine.trim());
    }
    
    return lines;
}

class AdvancedTerminal extends EventEmitter{
    constructor(getPasswordEvent) {
        super();
        this.activeProcessId = null;
        this.processes = new Map();
        this.processDoneCallbacks = []; // 命令执行完成回调
        this.processErrorCallbacks = []; // 命令错误回调
        this.history = [];
        this.setupReadline();
        this.showWelcome();

        this.getPasswordFromExternal = getPasswordEvent; // 读取密码的接口、

        // WARN: 作为接口时设为false
        this.getPasswordFromConsole = true;
    }

    setupReadline() {
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: this.getPrompt(),
            historySize: 100
        });

        this.rl.on('line', (input) => this.handleInput(input));
        this.rl.on('close', () => this.cleanup());
    }

    getPrompt() {    
        if (this.activeProcessId) {
            if (!this.processes.get(this.activeProcessId).userInputEnabled) {
                return '⏳ 进程执行中... ';
            }
            const procInfo = this.processes.get(this.activeProcessId);
            const procName = procInfo ? this.truncateCommand(procInfo.command) : 'unknown';
            return `🔵 PROC[${this.activeProcessId}]> `;
        }
        return '🟢 MAIN> ';
    }

    truncateCommand(command, length = 15) {
        return command.length > length ? command.substring(0, length) + '...' : command;
    }

    updatePrompt() {
        this.rl.setPrompt(this.getPrompt());
        this.rl.prompt();
    }

    showWelcome() {
        console.log('🌟 终端控制器初始化完成');
        console.log('可用命令:');
        console.log('  <command>          - 执行系统命令');
        console.log('  use <pid>          - 选择进程执行后续命令');
        console.log('  ps                 - 查看管理的进程');
        console.log('  ps active          - 查看活跃进程状态');
        console.log('  kill <pid>         - 终止指定进程');
        console.log('  attach <pid>       - 附加到运行中进程的IO');
        console.log('  detach             - 从进程分离');
        console.log('  history            - 查看命令历史');
        console.log('  clear              - 清屏');
        console.log('  exit               - 退出终端\n');
        this.rl.prompt();
    }

    // 设置用户输入状态
    setUserInputEnabled(processId, enabled) {
        var processStatus = this.processes.get(processId);
        if (processStatus) {
            processStatus.userInputEnabled = enabled;
            this.updatePrompt();
        }
    }

    async handleInput(input) {
        const command = input.trim();
        
        if (!command) {
            this.rl.prompt();
            return;
        }

        // 添加到历史记录
        this.history.push({ command, timestamp: new Date() });
        await this.processCommand(command);
    }

    // 处理内置命令
    async processCommand(command) {
        const args = command.split(' ');
        const mainCommand = args[0].toLowerCase();
        
        switch (mainCommand) {
        case 'exit':
            this.cleanup();
            return;
        case 'ps':
            this.listProcesses();
            return;
        case 'clear':
            console.clear();
            this.showWelcome();
            return;
        case 'use':
            this.switchProcess(args[1]);
            return;
        case 'kill':
            this.killProcess(args[1]);
            return;
        default:
            await this.executeCommand(command);
        }
    }

    // 执行命令, 建议使用这个api
    async executeCommand(command, processId = null) {
        if (processId) {
            // 如果当前运行的id就是指定进程id时
            if (this.activeProcessId === processId) {
                return await this.executeInActiveProcess(command);
            }

            let processInfo = this.processes.get(processId);
            if (processInfo) {
                // 已经存在目标进程id
                return await this.executeInProcess(command, processId);
            }
            // 否则创建新进程
            return await this.createNewProcess(command, processId);
        }

        // 如果有活跃进程，在指定进程中执行
        if (this.activeProcessId) {
            await this.executeInActiveProcess(command);
        } else {
            await this.createNewProcess(command);
        }
    }

    // 在指定进程中执行命令
    executeInProcess = async (processId, command, forceDrive = false) => {
        command = command.trim();
        if (!command) {
            return;
        }

        const procInfo = this.processes.get(processId);
        if (!procInfo || !procInfo.process) {
            console.log(`❌ 进程 ${processId} 不存在或已终止`);
            processId = null;
            this.updatePrompt();
            return;
        }

        if (procInfo.status !== 'running') {
            console.log(`❌ 进程 ${processId} 已终止`);
            processId = null;
            this.updatePrompt();
            return;
        }

        // 如果用户输入被禁用，将命令加入队列
        if (!(forceDrive || procInfo.userInputEnabled)) {
            procInfo.pendingCommands.push(command);
            console.log(`⏸️  命令已加入队列，当前队列: ${procInfo.pendingCommands.length}`); 
            return;
        }

        // 重置命令输出状态
        procInfo.expectingCommandOutput = true;
        procInfo.commandOutputBuffer = '';
        procInfo.isWaitingForConfirmation = false; // 新增：等待确认状态

        // 检查是否含有管理员命令
        let hasSudoCommand = false;
        let commandLines = parseCommands(command);
        
        for (const c of commandLines) {
            if (c.trim().startsWith('sudo')) {
                hasSudoCommand = true;
                break;
            }
        }

        // 如果是sudo命令且尚未验证权限，预先获取权限
        if (hasSudoCommand && !procInfo.allow) {
            console.log(`🔐 检测到sudo命令，预先获取权限: ${command}`);
            
            try {
                const password = await this.fetchPassword(`进程 ${processId} 需要sudo权限执行: ${command}`);
                
                if (password) {
                    procInfo.allow = true;
                    console.log('✅ 已获取sudo权限');
                } else {
                    console.log('❌ 未获取sudo权限，命令取消');
                    return;
                }
            } catch (error) {
                console.log(`❌ 获取密码失败: ${error.message}`);
                return;
            }
        }

        // 检查权限（包括非sudo命令的情况）
        if (hasSudoCommand && !procInfo.allow) {
            console.log(`❌ 未获取命令权限，已阻止命令`);
            return; 
        }

        console.log(`🔧 [${processId}] 执行: ${command}`);

        // 禁用用户输入
        this.setUserInputEnabled(processId, false);

        // 存储当前命令用于完成提醒
        procInfo.lastCommand = command;
        
        // 重置状态
        procInfo.expectingCommandOutput = true;
        procInfo.commandComplete = false;
        
        // 向进程发送命令
        if (procInfo.pty) {
            procInfo.process.write(command + '\r\n');
        } else {
            procInfo.process.stdin.write(command + '\n');
        }
        
        // 刷新记录
        procInfo.processesOutput = '';

        return new Promise((resolve) => {
            const timeoutId = setTimeout(() => {
                procInfo.removeListener('command_complete', onComplete);
                console.log('\n⏰ 命令执行超时，但进程仍在运行');
                this.notifyCommandCompletion(processId, procInfo, command, 'timeout');
                resolve();
            }, 300000); // 5分钟超时

            const onComplete = (output = '') => {
                clearTimeout(timeoutId);
                this.notifyCommandCompletion(processId, procInfo, command, 'completed');
                resolve();
            };

            procInfo.once('command_complete', onComplete);
        });
    }

    // 在活跃进程中执行命令
    async executeInActiveProcess(command) {
        return this.executeInProcess(this.activeProcessId, command);
    }
    
    // 创建新进程执行命令
    async createNewProcess(command, processId_ = null) {
        command = command.trim();
        if (!command) {
            return;
        }

        const processId = processId_ ? processId_ : this.generateProcessId();
        console.log(`\n🚀 创建新进程 ${processId}: ${command}`);

        // 创建PTY进程
        const ptyProcess = this.createPtyProcess(command);
        
        // 初始化进程信息
        const procInfo = this.initializeProcessInfo(ptyProcess, command, processId);
        
        // 设置事件监听器
        this.setupPtyEventListeners(ptyProcess, procInfo, processId, command);
        
        // 设置为活跃进程
        this.activeProcessId = processId;
        this.updatePrompt();

        return this.waitForCommandCompletion(procInfo, processId, command);
    }

    // 改进的shell提示符检测
    isShellPrompt(output) {
        const promptPatterns = [
            /\$$/, // bash提示符
            /#\s*$/, // root提示符
            />\s*$/, // 其他shell提示符
            /\[.*\]\s*[$#]\s*$/, // 带路径的提示符
            /[\w]+@[\w]+:[~/].*[$#]\s*$/, // user@host:path提示符
            /bash-\d+\.\d+[#$]\s*$/, // bash版本提示符
            /\\n.*[$#]\s*$/ // 包含换行的提示符
        ];
        
        const lines = output.split('\n');
        const lastLine = lines[lines.length - 1].trim();
        
        for (const pattern of promptPatterns) {
            if (pattern.test(lastLine)) {
                return true;
            }
        }
        
        return false;
    }

    waitForCommandCompletion(procInfo, processId, command) {
        return new Promise((resolve) => {
            const timeoutId = setTimeout(() => {
                procInfo.removeListener('command_complete', onComplete);
                console.log('\n⏰ 命令执行超时');
                if (procInfo.process && !procInfo.process.killed) {
                    procInfo.process.kill();
                }
                resolve();
            }, 300000);

            const onComplete = (result) => {
                clearTimeout(timeoutId);
                resolve(result);
            };

            procInfo.once('command_complete', onComplete);
        });
    }

    handlePtyProcessExit(ptyProcess, procInfo, processId, exitCode, outputBuffer) {
        procInfo.status = 'exited';
        procInfo.exitCode = exitCode;
        procInfo.endTime = new Date();
        procInfo.duration = procInfo.endTime - procInfo.startTime;
        procInfo.commandComplete = true;

        console.log(`\n🎯 进程执行完成 (退出码: ${exitCode})`);
        
        procInfo.emit('command_complete', {
            output: outputBuffer,
            exitCode: exitCode
        });

        this.notifyProcessCompletion(processId, procInfo, exitCode);

        if (this.activeProcessId === processId) {
            this.activeProcessId = null;
            this.updatePrompt();
        }
    }

    handlePtyCommandComplete(procInfo, outputBuffer, processId) {
        // 防止重复触发
        if (procInfo.commandComplete) {
            console.log(`⚠️ 命令已完成，跳过重复触发`);
            return;
        }
        
        console.log(`🔄 设置命令完成状态`);
        procInfo.commandComplete = true;
        procInfo.expectingCommandOutput = false;
        
        setTimeout(() => {
            console.log(`🎯 命令执行完成，重新启用用户输入`);
            procInfo.emit('command_complete', {
                output: outputBuffer,
                exitCode: 0
            });
            this.setUserInputEnabled(processId, true);
            this.updatePrompt();
        }, 100);
    }


    generateConfirmationResponse(data) {
        if (data.includes('[Y/n]')) {
            return { command: 'y\r\n', message: '✅ 已自动选择: Yes (Y/n)' };
        } else if (data.includes('[y/N]')) {
            return { command: 'y\r\n', message: '✅ 已自动选择: Yes (y/N)' };
        } else if (data.includes('(yes/no)')) {
            return { command: 'yes\r\n', message: '✅ 已自动选择: yes' };
        } else {
            return { command: 'y\r\n', message: '✅ 已自动选择默认确认' };
        }
    }

    async handleConfirmationPrompt(ptyProcess, procInfo, data) {
        procInfo.isWaitingForConfirmation = true;
        console.log('\n🤔 检测到交互式确认提示，自动选择继续...');
        
        return new Promise((resolve) => {
            setTimeout(() => {
                if (procInfo.status !== 'running') {
                    procInfo.isWaitingForConfirmation = false;
                    resolve();
                    return;
                }
                
                const response = this.generateConfirmationResponse(data);
                ptyProcess.write(response.command);
                console.log(response.message);
                
                procInfo.isWaitingForConfirmation = false;
                
                // 确认后等待命令完成
                setTimeout(() => {
                    this.setUserInputEnabled(procInfo.processId, true);
                    resolve();
                }, 2000);
                
            }, 1000);
        });
    }

    handlePasswordError(procInfo) {
        console.log('\n❌ 密码错误，请重新获取密码');
        procInfo.isWaitingForPassword = true;
    }

    async handlePasswordPrompt(ptyProcess, procInfo, processId) {
        procInfo.isWaitingForPassword = true;
        procInfo.passwordAttempts++;
        
        if (procInfo.passwordAttempts > 3) {
            console.log('\n❌ 密码尝试次数过多，命令终止');
            ptyProcess.kill();
            return;
        }
        
        console.log('\n🔐 检测到密码输入提示...');
        
        try {
            const password = await this.fetchPassword(`进程 ${processId} 需要sudo权限`);
            
            if (password) {
                ptyProcess.write(password + '\r\n');
                procInfo.isWaitingForPassword = false;
                console.log('⏳ 密码已输入，继续执行...');
            } else {
                console.log('❌ 未获取到密码，命令终止');
                ptyProcess.kill();
            }
        } catch (error) {
            console.log(`❌ 获取密码失败: ${error.message}`);
            ptyProcess.kill();
        }
    }

    async handlePtyInteractiveOutput(ptyProcess, procInfo, processId, data, outputBuffer) {
        // 检测密码提示
        if (this.isPasswordPrompt(data) && !procInfo.isWaitingForPassword) {
            await this.handlePasswordPrompt(ptyProcess, procInfo, processId);
            return;
        }

        // 检测密码错误
        if (this.isPasswordError(data)) {
            this.handlePasswordError(procInfo);
            return;
        }

        // 检测交互式确认提示
        if (this.isConfirmationPrompt(data) && !procInfo.isWaitingForConfirmation) {
            await this.handleConfirmationPrompt(ptyProcess, procInfo, data);
            return;
        }

        // 检测命令完成 - 添加调试信息
        if (procInfo.initialPromptReceived && procInfo.expectingCommandOutput) {
            console.log(`🔍 检查命令完成状态...`);
            if (this.isPtyCommandComplete(data, procInfo)) {
                console.log(`🎯 触发命令完成事件`);
                this.handlePtyCommandComplete(procInfo, outputBuffer, processId);
            }
        }
    }

    handleInitialPrompt(ptyProcess, procInfo, processId, command) {
        setTimeout(() => {
            console.log(`\n🔧 [${processId}] 执行命令: ${command}`);
            ptyProcess.write(command + '\r\n');
            procInfo.userInputEnabled = false;
            procInfo.initialPromptReceived = true;
            procInfo.expectingCommandOutput = true;  // 开始期待命令输出
            this.updatePrompt();
        }, 100);
    }

    setupPtyEventListeners(ptyProcess, procInfo, processId, command) {
        let outputBuffer = '';
        let isFirstPrompt = true;

        // PTY 数据输出处理
        ptyProcess.onData(async (data) => {
            outputBuffer += data;
            procInfo.processesOutput += data;
            
            // 实时显示输出
            process.stdout.write(data);

            // 处理初始提示符
            if (isFirstPrompt && this.isShellPrompt(data)) {
                isFirstPrompt = false;
                this.handleInitialPrompt(ptyProcess, procInfo, processId, command);
                return;
            }

            // 处理交互式输出 - 只有在初始提示符已接收后才处理
            if (procInfo.initialPromptReceived) {
                await this.handlePtyInteractiveOutput(ptyProcess, procInfo, processId, data, outputBuffer);
            }
        });

        // 进程退出处理
        ptyProcess.onExit(({ exitCode, signal }) => {
            this.handlePtyProcessExit(ptyProcess, procInfo, processId, exitCode, outputBuffer);
        });
    }

    initializeProcessInfo(ptyProcess, command, processId) {
        const procInfo = {
            process: ptyProcess,
            command,
            startTime: new Date(),
            status: 'running',
            isInteractive: true,
            lastCommand: command,
            userInputEnabled: false,
            pendingCommands: [],
            processesOutput: '',
            allow: true,
            isWaitingForPassword: false,
            passwordAttempts: 0,
            isWaitingForConfirmation: false,
            commandOutputBuffer: '',
            currentCommand: command,
            commandComplete: false,
            pty: true,
            initialPromptReceived: false,
            expectingCommandOutput: false  // 新增：期待命令输出状态
        };

        // 继承 EventEmitter
        Object.setPrototypeOf(procInfo, EventEmitter.prototype);
        EventEmitter.call(procInfo);

        this.processes.set(processId, procInfo);
        return procInfo;
    }

    createPtyProcess(command) {
        if (process.platform === 'win32') {
            return pty.spawn('powershell.exe', ['-NoExit', '-Command', command], {
                name: 'xterm-color',
                cols: 80,
                rows: 30,
                cwd: process.cwd(),
                env: process.env
            });
        } else {
            return pty.spawn('/bin/bash', ['-i'], {
                name: 'xterm-color',
                cols: 80,
                rows: 30,
                cwd: process.cwd(),
                env: process.env
            });
        }
    }

    isPasswordPrompt(data) {
        return data.includes('password') || data.includes('Password:') || data.includes('[sudo]');
    }

    isPasswordError(data) {
        return data.includes('Sorry, try again') || data.includes('incorrect password');
    }

    isPtyCommandComplete(output, procInfo) {
        if (procInfo.isWaitingForPassword || procInfo.isWaitingForConfirmation) {
            return false;
        }

        const lines = output.split('\n');
        const lastLine = lines[lines.length - 1].trim();
        
        console.log(`🔍 检测命令完成 - 最后一行: "${lastLine}"`);
        
        // 简化检测：只要包含 $ 或 # 并且包含用户名@主机名就认为是提示符
        if (lastLine.includes('$') && lastLine.includes('@') && lastLine.includes(':') && procInfo.expectingCommandOutput) {
            console.log(`✅ 检测到简化版命令完成！`);
            return true;
        }
        
        // 或者检测是否包含完整的路径提示符
        if (lastLine.includes('whitedx@WhiteHoleX:') && procInfo.expectingCommandOutput) {
            console.log(`✅ 检测到特定用户命令完成！`);
            return true;
        }
        
        return false;
    }


    async fetchPassword(prompt) {
        if (this.getPasswordFromConsole) {
            // 使用控制台输入方式（原来的方式）
            return await this.getPasswordFromConsoleInput(prompt);
        } else {
            // 使用新的密码获取方式（弹窗等）
            return await this.getPasswordFromExternal(prompt);
        }
    }

    // 控制台密码输入方式
    async getPasswordFromConsoleInput(prompt) {
        return new Promise((resolve) => {
            this.rl.question(`🔒 ${prompt} - 请输入密码: `, (password) => {
                resolve(password);
            });
        });
    }

    // 切换到指定进程
    switchProcess(processId) {
        if (!processId) {
        console.log('❌ 请指定进程ID，使用 "ps" 查看进程列表');
        this.rl.prompt();
        return;
        }

        if (processId === 'main') {
        this.activeProcessId = null;
        console.log('✅ 已返回主终端');
        this.updatePrompt();
        return;
        }

        const procInfo = this.processes.get(processId);
        if (!procInfo) {
        console.log(`❌ 未找到进程: ${processId}`);
        this.rl.prompt();
        return;
        }

        if (procInfo.status !== 'running') {
        console.log(`❌ 进程 ${processId} 已终止，无法选择`);
        this.rl.prompt();
        return;
        }

        this.activeProcessId = processId;
        console.log(`✅ 已切换到进程: ${processId}`);
        console.log(`📝 命令: ${procInfo.command}`);
        // console.log('💡 后续命令将在此进程中执行')
        this.updatePrompt();
    }

    // 附加到运行中进程的IO
    attachToProcess(processId) {
        console.log('📡 开始监听 PTY 进程输出 (按 Ctrl+C 停止监听)...');

        const onData = (data) => {
            process.stdout.write(data);
        };

        const cleanup = () => {
            procInfo.process.removeListener('data', onData);
            process.removeListener('SIGINT', sigintHandler);
            console.log(`\n🔓 已从 PTY 进程 ${processId} 分离`);
            this.rl.prompt();
        };

        const sigintHandler = () => {
            cleanup();
        };

        // 监听 PTY 输出
        procInfo.process.on('data', onData);
        
        // 设置用户输入转发
        const originalWrite = process.stdout.write;
        process.stdout.write = (data) => {
            // 避免循环
            if (!data.includes('🔗') && !data.includes('🔓')) {
                procInfo.process.write(data);
            }
        };

        // 监听 Ctrl+C
        process.on('SIGINT', sigintHandler);

        // 恢复原始 write 函数当分离时
        const originalCleanup = cleanup;
        cleanup = () => {
            process.stdout.write = originalWrite;
            originalCleanup();
        };
    }

    // 从进程分离
    detachFromProcess() {
        if (!this.activeProcessId) {
        console.log('❌ 当前没有附加到任何进程');
        this.rl.prompt();
        return;
        }

        this.activeProcessId = null;
        console.log('✅ 已从进程分离');
        this.updatePrompt();
    }

    // 进程管理功能
    listProcesses(filter = null) {
        if (this.processes.size === 0) {
        console.log('📊 没有运行的进程');
        this.rl.prompt();
        return;
        }

        if (filter === 'active') {
        console.log('\n🎯 活跃进程状态:');
        if (this.activeProcessId) {
            const procInfo = this.processes.get(this.activeProcessId);
            if (procInfo) {
            const duration = Date.now() - procInfo.startTime;
            console.log(`  🔵 ${this.activeProcessId}: ${procInfo.command}`);
            console.log(`     状态: ${procInfo.status}, 运行时间: ${duration}ms`);
            console.log(`     交互式: ${procInfo.isInteractive ? '是' : '否'}`);
            }
        } else {
            console.log('  当前没有活跃进程');
        }
        } else {
        console.log('\n📊 管理的进程:');
        this.processes.forEach((info, pid) => {
            const duration = info.status === 'running' 
            ? Date.now() - info.startTime 
            : info.duration;
            const activeIndicator = pid === this.activeProcessId ? '🔵 ' : '   ';
            const statusIcon = info.status === 'running' ? '🟢' : '🔴';
            console.log(`  ${activeIndicator}${pid}: ${info.command}`);
            console.log(`     ${statusIcon} 状态: ${info.status}, 运行时间: ${duration}ms`);
            console.log(`     📝 交互式: ${info.isInteractive ? '是' : '否'}`);
        });
        }
        this.rl.prompt();
    }

    killProcess(processId) {
        if (!processId) {
        console.log('❌ 请指定进程ID');
        this.rl.prompt();
        return;
        }

        const procInfo = this.processes.get(processId);
        if (procInfo && procInfo.process) {
        procInfo.process.kill();
        console.log(`🛑 已终止进程: ${processId}`);
        
        // 如果终止的是活跃进程，切换回主终端
        if (this.activeProcessId === processId) {
            this.activeProcessId = null;
            this.updatePrompt();
        }
        } else {
        console.log(`❌ 未找到进程: ${processId}`);
        }
        this.rl.prompt();
    }

    // 交互式确认提示检测方法
    isConfirmationPrompt(output) {
        const confirmationPatterns = [
            /Do you want to continue\?.*\[Y\/n\]/i,
            /Continue\?.*\[y\/N\]/i,
            /Proceed\?.*\[y\/N\]/i,
            /Are you sure\?.*\[y\/N\]/i,
            /Confirm.*\[Y\/n\]/i,
            /Do you wish to continue\?/i,
            /This will install.*Continue\?/i,
            /Press.*to continue/,
            /Hit Enter to continue/,
            /Type 'yes' to continue/,
            /Enter YES to continue/i,
            /Do you want to abort\?/i
        ];

        for (const pattern of confirmationPatterns) {
            if (pattern.test(output)) {
                return true;
            }
        }

        return false;
    }

    // 智能命令完成检测方法
    isCommandComplete(output, procInfo) {
        // 如果正在等待密码输入或确认输入，命令未完成
        if (procInfo.isWaitingForPassword || procInfo.isWaitingForConfirmation) {
            return false;
        }

        // 检测命令提示符（表示命令完成）
        if (output.includes('$ ') || output.includes('# ') || output.includes('> ')) {
            const lines = output.split('\n');
            const lastLine = lines[lines.length - 1].trim();
            
            // 确认是真正的命令提示符
            if (lastLine.endsWith('$ ') || lastLine.endsWith('# ') || 
                lastLine.endsWith('> ') || lastLine.match(/^[\w]+@[\w]+:/)) {
                return true;
            }
        }

        // 检测特定的命令结束标记
        if (output.includes('installation completed') || 
            output.includes('Process completed') ||
            output.includes('successfully installed') ||
            output.includes('Setting up') && output.includes('Unpacking') ||
            output.includes('Abort.') || // 新增：检测中止信息
            output.includes('Operation aborted')) {
            return true;
        }

        return false;
    }

    // 命令完成提醒
    async notifyCommandCompletion(processId, procInfo, command, status) {
        const statusIcon = status === 'completed' ? '✅' : '⏰';
        
        let processFinData = `🎯 ${statusIcon} 命令执行完成:\n`;
        processFinData += `   PID: ${processId}\n`;
        processFinData += `   命令: ${command}\n`;
        processFinData += `   状态: ${status === 'completed' ? '完成' : '超时'}\n`;
        
        // 计算命令执行时间
        const currentTime = new Date();
        const duration = currentTime - procInfo.startTime;
        processFinData += `   耗时: ${duration}ms\n`;
        
        console.log('\n' + processFinData);
        
        if (status === 'completed') {
            // 重置所有交互状态
            procInfo.isWaitingForPassword = false;
            procInfo.passwordAttempts = 0;
            procInfo.isWaitingForConfirmation = false;
            procInfo.expectingCommandOutput = false;
            
            // 如果有等待的命令，继续执行
            if (procInfo.pendingCommands.length > 0) {
                const newCommand = procInfo.pendingCommands.shift();
                console.log(`📥 检测到未完成的命令: ${newCommand}, 自动继续执行`);
                await this.executeInProcess(processId, newCommand, true);
            } else {
                // 重新启用用户输入
                this.setUserInputEnabled(processId, true);
                console.log('💡 已重新开启用户输入，可输入下一条命令');
            }
        }

        // 激活回调
        this.processDoneCallbacks.forEach(callback => {
            callback(processId, processFinData);
        });
    }
    
    // 进程完成冒泡通知
    async notifyProcessCompletion(processId, procInfo, exitCode) {
        const statusIcon = exitCode === 0 ? '✅' : '❌';
        const duration = procInfo.duration;
            
        let processFinData = `🎉 ${statusIcon} 进程已结束:\n`;
        processFinData += `   PID: ${processId}\n`;
        processFinData += `   命令: ${procInfo.command}\n`;
        processFinData += `   状态: ${exitCode === 0 ? '成功' : '失败'} (退出码: ${exitCode})\n`;
        processFinData += `   耗时: ${duration}ms\n`;
        
        if (procInfo.processesOutput) {
            const lastOutput = procInfo.processesOutput;
            processFinData += `   输出预览: ${lastOutput}\n`;
        }
        
        console.log('\n' + processFinData);
        // 重新启用用户输入
        this.setUserInputEnabled(processId, true);

        // 激活回调
        this.processDoneCallbacks.forEach(callback => {
            callback(processId, processFinData);
        });
    }

    processDoneCallbacksAddListener(event) {
        if (event) {
            this.processDoneCallbacks.push(event);
        }
    }

    processErrorCallbacksAddListener(event) {
        if (event) {
            this.processErrorCallbacks.push(event);
        }
    }

    getHistory() {
        let res = '';
        this.history.slice(-10).forEach((item, index) => {
        const time = item.timestamp.toLocaleTimeString();
        res += `  ${index + 1}. [${time}] ${item.command}\n`;
        });
        return res;
    }
    showHistory() {
        console.log('\n📜 命令历史:');
        console.log(this.getHistory());
        this.rl.prompt();
    }

    // 自动补全功能
    autoComplete(line) {
        const commands = ['use', 'attach', 'detach', 'ps', 'kill', 'history', 'clear', 'exit'];
        const hits = commands.filter(c => c.startsWith(line));
        return [hits.length ? hits : commands, line];
    }

    // 生成进程ID
    generateProcessId() {
        return randomUUID();
    }

    cleanup() {
        console.log('\n🧹 清理中...');
        
        // 终止所有子进程
        this.processes.forEach((info, pid) => {
        if (info.process && !info.process.killed) {
            info.process.kill();
            console.log(`🛑 终止进程: ${pid}`);
        }
        });

        console.log('👋 再见！');
        this.rl.close();
        process.exit(0);
    }
}

// 启动高级终端
// new AdvancedTerminal();

// 导出供其他模块使用
module.exports = { AdvancedTerminal };