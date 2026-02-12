const crypto = require('crypto');
const WebSocket = require('ws');
const path = require('path');
const Mic = require("mic")

const hostUrl = "https://iat.xf-yun.com/v1";
const appid = "b00c2512"; // 控制台获取
const apiKey = "dd69749e72cd6eb0527ab059859ad84d";
const apiSecret = "Nzg3NTMyYjQ0NTFhZWNiOTViOGNjMTNk";

const StatusFirstFrame = 0;
const StatusContinueFrame = 1;
const StatusLastFrame = 2;

let currentSession = {
    mic: null,
    ws: null,
    isOpening: false // 标记是否正在连接中
};

function getWsUrl(hostUrl, apiKey, apiSecret) {
    const urlObj = new URL(hostUrl);
    const date = new Date().toUTCString();
    const signatureOrigin = `host: ${urlObj.host}\ndate: ${date}\nGET ${urlObj.pathname} HTTP/1.1`;
    const signatureSha = crypto.createHmac('sha256', apiSecret).update(signatureOrigin).digest();
    const signature = Buffer.from(signatureSha).toString('base64');
    const authorization = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;

    const authUrl = `${hostUrl}?authorization=${Buffer.from(authorization).toString('base64')}&date=${encodeURIComponent(date)}&host=${urlObj.host}`;
    return authUrl.replace("https://", "wss://").replace("http://", "ws://");
}

function send(micInputStream, ws, isLongPress, onError) {
    let seq = 0;
    let status = StatusFirstFrame;
    let sendFailed = false;
    let lastSendTime = Date.now();
    const sendInterval = 40;  // 建议间隔 40ms

    console.log("Mic opening. Recommended interval: 40ms")
    // 非长按模式下5秒后自动关闭
    if (!isLongPress) ListenCloseAfter5s();
    
    micInputStream.on('data', (chunk) => {
        // 如果之前发生错误，停止继续发送
        if (sendFailed) return;
        
        seq++;
        let frameStatus = status;
        if (status === StatusFirstFrame) status = StatusContinueFrame;

        const audioBase64 = chunk.toString('base64');

        const payload = {
            header: {app_id: appid, status: frameStatus},
            parameter: frameStatus === StatusFirstFrame ? {
                iat: {
                    domain: "slm",
                    language: "zh_cn",
                    accent: "mandarin",
                    eos: 6000,
                    vinfo: 1,
                    dwa: "wpgs",
                    result: {encoding: "utf8", compress: "raw", format: "json"}
                }
            } : undefined,
            payload: {
                audio: {
                    encoding: "raw",
                    sample_rate: 16000,
                    channels: 1,
                    bit_depth: 16,
                    seq: seq,
                    status: frameStatus,
                    audio: audioBase64
                }
            }
        };

        try {
            // 控制发送间隔，避免过于频繁发送
            const now = Date.now();
            const timeSinceLastSend = now - lastSendTime;
            
            if (timeSinceLastSend < sendInterval) {
                // 如果间隔太短，延迟发送
                setTimeout(() => {
                    if (!sendFailed && ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify(payload));
                        lastSendTime = Date.now();
                    }
                }, sendInterval - timeSinceLastSend);
            } else {
                ws.send(JSON.stringify(payload));
                lastSendTime = now;
            }
        } catch (err) {
            console.error('WebSocket send error:', err);
            sendFailed = true;
            if (onError) onError(err);
        }
    });

    micInputStream.on('error', (err) => {
        console.error('Mic error:', err);
        sendFailed = true;
        if (onError) onError(err);
    });

    // 监听关闭事件，发送最后一帧
    micInputStream.on('end', () => {
        if (sendFailed) {
            console.log("Send failed, skip final frame");
            return;
        }
        
        seq++;
        const payload = {
            header: {app_id: appid, status: StatusLastFrame},
            payload: {
                audio: {
                    encoding: "raw",
                    sample_rate: 16000,
                    channels: 1,
                    bit_depth: 16,
                    seq: seq,
                    status: StatusLastFrame,
                    audio: ""
                }
            }
        };
        
        try {
            ws.send(JSON.stringify(payload));
            console.log("Mic close - final frame sent");
        } catch (err) {
            console.error('WebSocket send final frame error:', err);
            if (onError) onError(err);
        }
    });
}

