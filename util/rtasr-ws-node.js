const crypto = require('crypto');
const WebSocket = require('ws');
const path = require('path');
const Mic = require("mic")

const hostUrl = "https://iat.xf-yun.com/v1";
const appid = "6c81ed47"; // 控制台获取
const apiKey = "0d89edc215e36a605786bb630ee2f175";
const apiSecret = "ZTU2MzI3MWFkN2NlMjEzMTc0NDhhOWU4";

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

async function Listen(isLongPress) {
    return new Promise((resolve, reject) => {
        const wsUrl = getWsUrl(hostUrl, apiKey, apiSecret);
        ws = new WebSocket(wsUrl);

        mic = Mic({
            rate: '16000',
            channels: '1',
            bitwidth: '16',
            encoding: 'signed-integer',
        });
        let finalResult = "";
        let settled = false;  // 标志以防止重复resolve/reject

        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                if (message.payload && message.payload.result) {
                    const result = message.payload.result;
                    if (result.text) {
                        const decoded = Buffer.from(result.text, 'base64').toString('utf8');
                        const jsonRes = JSON.parse(decoded);
                        let tempText = "";
                        jsonRes.ws.forEach(wsItem => wsItem.cw.forEach(cw => tempText += cw.w));
                        
                        if (result.status === 2) {
                            finalResult += tempText;
                        }
                    }
                }
            } catch (err) {
                console.error("Failed to parse message:", err);
            }
        });

        ws.on('close', () => {
            console.log("WebSocket closed. Final result:", finalResult);
            mic = null;
            ws = null;
            if (!settled) {
                settled = true;
                resolve(finalResult); // 返回最终识别的文本
            }
        });

        ws.on('open', () => {
            console.log("WebSocket connected. Start sending audio...");
            console.log("isLongPress:", isLongPress, "Timestamp:", Date.now());
            mic.start();
            const micInputStream = mic.getAudioStream();
            send(micInputStream, ws, isLongPress, (err) => {
                // send 函数中的错误回调
                // 不立刻关闭连接，让ws自己处理
                console.error("Send audio error - will wait for connection close:", err);
                if (!settled) {
                    settled = true;
                    ListenClose();
                    reject(err);
                }
            });
        });

        ws.on('error', (err) => {
            console.error("WebSocket error:", err);
            if (!settled) {
                settled = true;
                mic = null;
                ws = null;
                reject(err);
            }
        });
    });
}

function ListenClose() {
    if (mic !== null) {
        mic.stop();
        mic = null;
    }
    if (ws !== null) {
        ws.close();
        ws = null;
    }
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
