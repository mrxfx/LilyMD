const atlas = require('../lib/atlasApi');

async function gifCommand(sock, chatId, query) {
    if (!query) {
        await sock.sendMessage(chatId, { text: 'Please provide a search term for the GIF.' });
        return;
    }

    try {
        // Tenor, through the Atlas API layer
        const gifUrl = await atlas.tenorGif(query);

        if (gifUrl) {
            await sock.sendMessage(chatId, { video: { url: gifUrl }, caption: `Here is your GIF for "${query}"` });
        } else {
            await sock.sendMessage(chatId, { text: 'No GIFs found for your search term.' });
        }
    } catch (error) {
        console.error('Error fetching GIF:', error);
        await sock.sendMessage(chatId, { text: 'Failed to fetch GIF. Please try again later.' });
    }
}

module.exports = gifCommand;
