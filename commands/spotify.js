const yts = require('yt-search');
const atlas = require('../lib/atlasApi');

function isSpotifyUrl(value) {
    return /^https?:\/\/open\.spotify\.com\//i.test(String(value || '').trim());
}

async function spotifyCommand(sock, chatId, message) {
    try {
        const rawText = message.message?.conversation?.trim() ||
            message.message?.extendedTextMessage?.text?.trim() ||
            message.message?.imageMessage?.caption?.trim() ||
            message.message?.videoMessage?.caption?.trim() ||
            '';

        const used = (rawText || '').split(/\s+/)[0] || '.spotify';
        const query = rawText.slice(used.length).trim();

        if (!query) {
            await sock.sendMessage(chatId, { text: 'Usage: .spotify <song/artist/keywords or Spotify link>\nExample: .spotify con calma' }, { quoted: message });
            return;
        }

        let track;

        if (isSpotifyUrl(query)) {
            // Atlas Spotify endpoint takes the track/album link directly
            track = await atlas.spotify(query);
        } else {
            // No search endpoint in the Atlas layer: find the track, then fetch its audio
            const search = await yts(query);
            const found = search?.videos?.[0];
            if (!found) {
                await sock.sendMessage(chatId, { text: 'No results found for that query.' }, { quoted: message });
                return;
            }
            const audio = await atlas.youtubeAudio(found.url);
            track = {
                download: audio.download,
                title: found.title || audio.title || query,
                artist: found.author?.name || '',
                duration: found.timestamp || '',
                thumbnail: found.thumbnail || audio.thumbnail || null
            };
        }

        if (!track?.download) {
            await sock.sendMessage(chatId, { text: 'No downloadable audio found for this query.' }, { quoted: message });
            return;
        }

        const caption = `🎵 ${track.title || 'Unknown Title'}\n👤 ${track.artist || ''}\n⏱ ${track.duration || ''}`.trim();

        if (track.thumbnail) {
            await sock.sendMessage(chatId, { image: { url: track.thumbnail }, caption }, { quoted: message });
        } else {
            await sock.sendMessage(chatId, { text: caption }, { quoted: message });
        }

        await sock.sendMessage(chatId, {
            audio: { url: track.download },
            mimetype: 'audio/mpeg',
            fileName: `${String(track.title || 'track').replace(/[\\/:*?"<>|]/g, '')}.mp3`
        }, { quoted: message });
    } catch (error) {
        console.error('[SPOTIFY] error:', error?.message || error);
        await sock.sendMessage(chatId, { text: 'Failed to fetch Spotify audio. Try another query later.' }, { quoted: message });
    }
}

module.exports = spotifyCommand;
