const atlas = require('../lib/atlasApi');
const settings = require('../settings');
const { channelInfo } = require('../lib/messageConfig');

// Universal downloader, ported from Atlas-MD's `-dl` plugin: one command, any
// supported link. Every request goes through the Atlas API layer.
const PLATFORMS = [
    { type: 'tiktok', label: 'TikTok', test: /^https?:\/\/(?:www\.)?(?:vm\.|vt\.|m\.)?tiktok\.com\//i },
    { type: 'instagram', label: 'Instagram', test: /^https?:\/\/(?:www\.)?(?:instagram\.com|instagr\.am)\//i },
    { type: 'pinterest', label: 'Pinterest', test: /^https?:\/\/(?:www\.)?(?:pinterest\.[a-z.]+|pin\.it)\//i },
    { type: 'facebook', label: 'Facebook', test: /^https?:\/\/(?:www\.|m\.|web\.)?(?:facebook\.com|fb\.watch)\//i },
    { type: 'twitter', label: 'Twitter/X', test: /^https?:\/\/(?:www\.|mobile\.)?(?:twitter\.com|x\.com)\//i },
    { type: 'threads', label: 'Threads', test: /^https?:\/\/(?:www\.)?threads\.(?:net|com)\//i },
    { type: 'videy', label: 'Videy', test: /^https?:\/\/(?:www\.)?videy\.co\//i },
    { type: 'mega', label: 'Mega', test: /^https?:\/\/mega\.nz\//i },
    { type: 'soundcloud', label: 'SoundCloud', test: /^https?:\/\/(?:www\.|on\.)?soundcloud\.com\//i },
    { type: 'spotify', label: 'Spotify', test: /^https?:\/\/open\.spotify\.com\//i },
    { type: 'youtube', label: 'YouTube', test: /^https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)/i },
    { type: 'sfile', label: 'Sfile', test: /^https?:\/\/sfile\.co\//i },
    { type: 'mediafire', label: 'MediaFire', test: /^https?:\/\/www\.mediafire\.com\//i }
];

function detect(url) {
    return PLATFORMS.find((platform) => platform.test.test(url)) || null;
}

function extractUrl(text) {
    const match = String(text || '').match(/https?:\/\/[^\s]+/i);
    return match ? match[0].replace(/[)\]>,.]+$/g, '') : '';
}

function captionFor(label, title) {
    const bot = (settings.botName || 'Lily MD').toUpperCase();
    return title ? `*DOWNLOADED BY ${bot}*\n\n📝 ${title}\n🔗 ${label}` : `*DOWNLOADED BY ${bot}*\n\n🔗 ${label}`;
}

async function sendVideo(sock, chatId, message, url, caption) {
    await sock.sendMessage(chatId, { video: { url }, mimetype: 'video/mp4', caption }, { quoted: message });
}

async function sendImage(sock, chatId, message, url, caption) {
    await sock.sendMessage(chatId, { image: { url }, caption }, { quoted: message });
}

async function sendAudio(sock, chatId, message, url, title) {
    await sock.sendMessage(chatId, {
        audio: { url },
        mimetype: 'audio/mpeg',
        fileName: `${String(title || 'audio').replace(/[\\/:*?"<>|]/g, '').slice(0, 60)}.mp3`
    }, { quoted: message });
}

async function sendDocument(sock, chatId, message, file, caption) {
    await sock.sendMessage(chatId, {
        document: { url: file.download },
        fileName: file.filename || 'download',
        mimetype: file.mimetype ? `application/${String(file.mimetype).toLowerCase()}` : 'application/octet-stream',
        caption
    }, { quoted: message });
}

async function downloadCommand(sock, chatId, message) {
    const text =
        message.message?.conversation || message.message?.extendedTextMessage?.text || '';
    const url = extractUrl(text);

    if (!url) {
        return sock.sendMessage(chatId, {
            text: `*Universal Downloader*\n\nTikTok • Instagram • Pinterest • Facebook\nTwitter/X • Threads • Videy • Mega\nSoundCloud • Spotify • YouTube • Sfile • MediaFire\n\n*Usage:* .dl <link>\n*Tip:* replying to a link works too.`,
            ...channelInfo
        }, { quoted: message });
    }

    const platform = detect(url);
    if (!platform) {
        return sock.sendMessage(chatId, {
            text: '❌ Unsupported link. See `.dl` for the platforms this supports.',
            ...channelInfo
        }, { quoted: message });
    }

    await sock.sendMessage(chatId, { react: { text: '📥', key: message.key } });
    const caption = captionFor(platform.label, null);

    try {
        switch (platform.type) {
            case 'tiktok': {
                const post = await atlas.tiktok(url);
                if (post.images?.length) {
                    for (const image of post.images.slice(0, 10)) {
                        await sendImage(sock, chatId, message, image, captionFor(platform.label, post.title));
                    }
                } else if (post.download) {
                    await sendVideo(sock, chatId, message, post.download, captionFor(platform.label, post.title));
                } else {
                    throw new Error('No media found in this post');
                }
                break;
            }

            case 'instagram': {
                const { media } = await atlas.instagram(url);
                for (const item of media.slice(0, 10)) {
                    if (item.type === 'video') await sendVideo(sock, chatId, message, item.url, caption);
                    else await sendImage(sock, chatId, message, item.url, caption);
                }
                break;
            }

            case 'pinterest': {
                const media = await atlas.pinterest(url);
                for (const item of media.slice(0, 10)) {
                    if (item.type === 'video' || item.type === 'gif') {
                        await sendVideo(sock, chatId, message, item.url, caption);
                    } else {
                        await sendImage(sock, chatId, message, item.url, caption);
                    }
                }
                break;
            }

            case 'facebook': {
                const media = await atlas.facebook(url);
                if (!media.download) throw new Error('No downloadable media in this post');
                if (media.photo) await sendImage(sock, chatId, message, media.photo, captionFor(platform.label, media.title));
                else await sendVideo(sock, chatId, message, media.download, captionFor(platform.label, media.title));
                break;
            }

            case 'twitter': {
                const media = await atlas.twitter(url);
                if (media.videos.length) {
                    await sendVideo(sock, chatId, message, media.videos[0].url, captionFor(platform.label, media.videos[0].quality));
                } else if (media.images.length) {
                    for (const image of media.images.slice(0, 4)) {
                        await sendImage(sock, chatId, message, image.url, caption);
                    }
                } else if (media.thumbnail) {
                    await sendImage(sock, chatId, message, media.thumbnail, caption);
                } else {
                    throw new Error('No downloadable media in this post');
                }
                break;
            }

            case 'threads': {
                const media = await atlas.threads(url);
                for (const item of media.slice(0, 4)) {
                    if (/\.(mp4|mov|webm)/i.test(item.url)) await sendVideo(sock, chatId, message, item.url, caption);
                    else await sendImage(sock, chatId, message, item.url, caption);
                }
                break;
            }

            case 'videy': {
                const videoUrl = await atlas.videy(url);
                await sendVideo(sock, chatId, message, videoUrl, caption);
                break;
            }

            case 'mega': {
                const file = await atlas.mega(url);
                await sendDocument(sock, chatId, message, file, captionFor(platform.label, file.filename));
                break;
            }

            case 'soundcloud': {
                const track = await atlas.soundcloud(url);
                await sendAudio(sock, chatId, message, track.download, track.title);
                break;
            }

            case 'spotify': {
                const track = await atlas.spotify(url);
                await sendAudio(sock, chatId, message, track.download, track.title);
                break;
            }

            case 'youtube': {
                const track = await atlas.youtubeAudio(url);
                await sendAudio(sock, chatId, message, track.download, track.title);
                break;
            }

            case 'sfile': {
                const file = await atlas.sfile(url);
                await sendDocument(sock, chatId, message, file, captionFor(platform.label, file.filename));
                break;
            }

            case 'mediafire': {
                const file = await atlas.mediafire(url);
                await sendDocument(sock, chatId, message, file, captionFor(platform.label, file.filename));
                break;
            }

            default:
                throw new Error('Unsupported platform');
        }

        await sock.sendMessage(chatId, { react: { text: '✅', key: message.key } });
    } catch (err) {
        console.error('[download]', platform.type, err?.message || err);
        await sock.sendMessage(chatId, { react: { text: '❌', key: message.key } });
        await sock.sendMessage(chatId, {
            text: `❌ Could not download from ${platform.label}. ${err?.message ? `\n\n_${err.message}_` : 'Try another link.'}`,
            ...channelInfo
        }, { quoted: message });
    }
}

module.exports = downloadCommand;
module.exports.detect = detect;
module.exports.PLATFORMS = PLATFORMS;
