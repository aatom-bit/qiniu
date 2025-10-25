var fs = require('fs');

const CryptoJS = require('crypto-js');
const WebSocket = require('ws');
var log = require('log4node');

// 系统配置 
const config = {
    // 请求地址
    hostUrl: "wss://tts-api.xfyun.cn/v2/tts",
    host: "tts-api.xfyun.cn",
    appid: "2c862a94",
    apiSecret: "OTY1M2YyODFjZDJiMGY3YTIyNGQ3MjRi",
    apiKey: "12046c68e5888eb1f1587d818c73c598",
    text: "这是一个例子，请输入您要合成的文本",
    uri: "/v2/tts",
};

function getTTSVoice(text, save = false) {
    return new Promise((resolve, reject) => {
        config.text = text;

        // 获取当前时间 RFC1123格式
        let date = (new Date().toUTCString())
        let wssUrl = config.hostUrl + "?authorization=" + getAuthStr(date) + "&date=" + date + "&host=" + config.host
        let ws = new WebSocket(wssUrl);

        let audioBuffer = null;
        let hasResolved = false;

        // 连接建立完毕，读取数据进行识别
        ws.on('open', () => {
            log.info("websocket connect!");
            send(config, ws);
            // 如果之前保存过音频文件，删除之
            if (save && fs.existsSync('./test.mp3')) {
                fs.unlink('./test.mp3', (err) => {
                    if (err) {
                        log.error('remove error: ' + err);
                    }
                })
            }
        })

        // 得到结果后进行处理
        ws.on('message', (data) => {
            let res;
            try {
                res = JSON.parse(data);
            } catch (err) {
                log.error('parse error: ' + err);
                return;
            }

            if (res.code != 0) {
                log.error(`${res.code}: ${res.message}`);
                if (!hasResolved) {
                    hasResolved = true;
                    reject(new Error(`${res.code}: ${res.message}`));
                }
                ws.close();
                return;
            }

            let audio = res.data.audio;
            let chunkBuffer = Buffer.from(audio, 'base64');
            
            // 累积音频数据
            if (audioBuffer) {
                audioBuffer = Buffer.concat([audioBuffer, chunkBuffer]);
            } else {
                audioBuffer = chunkBuffer;
            }

            if (save) {
                saveToFile(chunkBuffer);
            }

            if (res.code == 0 && res.data.status == 2) {
                if (!hasResolved) {
                    hasResolved = true;
                    resolve(audioBuffer);
                }
                ws.close();
            }
        })

        // 资源释放
        ws.on('close', () => {
            log.info('connect close!');
            // 如果连接关闭但还没有解析，拒绝Promise
            if (!hasResolved) {
                hasResolved = true;
                reject(new Error('WebSocket connection closed before completion'));
            }
        })

        // 连接错误
        ws.on('error', (err) => {
            log.error("websocket connect err: " + err);
            if (!hasResolved) {
                hasResolved = true;
                reject(err);
            }
        })

        // 设置超时
        setTimeout(() => {
            if (!hasResolved) {
                hasResolved = true;
                reject(new Error('TTS request timeout'));
                ws.close();
            }
        }, 30000); // 30秒超时
    });
}

// 鉴权签名
function getAuthStr(date) {
    let signatureOrigin = `host: ${config.host}\ndate: ${date}\nGET ${config.uri} HTTP/1.1`;
    let signatureSha = CryptoJS.HmacSHA256(signatureOrigin, config.apiSecret);
    let signature = CryptoJS.enc.Base64.stringify(signatureSha);
    let authorizationOrigin = `api_key="${config.apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
    let authStr = CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse(authorizationOrigin));
    return authStr;
}

// 传输数据
function send(config, ws) {
    let frame = {
        // 填充common
        "common": {
            "app_id": config.appid,
        },
        // 填充business
        "business": {
            "aue": "lame",
            "sfl": 1,
            "auf": "audio/L16;rate=16000",
            "vcn": "x4_yezi",
            "tte": "UTF8",
        },
        // 填充data
        "data": {
            "text": Buffer.from(config.text).toString('base64'),
            "status": 2,
        }
    }
    ws.send(JSON.stringify(frame));
}

// 保存文件（重命名以避免冲突）
function saveToFile(data, filePath = './test.mp3') {
    fs.writeFile(filePath, data, { flag: 'a' }, (err) => {
        if (err) {
            log.error('save error: ' + err);
            return;
        }
        log.info('文件保存成功');
    })
}

module.exports = { getTTSVoice };