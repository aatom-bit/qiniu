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
let mic = null;
let ws = null;

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

    console.log("Mic opening")
    // 非长按模式下10秒后自动关闭
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
            ws.send(JSON.stringify(payload));
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

let currentSession = {
    mic: null,
    ws: null,
    isOpening: false // 标记是否正在连接中
};

async function Listen(isLongPress) {
    // 1. 如果已经在开启中或录音中，直接返回，防止并发冲突
    if (currentSession.isOpening || currentSession.mic) {
        console.log("Session already exists, skipping...");
        return;
    }

    currentSession.isOpening = true;

    return new Promise((resolve, reject) => {
        const wsUrl = getWsUrl(hostUrl, apiKey, apiSecret);
        const ws = new WebSocket(wsUrl);
        currentSession.ws = ws;

        const micInstance = Mic({
            rate: '16000',
            channels: '1',
            bitwidth: '16',
            encoding: 'signed-integer',
        });
        currentSession.mic = micInstance;

        let finalResult = "";

        ws.on('open', () => {
            console.log("WebSocket connected.");
            currentSession.isOpening = false; // 连接成功
            
            // 检查：如果在连接期间，用户已经松开了手（触发了关闭）
            if (!currentSession.mic) {
                ws.close();
                return;
            }

            micInstance.start();
            const micInputStream = micInstance.getAudioStream();
            send(micInputStream, ws, isLongPress);
        });

        // ... 其余逻辑处理 finalResult 并 resolve ...
        ws.on('close', () => {
            currentSession.mic = null;
            currentSession.ws = null;
            resolve(finalResult);
        });
    });
}

function ListenClose() {
    console.log("Attempting to close mic...");
    // 延迟极短时间处理，或者增加保护，确保 start 后再 stop
    if (currentSession.mic) {
        currentSession.mic.stop();
        currentSession.mic = null;
    }
    if (currentSession.ws) {
        // 如果 WebSocket 还在连接中，可能需要稍微等一下再关，或者直接切断
        currentSession.ws.close();
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
