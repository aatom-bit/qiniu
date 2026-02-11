const { Conversation } = require("./conversation");
const { AdvancedTerminal } = require("./AdvancedTerminal");

// 代替默认终端输出，自动保存为log
const log = require('electron-log');
console.log = log.info;
console.error = log.error;

const taskCategoryJudgementPrompt = '你是一个linux助手，现在要判断用户的需求类型，如果是代码开发方面的需求返回"ass!code", 否则返回null, 不要返回任何其他内容，下面是用户指令。';

const correctAssistantPrompt = '你是一个linux助手,你已经根据用户的需求生成对应的sh指令，已知命令结束得到返回，请检查命令结果，如果完成目标返回"ass!done";否则返回下一步命令，仅包含命令，下面是命令结果。';
const codeAssistantPrompt = '你是一个linux助手,你需要根据用户的需求生成对应的代码，并通过sh在命令行中完成操作，仅返回可在命令行中执行的命令，下面是用户指令。';

const normalAssistantPrompt = '你是一个linux平台下的ai助手';

const maxRetry = 10;

class ConsoleAssistant {
    constructor(permissionRequester = null) {
        this.consoles = new Map;
        this.reflectionMap = new Map;
        this.terminal = new AdvancedTerminal(this.getPassword.bind(this));
        this.taskCategoryJudgement = new Conversation({
            role: taskCategoryJudgementPrompt,
            memory: false,
        });
        this.normalAssistant = new Conversation({
            role: normalAssistantPrompt,
            memory: false,
        });

        this.taskCompleteCallback = []; //callback sign like (isCompelted, consoleNum)
        this.permissionRequester = permissionRequester; // 权限请求函数（从main.js传入）
        
        this.createNewConsole(0);
        this.terminal.processDoneCallbacksAddListener(this.onCommandDone.bind(this));
    }

    /**
     * 设置权限请求函数（依赖注入）
     * @param {Function} requester 权限请求函数
     */
    setPermissionRequester(requester) {
        this.permissionRequester = requester;
    }

    createNewConsole(key) {
        const console = {
            shellAssistant: new Conversation(),
            codeAssistant: new Conversation(codeAssistantPrompt),
            processId: this.terminal.generateProcessId(),
            tryCount: 0,
            lastTask: null,
            lastTaskCategory: null,
        };

        this.consoles.set(key, console);
        this.reflectionMap.set(console.processId, key);
    }

    removeConsole(key) {
        let v = this.consoles.get(key);
        if (v) {
            this.consoles.delete(key);
            console.log(`成功删除助理操作台`);
        }
    }

    async _fetchRealCommand(consoleInfo, task, taskCategory, correcting = false) {
        let ret = null;
        if (taskCategory === 'code') {
            ret = await consoleInfo.codeAssistant.interact(
                correcting ? `命令输出: ${task}` : task, 
                correcting ? correctAssistantPrompt : null
            );
        } else {
            ret = await consoleInfo.shellAssistant.interact(
                correcting ? `命令输出: ${task}` : task, 
                correcting ? correctAssistantPrompt : null
            );
        }
        return ret;
    }

    /**
     * 根据用户需求生成shell命令
     * @param {number} consoleInfo 对话窗口元数据
     * @param {string} task 用户以自然语言描述的任务需求
     * @param {string} taskCategory 任务类型(shell/code 协助), 为 null 时自动选择
     * @param {boolean} correcting 是否用于修正最开始的需求
     * */ 
    async getConsoleTask(consoleInfo, task, taskCategory = null, correcting = false) {
        // 处理任务和任务类别
        if (task && !correcting) {
            // 只有在非纠正模式下才更新任务
            consoleInfo.lastTask = task;
        } 
        // else if (correcting && consoleInfo.lastTask) {
            // 在纠正模式下，使用上次的任务，但当前 task 是命令输出
            // 这里不需要更新 lastTask
        // }
        else {
            const errorLog = `error: consoleAssignTask fail: 没有可用的任务`;
            console.log(errorLog);
            return errorLog;
        }

        if (!taskCategory) {
            taskCategory = await this.getTaskCategory(consoleInfo.lastTask);
        }
        consoleInfo.taskCategory = taskCategory;

        let command = await this._fetchRealCommand(consoleInfo, task, taskCategory, correcting);
        if (command.startsWith('error:')) {
            const errorLog = `error: 获取命令错误，得到: ${command.length > 6 ? command.substring(6) : command}`;
            console.log(errorLog);
            return errorLog;
        }
        console.log(`将用户的需求转换为sh命令: ${command}`);
        return command;
    }

