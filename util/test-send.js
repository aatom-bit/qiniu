const fs = require('fs');
const crypto = require('crypto');
const WebSocket = require('ws');

const hostUrl = "https://iat.xf-yun.com/v1";
const appid = "b00c2512";
const apiKey = "dd69749e72cd6eb0527ab059859ad84d";
const apiSecret = "Nzg3NTMyYjQ0NTFhZWNiOTViOGNjMTNk";

const StatusFirstFrame = 0;
const StatusContinueFrame = 1;
const StatusLastFrame = 2;

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

async function testSendWithFile(filePath) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(filePath)) {
            return reject(new Error(`文件不存在: ${filePath}`));
        }

        const fileSize = fs.statSync(filePath).size;
        console.log(`\n========== ASR 测试开始 ==========`);
        console.log(`文件: ${filePath}`);
        console.log(`大小: ${fileSize} 字节`);
        console.log(`时间: ${new Date().toLocaleString()}\n`);
        console.log(`✓ AppID: ${appid}`);
        console.log(`✓ ApiKey: ${apiKey.substring(0, 8)}...`);
        console.log(`✓ ApiSecret: ${apiSecret.substring(0, 8)}...\n`);

        const wsUrl = getWsUrl(hostUrl, apiKey, apiSecret);
        const ws = new WebSocket(wsUrl);

        let seq = 0;
        let status = StatusFirstFrame;
        let sendFailed = false;
        let finalResult = "";
        let messageCount = 0;
        let sentBytes = 0;

        ws.on('open', () => {
            console.log("✓ WebSocket 连接成功");
            console.log("→ 开始发送音频数据...\n");
            
            // WebSocket 连接成功后，才开始读取文件
            const fileStream = fs.createReadStream(filePath, { highWaterMark: 4096 });

            fileStream.on('data', (chunk) => {
                if (sendFailed) return;

                seq++;
                let frameStatus = status;
                if (status === StatusFirstFrame) status = StatusContinueFrame;

                const audioBase64 = chunk.toString('base64');
                sentBytes += chunk.length;

                const payload = {
                    header: { 
                        app_id: appid, 
                        status: frameStatus 
                    },
                    parameter: frameStatus === StatusFirstFrame ? {
                        iat: {
                            domain: "slm",
                            language: "zh_cn",
                            accent: "mandarin",
                            eos: 6000,
                            vinfo: 1,
                            dwa: "wpgs",
                            result: { encoding: "utf8", compress: "raw", format: "json" }
                        }
                    } : undefined,
                    payload: {
                        audio: {
                            encoding: "lame",
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
                    if (ws.readyState !== WebSocket.OPEN) {
                        console.log(`⚠ WebSocket 未就绪 (state: ${ws.readyState})`);
                        fileStream.pause();
                        return;
                    }
                    
                    ws.send(JSON.stringify(payload));
                    if (seq % 3 === 0 || frameStatus === StatusFirstFrame) {
                        console.log(`[帧 ${seq}] 已发送 ${sentBytes} 字节 (状态: ${frameStatus})`);
                    }
                } catch (err) {
                    console.error(`✗ 发送错误 (帧${seq}):`, err.message);
                    sendFailed = true;
                    fileStream.pause();
                }
            });

            fileStream.on('end', () => {
                if (sendFailed) {
                    console.log("✗ 文件读取中止");
                    return;
                }

                seq++;
                const finalPayload = {
                    header: { app_id: appid, status: StatusLastFrame },
                    payload: {
                        audio: {
                            encoding: "lame",
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
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify(finalPayload));
                        console.log(`[帧 ${seq}] 最后一帧已发送 (总: ${sentBytes} 字节)`);
                        console.log("✓ 等待识别结果...\n");
                    }
                } catch (err) {
                    console.error(`✗ 最后一帧错误:`, err.message);
                }
            });

            fileStream.on('error', (err) => {
                console.error('✗ 文件错误:', err.message);
                sendFailed = true;
                if (ws.readyState === WebSocket.OPEN) ws.close();
            });
        });

        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                messageCount++;

                if (message.header) {
                    const code = message.header.code;
                    const msg = message.header.message;
                    console.log(`[响应 ${messageCount}] code: ${code}, message: ${msg}`);
                    
                    if (code !== 0) {
                        console.warn(`⚠ 错误代码 ${code}`);
                        if (code === 11201) {
                            console.log(`💡 请检查讯飞控制台使用配额`);
                        }
                    }
                }

                if (message.payload && message.payload.result && message.payload.result.text) {
                    try {
                        const decoded = Buffer.from(message.payload.result.text, 'base64').toString('utf8');
                        const jsonRes = JSON.parse(decoded);
                        let tempText = "";
                        
                        jsonRes.ws.forEach(wsItem => {
                            wsItem.cw.forEach(cw => tempText += cw.w);
                        });

                        const pgs = message.payload.result.pgs;
                        if (pgs) {
                            console.log(`   (${pgs === 'apd' ? '追加' : '替换'}) "${tempText}"`);
                        } else {
                            console.log(`   "${tempText}"`);
                        }

                        if (message.payload.result.status === 2) {
                            finalResult += tempText;
                        }
                    } catch (e) {
                        // 解析失败
                    }
                }
            } catch (err) {
                console.error('✗ 消息解析错误:', err.message);
            }
        });

        ws.on('close', () => {
            console.log("✓ WebSocket 已关闭");
            console.log(`\n========== 识别结果 ==========`);
            console.log(`最终文本: "${finalResult || '(无结果)'}"`);
            console.log(`消息数: ${messageCount}, 帧数: ${seq}, 字节数: ${sentBytes}`);
            console.log(`============================\n`);
            resolve({ text: finalResult, messageCount, seq, sentBytes });
        });

        ws.on('error', (err) => {
            console.error('✗ WebSocket 错误:', err.message);
            reject(err);
        });
    });
}

async function main() {
    const testFile = process.argv[2] || './test.mp3';
    console.log('讯飞 ASR 测试工具\n支持格式: MP3/PCM (16kHz 单声道)\n');

    try {
        await testSendWithFile(testFile);
        process.exit(0);
    } catch (err) {
        console.error('✗ 失败:', err.message);
        process.exit(1);
    }
}

main();
