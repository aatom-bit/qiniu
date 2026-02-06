# linux智能包管理助手
---
这是一个 linux 平台 `vibe package manager`。通过将自然语言转换自动为shell脚本，以求更优雅的执行包括包管理命令在内的shell脚本。  

> 版本更新内容：
> * 语音支持
> * 对话窗口
> * 历史记录

### [github 仓库](https://github.com/aatom-bit/qiniu#):
请访问`https://github.com/aatom-bit/qiniu#`

### requirements 下载:
```[bash]
npm install crypto, readline, events, @lydell/node-pty, process, axios
```

### 将下载的 pcm 文件转换为 mp3 文件：
```[bash]
ffmpeg -y -f s16le -ac 1 -ar 16000 -acodec pcm_s16le -i test.pcm test.mp3
```

### 运行方法:
```[bash]
# 克隆此仓库
git clone https://github.com/aatom-bit/qiniu.git
# 或使用 ssh 版本: git clone git@github.com:aatom-bit/qiniu.git

cd qiniu

# 下载所需包
npm install crypto, readline, events, @lydell/node-pty, process, axios

# npm运行
npm start
```