    /**
     * 识别用户需求、获取权限并执行命令
     * @param {number} consoleNum 对话窗口编号
     * @param {string} task 用户以自然语言描述的任务需求
     * @param {string} taskCategory 任务类型(shell/code 协助), 为 null 时自动选择
     * @param {boolean} correcting 是否用于修正最开始的需求
     * @returns {Promise<string>} 执行结果或对话消息
     */ 
    async consoleAssignTask(consoleNum, task, taskCategory = null, correcting = false) {
        // 参数检查
        if (!task && !correcting) {
            console.log(`consoleAssignTask fail: 未指定任务`);
            return 'error: 任务为空';
        }

        let consoleInfo = this.consoles.get(consoleNum);
        if (!consoleInfo) {
            this.createNewConsole(consoleNum);
            consoleInfo = this.consoles.get(consoleNum);
        }

        // 第1步：生成命令
        const command = await this.getConsoleTask(consoleInfo, task, taskCategory, correcting);

        if (!command || command.startsWith('error:')) {
            return command || 'error: 获取命令失败';
        }

        // 第2步：权限检查与执行
        return await this._executeCommandWithPermission(command, consoleInfo);
    }

    /**
     * 权限检查和命令执行的核心逻辑
     * @private
     */
    async _executeCommandWithPermission(command, consoleInfo) {
        const { containSudoCommand } = require('./AdvancedTerminal');
        
        let shouldExecute = false;
        let executionResult = "";
        
        // 权限检查：sudo 命令 vs 普通命令
        if (containSudoCommand(command)) {
            // sudo 命令：获取密码（密码即确认）
            const sudoPassword = await this.getPassword(command);
            if (!sudoPassword) {
                return `### 执行取消\n需要管理员密码才能执行此命令`;
            }
            shouldExecute = true;
        } else {
            // 普通命令：获取用户确认
            const userConfirm = await this.getUserPermission(command);
            if (!userConfirm) {
                return `### 执行取消\n命令: \n\`\`\`sh\n${command}\n\`\`\``;
            }
            shouldExecute = true;
        }

        // 第3步：执行命令
        if (shouldExecute) {
            try {
                let ret = await this.terminal.executeCommand(command, consoleInfo.processId);
                let output = ret?.output;
                
                if (output) {
                    executionResult = `### 命令: \n\`\`\`sh\n${command}\n\`\`\`\n### 任务执行结果:\n\`\`\`sh\n${output || '无输出'}\n\`\`\``;
                } else {
                    executionResult = `### 执行失败\n命令: \n\`\`\`sh\n${command}\n\`\`\``;
                }
            } catch (error) {
                executionResult = `### 执行异常\n命令: \n\`\`\`sh\n${command}\n\`\`\`\n错误: ${error.message}`;
            }
        }

        return executionResult;
    }

