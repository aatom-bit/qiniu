const { Conversation } = require("./conversation");
const { AdvancedTerminal } = require("./AdvancedTerminal");

const taskCategoryJudgementPrompt = '你是一个linux助手，现在要判断用户的需求类型，如果是代码开发方面的需求返回"ass!code", 否则返回null, 不要返回任何其他内容，下面是用户指令。';

const correctAssistantPrompt = '你是一个linux助手,你已经根据用户的需求生成对应的sh指令，已知命令结束得到返回，请检查命令结果，如果完成目标返回"ass!done";否则返回下一步命令，仅包含命令，下面是命令结果。';
const codeAssistantPrompt = '你是一个linux助手,你需要根据用户的需求生成对应的代码，并通过sh在命令行中完成操作，仅返回可在命令行中执行的命令，下面是用户指令。';

const maxRetry = 10;

class ConsoleAssistant {
    constructor() {
        this.consoles = new Map;
        this.reflectionMap = new Map;
        this.terminal = new AdvancedTerminal(this.getPassword);
        this.taskCategoryJudgement = new Conversation({
            role: taskCategoryJudgementPrompt,
            memory: false,
        });
        
        this.createNewConsole(0);
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

    async consoleAssignTask(consoleNum, task, taskCategory = null, correcting = false) {
        if (!(task || correcting)) {
            console.log(`consoleAssignTask fail: 未指定任务`);
            return false;
        }

        let consoleInfo = this.consoles.get(consoleNum);
        if (!consoleInfo) {
            this.consoles.createNewConsole(consoleNum);
            consoleInfo = this.consoles.get(consoleNum);
        }

        if (!taskCategory) {
            taskCategory = this.getTaskCategory(task);
        }

        consoleInfo.lastTask = task;
        consoleInfo.taskCategory = taskCategory;

        let command = await this.fetchRealCommand(consoleInfo, task, taskCategory, correcting);
        if (command.startWith('error:')) {
            // 获取命令错误
            return command;
        } else {
            console.log(`将用户的需求转换为sh命令: ${command}`);
        }
        return await this.terminal.executeCommand(command, consoleInfo.processId);
    }

    async fetchRealCommand(consoleInfo, task, taskCategory, correcting = false) {
        let ret = null;
        if (taskCategory === 'code') {
            ret = await consoleInfo.codeAssistant.interact(task, correcting ? correctAssistantPrompt : null);
        } else {
            ret = await consoleInfo.shellAssistant.interact(task, correcting ? correctAssistantPrompt : null);
        }
        return ret;
    }

    async onCommandDone(reflectionId, result) {
        let consoleNum = this.reflectionMap.get(reflectionId);
        let consoleInfo = this.consoles.get(consoleNum);

        if (result === 'ass!fail') {

        } else if(result !== 'ass!done' && ++consoleInfo.tryCount <= maxRetry)
        {
            console.log(`当前任务命令 ${consoleInfo.tryCount} 执行完成，即将执行下一步`);
            await this.consoleAssignTask(consoleId, '', consoleInfo.lastTaskCategory, correcting);
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

    async getPassword() {

    }
}

// const console = new ConsoleAssistant();
// console.consoleAssignTask(0, '帮我卸载vlc');