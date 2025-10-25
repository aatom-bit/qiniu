requirements:
crypto, readline, events, @lydell/node-pty, process, axios

将下载的 pcm 文件转换为 mp3 文件：
ffmpeg -y -f s16le -ac 1 -ar 16000 -acodec pcm_s16le -i test.pcm test.mp3