    async onCommandDone(reflectionId, result) {
        let consoleNum = this.reflectionMap.get(reflectionId);
        let consoleInfo = this.consoles.get(consoleNum);

        if (!consoleInfo) {
            console.log(`❌ 控制台 ${consoleNum} 不存在!将无法执行后续shell操作 (reflectionId: ${reflectionId})`);
            return;
        }

        console.log(`🔍 AI助手响应: "${result}"`); // 添加调试信息

        // 检查是否应该继续执行
        if (result && result.includes('ass!done')) {
            console.log(`✅ 任务完成！`);
            consoleInfo.tryCount = 0; // 重置重试计数

            this.taskCompleteCallbackAddlistener.forEach(callback => {
                callback(true, consoleNum);
            });
        } else if (++consoleInfo.tryCount <= maxRetry) {
            console.log(`🔄 当前任务命令 ${consoleInfo.tryCount} 执行完成，即将执行下一步`);
            
            // 传递完整的输出给AI助手进行判断
            await this.consoleAssignTask(consoleNum, result, consoleInfo.lastTaskCategory, true);
        } else {
            console.log(`❌ 达到最大重试次数 ${maxRetry}，停止执行`);
            consoleInfo.tryCount = 0; // 重置重试计数

            this.taskCompleteCallbackAddlistener.forEach(callback => {
                callback(false, consoleNum);
            });
        }
    }

    async getTaskCategory(task) {
        let result = await this.taskCategoryJudgement.interact(task);

        var ret = null;
        if (result === 'ass!code'){
            ret = 'code';
        }
        return ret;
    }

    /**
     * 获取 sudo 密码
     * @param {string} command 将要执行的命令（可选，用于在对话框中显示）
     * @returns {Promise<string|null>} 密码字符串或 null
     */
    async getPassword(command = null) {
        if (!this.permissionRequester) {
            console.warn('未配置权限请求函数，无法请求密码');
            return null;
        }
        try {
            const password = await this.permissionRequester({
                type: 'sudo-password',
                command: command,
                message: '执行此命令需要管理员密码'
            });
            return password;
        } catch (error) {
            console.error('获取密码失败:', error);
            return null;
        }
    }

    /**
     * 获取用户对命令执行的确认
     * @param {string} command 要执行的命令
     * @returns {Promise<boolean>} true表示用户确认，false表示取消
     */
    async getUserPermission(command) {
        if (!this.permissionRequester) {
            console.warn('未配置权限请求函数，无法请求权限');
            return false;
        }
        try {
            const permission = await this.permissionRequester({
                type: 'run-confirmation',
                command: command,
                message: '确认是否执行此命令？'
            });
            return permission === true;
        } catch (error) {
            console.error('获取权限失败:', error);
            return false;
        }
    }

    async normalConversation(content) {
        const ret = await this.normalAssistant.interact(content);
        return ret;
    }

    async directRun(command, consoleNum) {
        let consoleInfo = this.consoles.get(consoleNum);
        if (!consoleInfo) {
            this.createNewConsole(consoleNum);
            consoleInfo = this.consoles.get(consoleNum);
        }
        return await this.terminal.executeCommand(command, consoleInfo.processId);
    }

    taskCompleteCallbackAddlistener(event) {
        if(event) {
            this.taskCompleteCallback.push(event);
        }
    }
}

module.exports = { ConsoleAssistant };

// 使用示例
// const test_console = new ConsoleAssistant();

// // 范例回调
// // 参数1表示是否完成任务[true 或者 false],
// // 参数2表示对应的窗口是哪个(就是test_console.consoleAssignTask的第一个参数)
// sampleCallback = (isCompelted, consoleNum) => {
//     // 这里当任务完成时的响应，比如小球闪动，发送文字提示用户完成
//     console.log(`任务 ${consoleNum} ${ isCompelted ? '已完成' : '执行失败'}`);
// }
// // 添加任务执行完成的回调，这样才能通知用户任务执行完成
// test_console.taskCompleteCallbackAddlistener(sampleCallback.bind(this));

// // 反复调用下面的方法执行用户操作，第一个参数用来指定使用哪个窗口(可以随便填，相同窗口会继承记忆)
// // let ret = test_console.consoleAssignTask(0, '帮我安装vlc');
// let ret = test_console.normalConversation('你好');

// console.log(`ret: ${ ret.output }`);
