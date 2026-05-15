#!/usr/bin/env python3
"""
furigana.py - 日语假名注音脚本
输入: JSON {"text": "日语句子"}
输出: JSON {"reading": "よみかた", "annotated": "日<rp>(</rp><rt>よ</rt><rp>)</rp>本<rp>(</rp><rt>ほん</rt><rp>)</rp>語"}
"""
import json
import sys
import re

from janome.tokenizer import Tokenizer

_tokenizer = Tokenizer()

# 加载手动纠错字典
import os
_fixes_path = os.path.join(os.path.dirname(__file__), 'fixes.json')
try:
    with open(_fixes_path, encoding='utf-8') as f:
        _FIXES = json.load(f)
except Exception:
    _FIXES = {}


def katakana_to_hiragana(text: str) -> str:
    """片假名 → 平假名"""
    result = []
    for ch in text:
        code = ord(ch)
        if 0x30A1 <= code <= 0x30F6:  # 片假名范围
            result.append(chr(code - 0x60))
        else:
            result.append(ch)
    return "".join(result)


def generate_furigana(text: str) -> dict:
    """
    为日语文本生成注音（平假名）
    返回:
      reading   - 全行假名读法
      annotated - HTML <ruby> 标签格式
    """
    tokens = list(_tokenizer.tokenize(text))
    reading_parts = []
    annotated_parts = []

    for token in tokens:
        surface = token.surface
        reading = token.reading  # 片假名

        # 如果 surface 和 reading 一样（纯假名），或者 reading 为空
        if not reading or surface == reading:
            reading_parts.append(surface)
            annotated_parts.append(surface)
            continue

        # 将片假名转平假名
        hira = katakana_to_hiragana(reading)

        # 只对包含汉字的 token 加注音
        if re.search(r'[\u4e00-\u9fff]', surface):
            annotated_parts.append(
                f"{surface}<rp>(</rp><rt>{hira}</rt><rp>)</rp>"
            )
        else:
            annotated_parts.append(surface)

        reading_parts.append(hira)

    reading = "".join(reading_parts)
    annotated = "".join(annotated_parts)

    # ── 应用手动纠错字典 ──
    for src_word, correct_reading in _FIXES.items():
        if src_word not in text:
            continue
        # 获取 janome 对这个词的读法
        wrong_tokens = list(_tokenizer.tokenize(src_word))
        wrong_reading = "".join(
            katakana_to_hiragana(t.reading) if t.reading and t.reading != t.surface else t.surface
            for t in wrong_tokens
        )
        wrong_ruby = "".join(
            f"{t.surface}<rp>(</rp><rt>{katakana_to_hiragana(t.reading)}</rt><rp>)</rp>"
            if re.search(r'[\u4e00-\u9fff]', t.surface) and t.reading and t.reading != t.surface
            else t.surface
            for t in wrong_tokens
        )
        correct_ruby = f"{src_word}<rp>(</rp><rt>{correct_reading}</rt><rp>)</rp>"
        reading = reading.replace(wrong_reading, correct_reading)
        annotated = annotated.replace(wrong_ruby, correct_ruby)

    return {
        "reading": reading,
        "annotated": annotated,
    }


def main():
    try:
        raw = sys.stdin.buffer.read().decode('utf-8')
        data = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        print(json.dumps({"error": "无效的 JSON 输入"}, ensure_ascii=False))
        sys.exit(1)

    # 支持单行 text 或多行 texts 批量处理
    if "texts" in data:
        results = [generate_furigana(t) for t in data["texts"]]
        print(json.dumps(results, ensure_ascii=False))
    else:
        text = data.get("text", "")
        if not text.strip():
            print(json.dumps({"reading": "", "annotated": ""}, ensure_ascii=False))
            return
        result = generate_furigana(text)
        print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()