async function Listen(isLongPress) {
    // 1. 如果已经在开启中或录音中，直接返回，防止并发冲突
    if (currentSession.isOpening || currentSession.mic) {
        console.log("Session already exists, skipping...");
        return;
    }

    currentSession.isOpening = true;

    return new Promise((resolve, reject) => {
        const wsUrl = getWsUrl(hostUrl, apiKey, apiSecret);
        currentSession.ws = new WebSocket(wsUrl);

        currentSession.mic = Mic({
            rate: '16000',
            channels: '1',
            bitwidth: '16',
            encoding: 'signed-integer',
        });

        let finalResult = "";

        currentSession.ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                
                // 检查头部状态和错误码
                if (message.header) {
                    if (message.header.code !== 0) {
                        console.warn(`[ASR] 服务器错误 (code: ${message.header.code}): ${message.header.message}`);
                        return;
                    }
                    console.log(`[ASR] 响应 - status: ${message.header.status}, sid: ${message.header.sid}`);
                }
                
                // 处理结果
                if (message.payload && message.payload.result) {
                    const result = message.payload.result;
                    if (result.text) {
                        const decoded = Buffer.from(result.text, 'base64').toString('utf8');
                        const jsonRes = JSON.parse(decoded);
                        let tempText = "";
                        jsonRes.ws.forEach(wsItem => {
                            wsItem.cw.forEach(cw => tempText += cw.w);
                        });
                        
                        // 处理动态修正 (wpgs)
                        const pgs = message.payload.result.pgs;
                        if (pgs === "apd") {
                            // 追加模式
                            finalResult += tempText;
                            console.log(`[ASR] (追加) "${tempText}"`);
                        } else if (pgs === "rpl") {
                            // 替换模式 - 需要根据 rg 范围替换
                            finalResult += tempText;
                            console.log(`[ASR] (替换 [${message.payload.result.rg.join(',')}]) "${tempText}"`);
                        } else {
                            // 普通模式
                            if (result.status === 2) {
                                // 最终结果
                                finalResult += tempText;
                                console.log(`[ASR] (最终) "${tempText}"`);
                            } else {
                                // 中间结果
                                console.log(`[ASR] (中间) "${tempText}"`);
                            }
                        }
                    }
                }
            } catch (err) {
                console.error("[ASR] 消息解析错误:", err.message);
            }
        });

        currentSession.ws.on('open', () => {
            console.log("[ASR] WebSocket 连接成功");
            console.log(`[ASR] 模式: ${isLongPress ? '长按录音' : '定时录音'}, 时间戳: ${Date.now()}`);
            currentSession.isOpening = false; // 连接成功
            
            // 检查：如果在连接期间，用户已经松开了手（触发了关闭）
            if (!currentSession.mic) {
                console.log("[ASR] 连接期间麦克风已关闭，自动关闭连接");
                currentSession.ws?.close();
                return;
            }

            console.log("[ASR] 启动麦克风并开始发送音频...");
            currentSession.mic.start();
            const micInputStream = currentSession.mic.getAudioStream();
            send(micInputStream, currentSession.ws, isLongPress, (err) => {
                // send 函数中的错误回调
                console.error("[ASR] 音频发送错误:", err.message);
                if (currentSession.ws && currentSession.ws.readyState === WebSocket.OPEN) {
                    currentSession.ws.close();
                }
                reject(err);
            });
        });

        currentSession.ws.on('close', () => {
            console.log("[ASR] WebSocket 已关闭");
            console.log(`[ASR] 识别结果: "${finalResult || '(无结果)'}"`);
            currentSession.mic = null;
            currentSession.ws = null;
            currentSession.isOpening = false;
            resolve(finalResult); // 返回最终识别的文本
        });

        currentSession.ws.on('error', (err) => {
            console.error("[ASR] WebSocket 错误:", err.message);
            currentSession.mic = null;
            currentSession.ws = null;
            currentSession.isOpening = false;
            reject(err);
        });
    });
}

function ListenClose() {
    console.log("[ASR] 停止录音");
    if (currentSession.mic) {
        try {
            currentSession.mic.stop();
        } catch (err) {
            console.error("[ASR] 停止麦克风错误:", err.message);
        }
        currentSession.mic = null;
    }
    if (currentSession.ws) {
        try {
            if (currentSession.ws.readyState === WebSocket.OPEN) {
                currentSession.ws.close();
            }
        } catch (err) {
            console.error("[ASR] 关闭 WebSocket 错误:", err.message);
        }
        currentSession.ws = null;
    }
    currentSession.isOpening = false;
}

function ListenCloseAfter5s() {
    setTimeout(() => {
        ListenClose();
    }, 5000);
}

// Begin(false);

// Begin(true);


module.exports = {
    Listen,
    ListenCloseAfter5s,
    ListenClose
}
