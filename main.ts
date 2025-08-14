/**
 * TikTok → Discord Webhook forwarder (TypeScript, Node 18+)
 *
 * - Checks every 30 minutes for new TikTok videos on one or more accounts
 * - Sends new posts as Discord embeds via a webhook
 * - Persists already-forwarded video IDs in a small JSON file
 *
 * Env vars:
 *   DISCORD_WEBHOOK_URL   (required) — Discord webhook
 *   TIKTOK_USERNAMES      (required) — Comma-separated usernames without @ (e.g. "nba,worldoftshirts")
 *   POLL_MINUTES          (optional) — Defaults to 30
 *   STATE_FILE            (optional) — Defaults to ./.state.json
 */

import {existsSync} from 'node:fs'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {chromium} from "playwright";

// ---- Config ----
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL?.trim()
if (!WEBHOOK) {
    console.error('ERROR: DISCORD_WEBHOOK_URL env var is required.')
    process.exit(1)
}

const USERNAMES = (process.env.TIKTOK_USERNAMES || '')
.split(',')
.map(s => s.trim())
.filter(Boolean)

if (USERNAMES.length === 0) {
    console.error('ERROR: TIKTOK_USERNAMES env var is required (comma-separated, no @).')
    process.exit(1)
}

const POLL_MINUTES = Number(process.env.POLL_MINUTES || 30)
const STATE_FILE = process.env.STATE_FILE || path.resolve('.state.json')

// ---- Minimal persisted state ----
// { [username]: string[] of video IDs }
interface State {
    [username: string]: string[]
}

let state: State = {}

async function loadState() {
    try {
        if (existsSync(STATE_FILE)) {
            const raw = await readFile(STATE_FILE, 'utf8')
            state = JSON.parse(raw)
        }
    } catch (err) {
        console.warn('WARN: Could not read state file, starting fresh.', err)
    }
}

async function saveState() {
    try {
        const dir = path.dirname(STATE_FILE)
        if (!existsSync(dir)) await mkdir(dir, {recursive: true})
        await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8')
    } catch (err) {
        console.warn('WARN: Could not save state file.', err)
    }
}

// ---- Types ----
export interface TikTokVideo {
    id: string
    author: string
    desc: string
    createTimeMs: number
    url: string
    cover?: string
}

async function fetchLatestForUser(username: string): Promise<TikTokVideo[]> {
    const browser = await chromium.launch({headless: true});
    const page = await browser.newPage();
    await page.goto(`https://www.tiktok.com/@${encodeURIComponent(username)}`, {
        waitUntil: 'networkidle',
    });

    const anchors = await page.$$("[id^='column-item-video-container-'] a[href]");
    const videos: TikTokVideo[] = [];

    for (const a of anchors) {
        const href = await a.getAttribute('href');
        if (!href) continue;

        const m = href.match(/\/video\/(\d+)/);
        if (!m) continue;

        const id = m[1];
        const url = href.startsWith('http') ? href : `https://www.tiktok.com${href}`;

        const img = await a.$('img');
        const desc = img ? (await img.getAttribute('alt'))?.trim() || '' : '';
        let cover = img ? await img.getAttribute('src') : undefined;
        if (!cover && img) {
            const srcset = await img.getAttribute('srcset');
            if (srcset) cover = srcset.split(',')[0]?.trim().split(' ')[0];
        }

        videos.push({
            id,
            author: username,
            desc,
            createTimeMs: Date.now(),
            url,
            cover
        });
    }

    await browser.close();

    // Newest→oldest, so reverse to send oldest first
    return videos.reverse();
}

// ---- Discord webhook ----
function stripControl(str: string): string {
    // remove all C0 control chars except \n \r \t
    return str.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function truncate(str: string, max: number): string {
    if (!str) return '';
    if (str.length <= max) return str;
    return str.slice(0, max - 1) + '…';
}

function safeUrl(u?: string): string | undefined {
    if (!u) return undefined;
    try {
        const url = new URL(u);
        if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
        return undefined;
    } catch {
        return undefined;
    }
}

function buildDiscordEmbed(video: TikTokVideo): any {
    // sanitize fields per Discord limits
    const title = truncate(stripControl(`@${video.author} posted a new TikTok`), 256);
    const description = truncate(stripControl(video.desc || ''), 4096);
    const footerText = truncate('TikTok → Discord', 2048);
    const url = safeUrl(video.url);

    const embed: any = {
        title,
        url,
        description: description || undefined, // omit if empty
        footer: {text: footerText},
    };

    const cover = safeUrl(video.cover);
    if (cover) embed.thumbnail = {url: cover};

    // Ensure we don’t accidentally send undefined keys
    Object.keys(embed).forEach((k) => {
        if (embed[k] == null) delete embed[k];
    });

    return embed;
}

async function sendDiscordEmbed(video: TikTokVideo) {
    const embed = buildDiscordEmbed(video);

    // Discord also imposes ~6000 chars total per embed; this is usually covered by our field truncations,
    // but if you add fields later, consider summing and trimming.
    const body = {embeds: [embed], allowed_mentions: {parse: []}};

    const res = await fetch(WEBHOOK!, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        let detail = await res.text().catch(() => '');
        // Try to parse Discord’s structured error so we can see the exact field
        try {
            const j = JSON.parse(detail);
            // j looks like: { message: "Invalid Form Body", errors: { embeds: { _errors: [...], "0": { description: { _errors: [...] } } } } }
            detail = JSON.stringify(j, null, 2);
        } catch {
        }
        throw new Error(`Discord webhook failed: ${res.status}\n${detail}\nEmbed sent:\n${JSON.stringify(
            body,
            null,
            2
        )}`);
    }
}

// ---- Core loop ----
async function runOnce() {
    for (const username of USERNAMES) {
        try {
            const known = new Set(state[username] || [])
            const videos = await fetchLatestForUser(username)

            const newOnes = videos.filter(v => !known.has(v.id))
            if (newOnes.length === 0) {
                console.log(`[${new Date().toISOString()}] @${username}: no new videos.`)
                continue
            }

            console.log(`[${new Date().toISOString()}] @${username}: ${newOnes.length} new video(s). Forwarding…`)
            for (const v of newOnes) {
                await sendDiscordEmbed(v)
                known.add(v.id)
                await delay(800)
            }

            state[username] = Array.from(known)
            await saveState()
        } catch (err: any) {
            console.error(`[${new Date().toISOString()}] ERROR for @${username}:`, err?.message || err)
        }
    }
}

async function main() {
    await loadState()
    await runOnce()

    const intervalMs = Math.max(1, POLL_MINUTES) * 60_000
    console.log(`Polling every ${POLL_MINUTES} minute(s)…`)

    setInterval(() => {
        runOnce().catch(err => console.error('Run error:', err))
    }, intervalMs)
}

process.on('SIGINT', async () => {
    console.log('Shutting down… saving state.')
    await saveState()
    process.exit(0)
})

main().catch(err => {
    console.error('Fatal error:', err)
    process.exit(1)
})
