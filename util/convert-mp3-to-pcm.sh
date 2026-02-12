#!/bin/bash

# MP3 to PCM 转换脚本

if [ $# -lt 1 ]; then
    echo "用法: ./convert-mp3-to-pcm.sh <输入文件.mp3> [输出文件.pcm]"
    echo ""
    echo "示例:"
    echo "  ./convert-mp3-to-pcm.sh test.mp3"
    echo "  ./convert-mp3-to-pcm.sh test.mp3 output.pcm"
    echo ""
    echo "要求: 需要安装 ffmpeg"
    echo "  Ubuntu/Debian: sudo apt-get install ffmpeg"
    echo "  macOS: brew install ffmpeg"
    echo "  Windows: https://ffmpeg.org/download.html"
    exit 1
fi

INPUT="$1"
OUTPUT="${2:-${INPUT%.*}.pcm}"

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
echo "格式: PCM 16kHz 单声道 16-bit"

ffmpeg -i "$INPUT" -acodec pcm_s16le -ac 1 -ar 16000 "$OUTPUT" -y

if [ $? -eq 0 ]; then
    FILE_SIZE=$(stat -f%z "$OUTPUT" 2>/dev/null || stat -c%s "$OUTPUT")
    DURATION=$(echo "scale=2; $FILE_SIZE / 16000 / 2" | bc)
    echo ""
    echo "✓ 转换成功!"
    echo "  文件: $OUTPUT"
    echo "  大小: $FILE_SIZE 字节"
    echo "  时长: ${DURATION}s"
else
    echo "✗ 转换失败"
    exit 1
fi
