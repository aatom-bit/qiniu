#!/bin/bash

# PCM to MP3 转换脚本
# 用于将 PCM 音频文件转换为 MP3 格式

if [ $# -lt 1 ]; then
    echo "用法: ./convert-pcm-to-mp3.sh <输入文件.pcm> [输出文件.mp3]"
    echo ""
    echo "示例:"
    echo "  ./convert-pcm-to-mp3.sh test.pcm"
    echo "  ./convert-pcm-to-mp3.sh test.pcm output.mp3"
    echo ""
    echo "要求: 需要安装 ffmpeg"
    echo "  Ubuntu/Debian: sudo apt-get install ffmpeg"
    echo "  macOS: brew install ffmpeg"
    echo "  Windows: https://ffmpeg.org/download.html"
    exit 1
fi

INPUT="$1"
OUTPUT="${2:-${INPUT%.*}.mp3}"

if [ ! -f "$INPUT" ]; then
    echo "错误: 文件不存在 - $INPUT"
    exit 1
fi

if ! command -v ffmpeg &> /dev/null; then
    echo "错误: ffmpeg 未安装"
    echo "请先安装 ffmpeg"
    exit 1
fi

echo "转换中..."
echo "输入: $INPUT"
echo "输出: $OUTPUT"
echo "格式: MP3 (128kbps) 16kHz 单声道"

# PCM (raw 格式) 转 MP3
# -f s16le: 输入格式为 16-bit 小端字节序原始数据
# -ar 16000: 采样率 16000 Hz
# -ac 1: 单声道
# -acodec libmp3lame: 使用 MP3 编码
# -ab 128k: 比特率 128 kbps
ffmpeg -f s16le -ar 16000 -ac 1 -i "$INPUT" -acodec libmp3lame -ab 128k "$OUTPUT" -y

if [ $? -eq 0 ]; then
    FILE_SIZE=$(stat -f%z "$OUTPUT" 2>/dev/null || stat -c%s "$OUTPUT")
    echo ""
    echo "✓ 转换成功!"
    echo "  文件: $OUTPUT"
    echo "  大小: $FILE_SIZE 字节"
else
    echo "✗ 转换失败"
    exit 1
fi
