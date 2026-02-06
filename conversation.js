const axios = require('axios');

class Conversation {
    constructor({ role = '你是一个linux助手,你需要根据用户的需求生成对应的sh指令，仅包含命令，下面是用户指令。', temperature = 0.5, memory = true } = {}) {
        this.data = {
            "messages": [
                {
                    "content": role,
                    "role": "system"
                },
            ],
            "model": "deepseek-chat",
            "frequency_penalty": 0,
            "max_tokens": 4096,
            "presence_penalty": 0,
            "response_format": {
                "type": "text"
            },
            "stop": null,
            "stream": false,
            "stream_options": null,
            "temperature": temperature,
            "top_p": 1,
            "tools": null,
            "tool_choice": "none",
            "logprobs": false,
            "top_logprobs": null
        };

        this.memory = memory;
        
        if (!memory) {
            this.data.messages.push({
                "content": "",
                "role": "user",
            });
        }
    }
    
    async interact(content, role = null) {
        if (!content) {
            console.log('content为空');
            return 'error: 内容为空';
        }
        
        if (this.memory) {
            // 将content添加至上下文尾部
            this.data.messages.push({
                "content": content,
                "role": "user",
            });
        } else {
            let lastIdx = this.data.messages.length - 1;
            this.data.messages[lastIdx].content = content;
        }

        if (role) {
            let rawRole = this.data.messages[0].content;
            this.data.messages[0].content = role;
            const result = await this.sendData(this.data);
            this.data.messages[0].content = rawRole;
            return result;
        }
        return await this.sendData(this.data);
    }

    async sendData(info) {
        try {
            let data = JSON.stringify(info);

            let config = {
                method: 'post',
                maxBodyLength: Infinity,
                url: 'https://api.deepseek.com/chat/completions',
                headers: { 
                    'Content-Type': 'application/json', 
                    'Accept': 'application/json', 
                    'Authorization': 'Bearer sk-b840f06a8d054e20bd19bbf0d72f4441'
                },
                data: data
            };

            const response = await axios(config);
            const result = response.data.choices[0].message.content;
            console.log('AI 返回:', result);

            if (this.memory) {
                this.data.messages.push({
                    'role': 'assistant',
                    'content': result,
                });
            }
            
            return result;
        } catch (error) {
            console.error('API 调用错误:', error);
            return `error: ${error.message}`;
        }
    }
}

// const cvst = new Conversation({role: 'ai助手', memory: false});
// let ret = cvst.interact('你好');
// console.log(`ret: ${ret}`);

module.exports = { Conversation };