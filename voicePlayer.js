const fs = require('fs');
const { Player } = require('node-mp3-player');

async function readAudioFileToBufferAsync(filePath) {
    return new Promise((resolve, reject) => {
        fs.readFile(filePath, (err, data) => {
            if (err) reject(err);
            else resolve(data);
        });
    });
}

async function playAudio(audioBuffer) {
    return new Promise((resolve, reject) => {
        try {
            const tempFile = `./temp_${Date.now()}.mp3`;
            fs.writeFileSync(tempFile, audioBuffer);
            
            console.log('正在播放音频...');
            
            // 创建播放器实例
            const player = new Player({
                path: './', // 临时文件所在目录
                files: [tempFile] // 文件名
            });
            
            // 播放音频
            player.play(tempFile);
            
            // 监听播放完成事件
            player.on('end', () => {
                console.log('播放完成');
                cleanupFile(tempFile);
                resolve();
            });
            
            // 监听错误事件
            player.on('error', (err) => {
                console.error('播放错误:', err);
                cleanupFile(tempFile);
                reject(err);
            });
            
        } catch (error) {
            console.error('语音播放错误:', error);
            reject(error);
        }
    });
}

function cleanupFile(file) {
    try {
        if (fs.existsSync(file)) {
            fs.unlinkSync(file);
        }
    } catch (e) {
        console.warn('清理文件失败:', e);
    }
}

// 测试函数
async function test() {
    try {
        const audioBuffer = await readAudioFileToBufferAsync('./test.mp3');
        await playAudio(audioBuffer);
        console.log('音频播放完成');
    } catch (error) {
        console.error('播放失败:', error);
    }
}

// 运行测试
test();

module.exports = { readAudioFileToBufferAsync, playAudio };