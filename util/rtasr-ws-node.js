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

function send(micInputStream, ws, isLongPress) {
    let seq = 0;
    let status = StatusFirstFrame;


    console.log("Mic opening")
    if (!isLongPress) CloseAfter5s();
    micInputStream.on('data', (chunk) => {
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

        ws.send(JSON.stringify(payload));
    });

    micInputStream.on('error', (err) => {
        console.log('Mic error:', err);
    });

// 监听关闭或停止发送最后一帧
    micInputStream.on('end', () => {
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
        ws.send(JSON.stringify(payload));
        console.log("Mic close");
    });
}

async function Begin(isLongPress) {
    ws = null;
    mic = null;

    const wsUrl = getWsUrl(hostUrl, apiKey, apiSecret);
    ws = new WebSocket(wsUrl);

    let res = "";
    let last = ""

    mic = Mic({
        rate: '16000',
        channels: '1',
        bitwidth: '16',
        encoding: 'signed-integer',
    });

    ws.on('open', () => {
        console.log("WebSocket connected. Start sending audio...");
        mic.start();
        const micInputStream = mic.getAudioStream();
        send(micInputStream, ws, isLongPress);
    });

    ws.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message.header && message.header.code !== 0) {
            console.error(`Error code: ${message.header.code}, message: ${message.header.message}`);
            return;
        }

        if (message.payload && message.payload.result) {
            const result = message.payload.result;
            if (result.text) {
                const decoded = Buffer.from(result.text, 'base64').toString('utf8');
                const jsonRes = JSON.parse(decoded);
                let text = "";
                jsonRes.ws.forEach(wsItem => {
                    wsItem.cw.forEach(cw => {
                        text += cw.w;
                    });
                });
                console.log("Intermediate result:", text);

                // if (message.header.status !== 0 && text.length < last) {
                //     res += last;
                // }
                // last = text;
            }

            if (result.status === 2) {
                console.log("Final result received. Closing WebSocket.");
                ws.close();
            }
        }
    });

    ws.on('close', () => {
        // console.log("转换结果为：" + res);
        console.log("WebSocket closed.");
        return res;
    });

    ws.on('error', (err) => {
        console.error("WebSocket error:", err);
    });
}

function Close() {
    if (mic !== null) mic.stop();
    if (ws !== null) ws.close();
}

function CloseAfter5s() {
    setTimeout(() => {
        if (mic !== null) mic.stop();
        if (ws !== null) ws.close();
    }, 10000);
}

// Begin(false);

// Begin(true);


module.exports = {
    Begin,
    CloseAfter5s,
    Close
}
