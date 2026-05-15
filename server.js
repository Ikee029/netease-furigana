/**
 * server.js — 网易云日语歌词 上行注音·下行翻译
 *
 * 端点:
 *   GET  /api/search?q=...      搜索歌曲
 *   GET  /api/lyrics/:id        获取歌词（含假名注音）
 *   GET  /                      主页
 *   GET  /view/:id              歌词展示页
 */

const express  = require('express');
const https    = require('https');
const { execSync } = require('child_process');
const path     = require('path');
const fs       = require('fs');

const app  = express();
const PORT = process.env.PORT || 8787;

app.use(express.json());
app.use(express.static(__dirname));

// ─── 工具 ────────────────────────────────────

function httpsGet(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { Referer: 'https://music.163.com' } }, res => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(new Error('JSON 解析失败')); }
            });
        }).on('error', reject);
    });
}

/** 调用 furigana.py 批量获取注音，返回 [{reading, annotated}, ...] */
function getFurigana(lines) {
    const input = JSON.stringify({ texts: lines });
    try {
        const result = execSync('python furigana.py', {
            input,
            encoding: 'utf-8',
            env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
            timeoutMs: 15000,
            cwd: __dirname,
        });
        return JSON.parse(result);
    } catch (e) {
        console.error('Furigana error:', e.message);
        return lines.map(t => ({ reading: t, annotated: t }));
    }
}

/** 解析内联注音: 溢(こぼ)れた → ruby 标签 */
function parseInlineFurigana(text) {
    if (!text) return text;
    return text.replace(/([\u4e00-\u9fff]+)\(([\u3040-\u309f\u30a0-\u30ff]+)\)/g,
        (_, kanji, reading) => {
            const hira = reading.replace(/[\u30a1-\u30f6]/g,
                c => String.fromCharCode(c.charCodeAt(0) - 0x60));
            return `${kanji}<rp>(</rp><rt>${hira}</rt><rp>)</rp>`;
        });
}

/** 去掉内联注音: 溢(こぼ)れた → 溢れた */
function stripFurigana(text) {
    if (!text) return text;
    return text.replace(/\(([\u3040-\u309f\u30a0-\u30ff]+)\)/g, '');
}

// ─── API: 搜索 ─────────────────────────────

app.get('/api/search', async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ code: 400, message: '缺少关键词' });

    try {
        const data = await httpsGet(
            `https://music.163.com/api/cloudsearch/pc?s=${encodeURIComponent(q)}&type=1&limit=20&offset=0`
        );
        if (data.code !== 200) return res.json({ code: data.code, message: '搜索失败' });

        const songs = (data.result || {}).songs || [];
        res.json({
            code: 200,
            result: {
                songs: songs.map(s => ({
                    id:       s.id,
                    name:     s.name,
                    artist:   (s.ar || s.artists || []).map(a => a.name).join(' / '),
                    album:    (s.al || s.album  || {}).name || '',
                    duration: s.dt || s.duration || 0,
                }))
            }
        });
    } catch (e) {
        res.json({ code: 500, message: e.message });
    }
});

// ─── API: 歌词（含注音） ──────────────────────

app.get('/api/lyrics/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.json({ code: 400, message: '无效的歌曲 ID' });

    try {
        const data = await httpsGet(
            `https://music.163.com/api/song/lyric?id=${id}&lv=-1&tv=-1`
        );
        if (data.code !== 200) return res.json({ code: data.code, message: '获取歌词失败' });

        const jpRaw = (data.lrc    || {}).lyric || '';
        const cnRaw = (data.tlyric || {}).lyric || '';

        // ── 解析 LRC 格式 ──
        function parseLrc(raw) {
            const map = new Map();  // timeMs → text
            const re  = /\[(\d+):(\d+(?:\.\d+)?)\](.*)/;
            for (const line of raw.split('\n')) {
                const m = re.exec(line);
                if (m) {
                    const ms = parseInt(m[1], 10) * 60000 + parseFloat(m[2]) * 1000;
                    const text = m[3].trim();
                    if (text) map.set(Math.round(ms / 10) * 10, text);  // 10ms 精度对齐
                }
            }
            return map;
        }

        const jpMap = parseLrc(jpRaw);
        const cnMap = parseLrc(cnRaw);

        // ── 按时间排序，配对日文/中文 ──
        const allKeys = new Set([...jpMap.keys(), ...cnMap.keys()]);
        const sorted   = [...allKeys].sort((a, b) => a - b);

        const jpTexts = [];
        const entries  = [];
        for (const ms of sorted) {
            const jp = jpMap.get(ms) || '';
            const cn = cnMap.get(ms) || '';
            if (jp || cn) {
                entries.push({ ms, jp, cn });
                if (jp) jpTexts.push(jp);
            }
        }

        // ── 批量获取注音 ──
        const furiResults = getFurigana(jpTexts);

        // 过滤元数据行
        const metaPattern = /^(作词|作曲|编曲|制作人|混音|录音|母带|吉他|贝斯|鼓|键盘|钢琴|小提琴|和声|编程|Produced|Written|Composed|Arranged|Mixed|Recorded|Mastered|Guitar|Bass|Drums|Keyboard|Piano|Violin|Chorus)\s*[:：]/i;

        // ── 组装结果 ──
        let fi = 0;
        for (const e of entries) {
            if (e.jp) {
                // 跳过元数据行
                if (metaPattern.test(e.jp)) {
                    e.jp        = '';
                    e.jp_ruby   = '';
                    e.jp_plain  = '';
                    e.reading   = '';
                    e.annotated = '';
                    fi++;
                    continue;
                }
                e.jp_plain = stripFurigana(e.jp);
                e.jp_ruby  = parseInlineFurigana(e.jp);
                e.reading  = furiResults[fi] ? furiResults[fi].reading.replace(/\*/g, '') : '';
                e.annotated = '';  // 不再使用 annotated，用 jp_ruby 代替
                fi++;
            } else {
                e.jp_ruby   = '';
                e.jp_plain  = '';
                e.reading   = '';
            }
        }

        // 格式化时间
        function fmtMs(ms) {
            const m = Math.floor(ms / 60000);
            const s = ((ms % 60000) / 1000).toFixed(2);
            return `${String(m).padStart(2, '0')}:${String(s).padStart(5, '0')}`;
        }

        const lines = entries.map(e => ({
            time:      fmtMs(e.ms),
            jp:        e.jp,
            jp_ruby:   e.jp_ruby,
            jp_plain:  e.jp_plain,
            reading:   e.reading,
            cn:        e.cn,
        }));

        res.json({ code: 200, result: { lines } });
    } catch (e) {
        res.json({ code: 500, message: e.message });
    }
});

// ─── 页面 ──────────────────────────────────

app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`✓ 服务器启动成功: http://localhost:${PORT}`);
});